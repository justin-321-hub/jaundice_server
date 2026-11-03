// 實習生語音助理：APP ⇄ (WebSocket) ⇄ 本服務 ⇄ (Live API) ⇄ Gemini
//
// 端點：wss://<host>/ws/intern-live
//
// 【APP → 伺服器】（皆為 JSON 文字訊息）
//   {"type":"auth","token":"<Firebase ID Token>"}   連線後第一則，10 秒內必須送出
//   {"type":"audio","data":"<base64 PCM16 mono 16kHz>"}  收到 ready 之後才會被處理
//   {"type":"end"}                                   主動結束通話
//
// 【伺服器 → APP】
//   {"type":"ready","maxSeconds":600}
//   {"type":"audio","data":"<base64>","mimeType":"audio/pcm;rate=24000"}
//   {"type":"transcript","role":"user"|"assistant","text":"..."}   逐字稿「增量」，APP 依 role 累加
//   {"type":"interrupted"}                           使用者打斷，APP 應清空播放佇列
//   {"type":"turn_complete"}                         一輪結束，APP 可封存目前的文字泡泡
//   {"type":"error","code":"...","message":"..."}    之後伺服器會關閉連線
//
// 【WebSocket 關閉碼】
//   4001 驗證失敗  4003 非啟用中的 intern  4008 驗證逾時／閒置逾時
//   4009 達單次時長上限  4011 同帳號被新連線取代
//   1011 伺服器／上游錯誤  1012 伺服器重啟  1013 目前人數已滿
//
// 安全設計：
//   * 身分一律取自驗證後的 Firebase token（含撤銷檢查）→ users/{uid}.role === 'intern'
//     且 isActive !== false（與 APP 端判斷一致），不採信任何前端傳來的 ID
//   * 驗證通過「之後」才建立對話紀錄與 Gemini session，避免未授權流量耗用額度
//   * 同帳號只保留一條連線；全站同時通話數、單次時長、閒置時間、音訊速率皆有上限
//   * 對話紀錄寫入失敗連續 3 次就結束通話（寧可中斷也不要無紀錄地繼續）
//   * log 只記狀態與長度，不記對話內容
const { randomUUID } = require('crypto');
const { WebSocketServer } = require('ws');
const { GoogleGenAI, Modality, Type } = require('@google/genai');
const store = require('./conversationStore');
const { searchKnowledgeBase } = require('./ragService');
const prompt = require('./prompt');

const WS_PATH = '/ws/intern-live';
const AUTH_TIMEOUT_MS = 10_000;
const MAX_PENDING_AUTH = 20;
const MAX_PAYLOAD_BYTES = 256 * 1024;
const MAX_AUDIO_B64_CHARS = 64 * 1024; // 約 1.4 秒的 16kHz PCM16
const AUDIO_MIME = 'audio/pcm;rate=16000'; // 固定值，不採用前端傳來的 mimeType
// 約即時速率的 1.5 倍（16kHz PCM16 base64 ≈ 43k 字元/秒），避免有人用遠快於即時的速度灌音訊
const AUDIO_RATE_CHARS_PER_SEC = 64 * 1024;
const AUDIO_BURST_CHARS = 256 * 1024; // 約 6 秒的緩衝，容許網路抖動後的補送
const MAX_CLIENT_BUFFERED_BYTES = 2 * 1024 * 1024; // 往 APP 的送出佇列上限，超過視為連線太慢
// 往 Gemini 的送出佇列上限。SDK 沒有公開 API，這裡讀的是 session.conn.ws.bufferedAmount
// （SDK 內部欄位）；讀不到時不會出錯，只是退回僅靠上面的速率限制。
const MAX_UPSTREAM_BUFFERED_BYTES = 2 * 1024 * 1024;
const STARTUP_TIMEOUT_MS = 20_000; // 驗證通過後，到 ready 為止的整體期限
const CONNECT_PENDING_WARN_MS = 60_000; // connect() 卡這麼久就記警告（名額不會因此釋放）
const TURN_FLUSH_GRACE_MS = 800; // 一輪結束後，等這麼久才存檔，讓延遲到達的使用者逐字稿歸回該輪
const MAX_PERSIST_FAILURES = 3;
const MAX_PERSIST_QUEUE = 20; // 待寫入的對話紀錄上限，超過代表資料庫停滯
const HEARTBEAT_MS = 30_000;
const SHUTDOWN_WAIT_MS = 15_000; // Render 停機窗口預設 30 秒，server.js 另有 25 秒的強制退出

const REQUIRED_ENV = [
  'GEMINI_API_KEY',
  'GEMINI_LIVE_MODEL',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'OPENAI_API_KEY',
];

function intEnv(name, fallback) {
  const n = parseInt(process.env[name], 10);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function limits() {
  return {
    maxSessionMs: intEnv('INTERN_LIVE_MAX_SESSION_MS', 10 * 60_000),
    idleMs: intEnv('INTERN_LIVE_IDLE_MS', 120_000),
    maxConcurrent: intEnv('INTERN_LIVE_MAX_CONCURRENT', 5),
    startupMs: intEnv('INTERN_LIVE_STARTUP_MS', STARTUP_TIMEOUT_MS),
    turnGraceMs: intEnv('INTERN_LIVE_TURN_GRACE_MS', TURN_FLUSH_GRACE_MS),
  };
}

class AuthError extends Error {
  constructor(wsCode, reason, userMessage) {
    super(reason);
    this.wsCode = wsCode;
    this.reason = reason; // 簡短 ASCII，放進 WebSocket close frame（上限 123 bytes）
    this.userMessage = userMessage;
  }
}

function safeSend(ws, obj) {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(obj));
}

function rejectSocket(ws, wsCode, code, message) {
  safeSend(ws, { type: 'error', code, message });
  try {
    ws.close(wsCode, code);
  } catch (_) {
    /* ignore */
  }
}

class LiveSession {
  constructor(ctx, ws, uid) {
    this.ctx = ctx;
    this.ws = ws;
    this.uid = uid;
    this.conversationId = null;
    this.gemini = null;
    this.ready = false;
    this.closed = false;
    this.endReason = null;
    this.closePromise = null;
    this.userBuf = '';
    this.asstBuf = '';
    this.sources = [];
    this.persistChain = Promise.resolve();
    this.persistFailures = 0;
    this.persistPending = 0;
    this.pendingCalls = new Map(); // tool call id -> { cancelled }
    this.audioBudget = AUDIO_BURST_CHARS;
    this.audioBudgetAt = Date.now();
    this.startPromise = null;
    this.closedSignal = new Promise((resolve) => {
      this.signalClosed = resolve;
    });
    // 上游名額：驗證通過時（同步）預留，直到「已關閉且 Gemini connect() 已收斂」才釋放
    this.slotHeld = false;
    this.connectPending = false;
    // 一輪結束後延遲存檔（見 TURN_FLUSH_GRACE_MS）。結束的那一輪會「整組快照」成 pendingTurn
    // { user, assistant, sources, expectLate }，目前進行中的下一輪從乾淨的緩衝開始，
    // 兩者不共用文字或來源，所以寬限期內的下一輪不會污染上一輪。
    this.pendingTurn = null;
    this.turnTimer = null;
    this.turnUserSeen = false; // 目前這一輪是否已經收到過使用者逐字稿
    this.startTimer = null;
    this.maxTimer = null;
    this.idleTimer = null;
    ctx.all.add(this); // 直到收尾（含 ended_at 寫入）完成才移除，shutdown 才知道要等誰
  }

  send(obj) {
    if (this.ws.readyState !== this.ws.OPEN) return;
    if (this.ws.bufferedAmount > MAX_CLIENT_BUFFERED_BYTES) {
      // 下游消化不了：不再累積記憶體，直接結束（緩衝已滿，不送錯誤訊息）
      if (!this.closed) this.close('client_too_slow', 1008);
      return;
    }
    this.ws.send(JSON.stringify(obj));
  }

  start() {
    this.startPromise = this.doStart();
    return this.startPromise;
  }

  // 注意：這裡呼叫 this.fail() 一律不 await/return 它。close() 的收尾會等 startPromise，
  // 若 doStart 反過來等 close 就會互相等待而卡死。
  async doStart() {
    this.startTimer = setTimeout(
      () => this.fail('startup_timeout', 1011, '語音服務啟動逾時，請稍後再試'),
      limits().startupMs
    );

    const missing = REQUIRED_ENV.filter((k) => !process.env[k]);
    if (missing.length) {
      console.error('[intern-live] missing env:', missing.join(','));
      this.fail('server_misconfigured', 1011, '伺服器設定不完整，請聯絡管理員');
      return;
    }
    const model = process.env.GEMINI_LIVE_MODEL;

    // 由後端先產生對話 ID 再寫入：即使 INSERT 已提交但回應逾時（結果不確定），
    // 收尾時仍知道要對哪個 ID 補寫 ended_at，不會留下永遠沒結束時間的對話。
    this.conversationId = randomUUID();
    try {
      await store.createConversation({ id: this.conversationId, uid: this.uid, model });
    } catch (err) {
      console.error('[intern-live] create conversation failed:', err.message);
      this.fail('log_unavailable', 1011, '對話紀錄服務暫時無法使用，請稍後再試');
      return;
    }
    // 若期間已被關閉：conversationId 已設定，close() 的收尾會等到這裡結束後補寫 ended_at
    if (this.closed) return;

    // SDK 的 connect() 無法取消，也可能永遠不回來。所以讓這一步可以被 close() 打斷：
    // 一旦 session 被關閉（逾時、被取代、使用者離開…），start() 就不再等它，
    // 否則 close() 的完整收尾（等 start() 結束）會跟著永遠卡住。
    // 被放棄的連線若之後才成功，再把它關掉；在那之前名額仍被佔用（見 releaseSlotIfDone）。
    const connecting = this.connectGemini(model);
    const outcome = await Promise.race([
      connecting.then(
        (session) => ({ session }),
        (error) => ({ error })
      ),
      this.closedSignal.then(() => ({ aborted: true })),
    ]);
    if (outcome.aborted) {
      connecting.then(
        (session) => {
          try {
            session.close();
          } catch (_) {
            /* ignore */
          }
        },
        () => {}
      );
      return;
    }
    if (outcome.error) {
      console.error('[intern-live] gemini connect failed:', outcome.error?.message);
      this.fail('gemini_connect_failed', 1011, '語音服務連線失敗，請稍後再試');
      return;
    }
    this.gemini = outcome.session;
    if (this.closed) {
      // 連線成功的同一瞬間 session 剛好被關閉：close() 當時還沒有 gemini 可關
      try {
        this.gemini.close();
      } catch (_) {
        /* ignore */
      }
      return;
    }

    clearTimeout(this.startTimer);
    const { maxSessionMs } = limits();
    this.maxTimer = setTimeout(
      () => this.fail('max_duration', 4009, '已達單次通話時間上限，請重新開始'),
      maxSessionMs
    );
    this.touchIdle();
    this.ready = true;
    this.send({ type: 'ready', maxSeconds: Math.floor(maxSessionMs / 1000) });
    console.log(`[intern-live] session ready uid=${this.uid.slice(0, 6)}… active=${this.ctx.sessions.size}`);
  }

  connectGemini(model) {
    const voice = process.env.INTERN_LIVE_VOICE || 'Zephyr';
    // thinkingLevel 是 3.1 Live 才有的設定；新模型若不支援可把環境變數設成 off 關閉
    const thinking = (process.env.INTERN_LIVE_THINKING_LEVEL || 'minimal').trim();

    const config = {
      responseModalities: [Modality.AUDIO],
      systemInstruction: prompt.INTERN_SYSTEM_PROMPT,
      speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } },
      // 開啟轉錄：畫面下方的即時文字與 Supabase 對話紀錄都靠這兩項
      inputAudioTranscription: {},
      outputAudioTranscription: {},
      realtimeInputConfig: {
        automaticActivityDetection: {
          silenceDurationMs: 650,
          startOfSpeechSensitivity: 'START_SENSITIVITY_LOW',
        },
      },
      tools: [
        {
          functionDeclarations: [
            {
              name: 'search_knowledge_base',
              description: prompt.SEARCH_TOOL_DESCRIPTION,
              parameters: {
                type: Type.OBJECT,
                properties: {
                  query: { type: Type.STRING, description: prompt.SEARCH_TOOL_QUERY_DESCRIPTION },
                },
                required: ['query'],
              },
            },
          ],
        },
      ],
    };
    if (thinking && thinking.toLowerCase() !== 'off') {
      config.thinkingConfig = { thinkingLevel: thinking.toUpperCase() };
    }

    const connecting = this.ctx.getAI().live.connect({
      model,
      config,
      callbacks: {
        onopen: () => console.log('[intern-live] gemini session opened'),
        onmessage: (message) => this.onGeminiMessage(message),
        onerror: (event) =>
          console.error('[intern-live] gemini error:', event?.code, event?.message || ''),
        onclose: (event) => {
          console.log(`[intern-live] gemini closed code=${event?.code} reason=${event?.reason || ''}`);
          if (!this.closed) {
            this.send({ type: 'error', code: 'gemini_closed', message: '語音連線已中斷，請重新開始' });
            this.close('gemini_closed', 1011);
          }
        },
      },
    });
    // SDK 的 connect() 無法取消：即使 session 已被取代／逾時關閉，這條連線仍會在背景跑到結束。
    // 所以名額（見 reserveSlot）要等 connect() 真的收斂才釋放。逾時「不等於」資源已釋放，
    // 因此不做時間到就放行的保底，只在卡太久時記警告，讓維運人員知道需要重啟。
    this.connectPending = true;
    const warnTimer = setTimeout(() => {
      if (this.connectPending) {
        console.warn(
          `[intern-live] gemini connect() still pending after ${CONNECT_PENDING_WARN_MS}ms; ` +
            `upstream slots in use=${this.ctx.upstream}`
        );
      }
    }, CONNECT_PENDING_WARN_MS);
    warnTimer.unref?.();
    const settled = () => {
      clearTimeout(warnTimer);
      this.connectPending = false;
      this.releaseSlotIfDone();
    };
    connecting.then(settled, settled);
    return connecting;
  }

  // 名額在驗證通過後、同步區段內預留（attachInternLive 的 admission），涵蓋整個啟動期間
  // （等資料庫、等 Gemini 都算），避免多條連線同時通過檢查後一起超額。
  reserveSlot() {
    this.slotHeld = true;
    this.ctx.upstream += 1;
  }

  // 只有「session 已關閉」且「Gemini connect() 已收斂（或從未發出）」才釋放名額
  releaseSlotIfDone() {
    if (this.slotHeld && this.closed && !this.connectPending) {
      this.slotHeld = false;
      this.ctx.upstream -= 1;
    }
  }

  onGeminiMessage(message) {
    if (this.closed) return;

    const sc = message.serverContent;
    if (sc) {
      const parts = sc.modelTurn?.parts;
      if (parts) {
        for (const part of parts) {
          if (part.inlineData?.data) {
            this.touchIdle();
            this.send({
              type: 'audio',
              data: part.inlineData.data,
              mimeType: part.inlineData.mimeType,
            });
          }
        }
      }

      // Live API 不保證 input transcription 與 model turn 的先後順序，所以不能用
      // 「輸出文字開始了」當作使用者講完的訊號（會把一句話拆成多筆、或在交錯時錯序）。
      // 存檔時機（一律先存使用者、再存助理，且一律先存「已結束的上一輪」）：
      //   * transcription 自帶 finished
      //   * 一輪結束：把這一輪整組快照成 pendingTurn，延遲 TURN_FLUSH_GRACE_MS 再存，
      //     讓晚到的使用者逐字稿歸回該輪（下一輪用乾淨的緩衝，不會互相污染）
      //   * 被打斷、通話結束
      //
      // 已知限制：逐字稿沒有回合 ID 或時間戳，若使用者逐字稿比寬限時間更晚到，
      // 會被歸到下一輪（順序錯位）。這是協定本身的限制，這裡只能降低機率。
      const inTr = sc.inputTranscription;
      if (inTr?.text) {
        this.touchIdle();
        if (this.pendingTurn?.expectLate) {
          // 上一輪結束時還沒收到任何使用者逐字稿 → 這段是上一輪晚到的，直到 finished 為止
          this.pendingTurn.user += inTr.text;
        } else {
          this.userBuf += inTr.text;
          this.turnUserSeen = true;
        }
        this.send({ type: 'transcript', role: 'user', text: inTr.text });
      }
      if (inTr?.finished) {
        if (this.pendingTurn?.expectLate) {
          // 上一輪晚到的使用者逐字稿結束了：這一輪可以完整存檔，之後的輸入屬於下一輪
          this.pendingTurn.expectLate = false;
          this.flushPendingTurn();
        } else {
          this.flushUser();
        }
      }

      const outText = sc.outputTranscription?.text;
      if (outText) {
        this.touchIdle();
        // 上一輪已結束、新一輪的回答開始了：上一輪不必再等，先存檔
        if (this.pendingTurn) this.flushPendingTurn();
        this.asstBuf += outText;
        this.send({ type: 'transcript', role: 'assistant', text: outText });
      }

      if (sc.interrupted) {
        this.cancelAllCalls(); // 被打斷後，尚未回傳的查詢結果不該再被採用
        this.send({ type: 'interrupted' });
        this.flushUser(); // 內部會先存上一輪（完整結束的，不標記為被打斷）
        this.flushAssistant(true);
      }

      if (sc.turnComplete) {
        this.send({ type: 'turn_complete' });
        if (this.pendingTurn) this.flushPendingTurn();
        // 沒有助理文字的 turnComplete（例如被打斷後緊接而來的那個）不是使用者那句話的邊界，
        // 不建立待存回合，也不動使用者緩衝（那可能是下一輪使用者正在講的話）
        if (this.asstBuf.trim()) {
          this.pendingTurn = {
            user: this.userBuf,
            assistant: this.asstBuf,
            sources: this.sources,
            expectLate: !this.turnUserSeen,
          };
          this.userBuf = '';
          this.asstBuf = '';
          this.sources = [];
          this.turnUserSeen = false;
          this.turnTimer = setTimeout(() => this.flushPendingTurn(), limits().turnGraceMs);
        }
      }
    }

    if (message.toolCallCancellation?.ids) {
      for (const id of message.toolCallCancellation.ids) {
        const state = this.pendingCalls.get(id);
        if (state) state.cancelled = true;
      }
    }

    if (message.toolCall?.functionCalls) {
      this.handleToolCalls(message.toolCall.functionCalls);
    }
  }

  cancelAllCalls() {
    for (const state of this.pendingCalls.values()) state.cancelled = true;
  }

  handleToolCalls(calls) {
    for (const call of calls) {
      if (call.name === 'search_knowledge_base') {
        this.pendingCalls.set(call.id, { cancelled: false });
        this.runSearch(call);
      } else {
        this.respondTool(call, { error: 'unsupported tool' });
      }
    }
  }

  respondTool(call, output) {
    if (this.closed || !this.gemini) return;
    try {
      this.gemini.sendToolResponse({
        functionResponses: [{ id: call.id, name: call.name, response: { output } }],
      });
    } catch (err) {
      console.error('[intern-live] sendToolResponse failed:', err?.message);
    }
  }

  // RAG 查詢是伺服器內部行為：不轉給 APP，查完再回給 Gemini（不可同步等待，會卡住 onmessage）
  async runSearch(call) {
    const query = typeof call.args?.query === 'string' ? call.args.query : '';
    this.touchIdle();
    const res = await searchKnowledgeBase(query); // 永不 throw
    const state = this.pendingCalls.get(call.id);
    this.pendingCalls.delete(call.id);
    // 已被取消（模型取消或使用者打斷）的查詢：不回傳結果，來源也不計入後續回覆
    if (this.closed || state?.cancelled) return;

    for (const s of res.sources) {
      if (!this.sources.some((x) => x.id === s.id)) this.sources.push(s);
    }
    console.log(`[intern-live] rag status=${res.status} hits=${res.sources.length} queryLen=${query.length}`);

    let result;
    if (res.status === 'ok') {
      result =
        `以下是黃疸護理衛教指引中與「${query}」相關的內容。請只依據這些內容回答，並說明依據的章節：\n\n` +
        res.context;
    } else if (res.status === 'empty') {
      result =
        `指引中查無與「${query}」直接相關的記載。請明確告訴使用者目前查不到，` +
        '建議詢問資深護理師或查閱最新的院內規範，不要編造數值或標準。';
    } else {
      result =
        '指引資料庫暫時無法查詢。請告訴使用者目前無法查詢指引，建議稍後再試或詢問資深護理師，' +
        '不要憑記憶提供具體的數值或標準。';
    }
    this.respondTool(call, { result });
  }

  // —— 對話紀錄 ——
  // 把「已結束但還在寬限期」的一輪立刻存檔（先使用者、後助理）。
  // 目前這一輪的 flushUser / flushAssistant 一律會先呼叫它，確保寫入順序是時間順序。
  flushPendingTurn() {
    const turn = this.pendingTurn;
    if (!turn) return;
    clearTimeout(this.turnTimer);
    this.turnTimer = null;
    this.pendingTurn = null;
    const user = turn.user.trim();
    const assistant = turn.assistant.trim();
    if (user) this.enqueueMessage('user', user, false, []);
    if (assistant) this.enqueueMessage('assistant', assistant, false, turn.sources);
  }

  flushUser() {
    this.flushPendingTurn();
    const text = this.userBuf.trim();
    this.userBuf = '';
    if (text) this.enqueueMessage('user', text, false, []);
  }

  flushAssistant(interrupted) {
    this.flushPendingTurn();
    const text = this.asstBuf.trim();
    this.asstBuf = '';
    const sources = this.sources;
    this.sources = [];
    this.turnUserSeen = false; // 這一輪結束，下一輪重新計
    if (text) this.enqueueMessage('assistant', text, interrupted, sources);
  }

  enqueueMessage(role, content, interrupted, sources) {
    const job = () =>
      store.addMessage({
        conversationId: this.conversationId,
        uid: this.uid,
        role,
        content,
        interrupted,
        sources,
      });
    // 以序列串接，確保寫入順序與對話順序一致；這條 chain 本身永不 reject。
    // 每筆寫入有逾時（見 conversationStore），資料庫停滯時會以「失敗」計入，不會無限卡住。
    this.persistPending += 1;
    this.persistChain = this.persistChain.then(job).then(
      () => {
        this.persistPending -= 1;
        this.persistFailures = 0;
      },
      (err) => {
        this.persistPending -= 1;
        this.persistFailures += 1;
        console.error('[intern-live] save message failed:', err.message);
        if (this.persistFailures >= MAX_PERSIST_FAILURES && !this.closed) {
          this.fail('log_unavailable', 1011, '對話紀錄服務異常，通話已結束');
        }
      }
    );
    if (this.persistPending > MAX_PERSIST_QUEUE && !this.closed) {
      this.fail('log_unavailable', 1011, '對話紀錄服務異常，通話已結束');
    }
  }

  // —— APP 端訊息 ——
  handleClientMessage(msg) {
    if (!this.ready || this.closed) return;

    if (msg.type === 'audio') {
      const data = msg.data;
      if (typeof data !== 'string' || data.length === 0 || data.length > MAX_AUDIO_B64_CHARS) return;
      if (!this.takeAudioBudget(data.length)) return; // 超過速率上限（遠快於即時）就丟棄
      // 上游若停止消化資料，送出佇列會一直累積：超過上限就結束通話（讀不到欄位時略過）
      const buffered = this.gemini.conn?.ws?.bufferedAmount;
      if (typeof buffered === 'number' && buffered > MAX_UPSTREAM_BUFFERED_BYTES) {
        this.fail('upstream_stalled', 1011, '語音服務暫時無法回應，通話已結束');
        return;
      }
      try {
        this.gemini.sendRealtimeInput({ audio: { data, mimeType: AUDIO_MIME } });
      } catch (err) {
        console.error('[intern-live] sendRealtimeInput failed:', err?.message);
      }
    } else if (msg.type === 'end') {
      this.close('client_ended', 1000);
    }
  }

  takeAudioBudget(chars) {
    const now = Date.now();
    this.audioBudget = Math.min(
      AUDIO_BURST_CHARS,
      this.audioBudget + ((now - this.audioBudgetAt) / 1000) * AUDIO_RATE_CHARS_PER_SEC
    );
    this.audioBudgetAt = now;
    if (this.audioBudget < chars) return false;
    this.audioBudget -= chars;
    return true;
  }

  // —— 生命週期 ——
  touchIdle() {
    if (this.closed) return;
    clearTimeout(this.idleTimer);
    this.idleTimer = setTimeout(
      () => this.fail('idle_timeout', 4008, '長時間沒有對話，已自動結束通話'),
      limits().idleMs
    );
  }

  fail(code, wsCode, userMessage) {
    this.send({ type: 'error', code, message: userMessage });
    return this.close(code, wsCode);
  }

  close(reason, wsCode = 1000) {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.endReason = reason;
    this.signalClosed(); // 打斷 doStart() 正在等的 Gemini connect
    clearTimeout(this.startTimer);
    clearTimeout(this.maxTimer);
    clearTimeout(this.idleTimer);
    clearTimeout(this.turnTimer);
    this.cancelAllCalls();
    // 從「進行中」名單移除（讓同帳號可立刻重連）；但仍留在 ctx.all，直到收尾完成
    if (this.ctx.sessions.get(this.uid) === this) this.ctx.sessions.delete(this.uid);
    // 上游名額：若 Gemini connect() 已收斂就立刻釋放；仍卡住的則等它收斂（見 releaseSlotIfDone）
    this.releaseSlotIfDone();

    try {
      this.gemini?.close();
    } catch (_) {
      /* ignore */
    }

    // 寬限期內的上一輪是完整結束的（flushUser 會先把它存掉）；
    // 目前這一輪被截斷的回答標記為 interrupted，保留已產生的部分
    this.flushUser();
    this.flushAssistant(true);

    try {
      if (this.ws.readyState === this.ws.OPEN || this.ws.readyState === this.ws.CONNECTING) {
        this.ws.close(wsCode, reason);
      }
    } catch (_) {
      /* ignore */
    }

    if (reason === 'client_too_slow') this.ws.terminate(); // 緩衝已滿，closing handshake 送不出去

    console.log(`[intern-live] session closed uid=${this.uid.slice(0, 6)}… reason=${reason}`);

    // 完整收尾 = 等 start() 走完（它可能還在建立對話紀錄／連 Gemini）→ 等所有待寫入訊息 →
    // 寫 ended_at。conversationId 要在 start() 結束「之後」才讀，否則會漏寫 ended_at。
    // 這條 chain 永不 reject，shutdown 才能放心等它。
    const started = this.startPromise || Promise.resolve();
    this.closePromise = started
      .catch(() => {})
      .then(() => this.persistChain)
      .then(() =>
        this.conversationId ? store.endConversation(this.conversationId, reason) : undefined
      )
      .catch((e) => console.error('[intern-live] end conversation failed:', e.message))
      .finally(() => this.ctx.all.delete(this));
    return this.closePromise;
  }
}

/**
 * 掛載實習生語音 WebSocket。
 * @param {import('http').Server} httpServer  app.listen() 回傳的 server
 * @param {{ admin: import('firebase-admin'), getUserDoc: (uid: string) => Promise<object|null> }} deps
 * @returns {{ shutdown: () => Promise<void> }}
 */
function attachInternLive(httpServer, { admin, getUserDoc }) {
  const wss = new WebSocketServer({
    server: httpServer,
    path: WS_PATH,
    maxPayload: MAX_PAYLOAD_BYTES,
  });

  let ai = null;
  const ctx = {
    sessions: new Map(), // uid -> LiveSession（進行中，含啟動中的；關閉即移除）
    all: new Set(), // 所有尚未「完整收尾」的 LiveSession（含已關閉但還在寫紀錄的）
    // 上游名額：驗證通過即預留，直到 session 關閉且其 Gemini connect() 收斂才釋放。
    // 包含「已被取代／逾時、但 connect() 仍卡在背景」的 session，所以不會被重連洗掉上限。
    upstream: 0,
    shuttingDown: false,
    getAI() {
      if (!ai) ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
      return ai;
    },
  };
  let pendingAuth = 0;

  async function authenticate(token) {
    if (typeof token !== 'string' || !token || token.length > 4096) {
      throw new AuthError(4001, 'bad_token', '缺少有效的登入憑證');
    }

    let decoded;
    try {
      // checkRevoked=true：被撤銷／停用的帳號即使 token 還沒過期也會被擋下
      decoded = await admin.auth().verifyIdToken(token, true);
    } catch (err) {
      console.warn('[intern-live] verifyIdToken failed:', err?.code || err?.message);
      throw new AuthError(4001, 'invalid_token', '登入憑證無效或已過期，請重新登入');
    }

    let userDoc;
    try {
      userDoc = await getUserDoc(decoded.uid);
    } catch (err) {
      // 查不到授權資料時一律拒絕（fail closed）
      console.error('[intern-live] role lookup failed:', err?.message);
      throw new AuthError(1011, 'auth_lookup_failed', '暫時無法驗證身分，請稍後再試');
    }
    if (!userDoc || userDoc.role !== 'intern') {
      console.warn('[intern-live] role denied:', decoded.uid.slice(0, 6), userDoc?.role);
      throw new AuthError(4003, 'forbidden', '僅限護理實習生使用');
    }
    if (userDoc.isActive === false) {
      throw new AuthError(4003, 'inactive', '此帳號已停用');
    }
    return decoded.uid;
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => {
      ws.isAlive = true;
    });
    ws.on('error', (err) => console.error('[intern-live] socket error:', err.message));

    if (pendingAuth >= MAX_PENDING_AUTH) {
      ws.close(1013, 'busy');
      return;
    }
    pendingAuth += 1;
    let released = false;
    const releasePending = () => {
      if (!released) {
        released = true;
        pendingAuth -= 1;
      }
    };

    let session = null;
    let authStarted = false;
    const authTimer = setTimeout(() => {
      if (!session) {
        rejectSocket(ws, 4008, 'auth_timeout', '驗證逾時，請重新連線');
      }
    }, AUTH_TIMEOUT_MS);

    ws.on('message', async (raw, isBinary) => {
      try {
        if (isBinary) {
          ws.close(1003, 'text_only');
          return;
        }
        let msg;
        try {
          msg = JSON.parse(raw.toString());
        } catch (_) {
          return;
        }
        if (!msg || typeof msg !== 'object') return;

        if (session) {
          session.handleClientMessage(msg);
          return;
        }
        if (authStarted) return; // 驗證進行中，忽略其餘訊息
        if (msg.type !== 'auth') {
          rejectSocket(ws, 4001, 'auth_required', '請先完成登入驗證');
          return;
        }
        authStarted = true;

        let uid;
        try {
          uid = await authenticate(msg.token);
        } catch (err) {
          clearTimeout(authTimer);
          releasePending();
          if (err instanceof AuthError) {
            rejectSocket(ws, err.wsCode, err.reason, err.userMessage);
          } else {
            console.error('[intern-live] auth error:', err?.message);
            rejectSocket(ws, 1011, 'auth_error', '驗證失敗，請稍後再試');
          }
          return;
        }
        clearTimeout(authTimer);
        releasePending();
        if (ws.readyState !== ws.OPEN) return;

        // 以下到 sessions.set 之間沒有 await，同帳號併發連線不會同時通過檢查
        if (ctx.shuttingDown) {
          rejectSocket(ws, 1012, 'server_restart', '伺服器重新啟動中，請稍後重新連線');
          return;
        }
        const previous = ctx.sessions.get(uid);
        const { maxConcurrent } = limits();
        // 被取代的舊 session 若 Gemini connect() 已收斂（或還沒發出），關閉後會立刻釋放一個名額；
        // 若它的 connect() 還卡著，名額要等它收斂，不能算進可用額度
        const freed = previous && !previous.connectPending ? 1 : 0;
        if (ctx.upstream - freed >= maxConcurrent) {
          rejectSocket(ws, 1013, 'server_busy', '目前使用人數已滿，請稍後再試');
          return;
        }
        if (previous) {
          previous.fail('replaced', 4011, '此帳號已在其他裝置開始通話');
        }
        session = new LiveSession(ctx, ws, uid);
        session.reserveSlot(); // 名額在這個同步區段內預留，涵蓋之後等資料庫／Gemini 的整段啟動期間
        ctx.sessions.set(uid, session);
        await session.start();
      } catch (err) {
        console.error('[intern-live] message handler error:', err?.message);
        if (session) session.fail('internal_error', 1011, '發生未預期的錯誤');
        else rejectSocket(ws, 1011, 'internal_error', '發生未預期的錯誤');
      }
    });

    ws.on('close', () => {
      clearTimeout(authTimer);
      releasePending();
      if (session) session.close('client_closed', 1000);
    });
  });

  // 心跳：清掉斷線但沒送 close 的連線（行動網路切換很常見），也避免 Render proxy 閒置斷線
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.isAlive === false) {
        ws.terminate();
        continue;
      }
      ws.isAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_MS);
  heartbeat.unref();

  // 先停止接納新通話，再把「所有尚未完整收尾」的 session（含已關閉、仍在寫最後訊息的）
  // 都等完，最多等 SHUTDOWN_WAIT_MS。
  async function shutdown() {
    ctx.shuttingDown = true;
    clearInterval(heartbeat);
    const closing = [...ctx.all].map((s) =>
      s.fail('server_restart', 1012, '伺服器重新啟動，請稍後重新連線')
    );
    let timer;
    await Promise.race([
      Promise.allSettled(closing),
      new Promise((resolve) => {
        timer = setTimeout(resolve, SHUTDOWN_WAIT_MS);
      }),
    ]);
    clearTimeout(timer);
    // 還在驗證中、尚未成為 session 的連線
    for (const ws of wss.clients) {
      try {
        ws.close(1012, 'server_restart');
      } catch (_) {
        /* ignore */
      }
    }
    wss.close();
  }

  return { shutdown };
}

module.exports = { attachInternLive };
