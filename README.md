# jaundice_server

新生兒黃疸衛教聊天服務的後端。以 Express 提供靜態前端頁面，並作為 [n8n](https://n8n.io/) Webhook 的代理伺服器，整合 Firebase 身分驗證與請求限流，供家長端與醫護端兩種聊天入口使用。另提供**護理實習生語音助理**（Gemini Live + RAG，WebSocket，不經 n8n）。

## 功能特色

- **靜態前端託管**：伺服器啟動時同時提供 `public/` 目錄下的前端頁面
- **雙聊天入口代理**
  - `/api/chat`：家長端，未登入可用；若帶 `parentId` 則需驗證身分；若帶 `babyId` 則必須登入且該寶寶須屬於此家長
  - `/api/chat-clinical`：醫護端，強制登入，且角色須為 `clinician` 或 `superuser`
- **實習生語音助理**（`/ws/intern-live`）：護理實習生（角色 `intern`）以語音即時詢問黃疸護理衛教。後端代理 Gemini Live API，模型透過 function calling 查詢 Supabase 向量知識庫（RAG），逐字稿即時回傳 APP 並寫入 Supabase。**不經 n8n**，詳見下方〈實習生語音助理〉
- **Firebase 身分驗證**：以 Firebase ID Token 驗證使用者身分，並比對 token 內的 uid 與宣稱的 `parentId` / `clinicianId` 是否一致
- **寶寶所有權與角色檢查**：以 Admin SDK 讀取 `users/{uid}`，家長的 `babyIds` 須包含請求的 `babyId`、醫護端的 `role` 須為 `clinician` / `superuser`（邏輯與 App 專案的 `firestore.rules` 一致）
- **請求限流（Rate Limiting）**：每個使用者（或 IP）每分鐘最多 3 次請求，家長端與醫護端各自獨立計算；失敗的請求（狀態碼 >= 400）不計入額度
- **n8n Webhook 共用密鑰**：呼叫上游 n8n Webhook 時帶入共用密鑰，避免被繞過代理直接呼叫
- **CORS 白名單**：僅允許指定前端網域跨網域存取
- **健康檢查**：`GET /health`
- **優雅關閉**：Render 部署／重啟送出 `SIGTERM` 時，先停止接新連線，讓進行中的 HTTP 請求與語音通話收尾（寫入最後訊息與結束時間）後才退出，最多等 25 秒

## 環境需求

- **Node.js 22 以上**（`@supabase/supabase-js`、`openai` 要求 Node ≥ 22；Render 請確認 Node 版本，例如設定環境變數 `NODE_VERSION=22`）

## 環境變數

於專案根目錄建立 `.env` 檔案（或於部署平台設定環境變數）。`.env` 已列入 `.gitignore`，**絕不可提交**（內含 `service_role` 等高權限金鑰）。

### 既有（聊天代理）

| 變數名稱 | 說明 | 必填 |
| --- | --- | --- |
| `PORT` | 伺服器監聽埠，預設 `3000` | 否 |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase 服務帳戶金鑰（JSON 字串）。未提供時退回使用 `GOOGLE_APPLICATION_CREDENTIALS` 指向的憑證檔案。須與 App 使用同一個 Firebase 專案，且具備讀取 Firestore `users` 的權限（用於所有權與角色檢查） | 二擇一 |
| `N8N_WEBHOOK_URL` | 家長端 n8n Webhook 網址（`/api/chat` 使用） | 是 |
| `N8N_WEBHOOK_URL_CLINICAL` | 醫護端 n8n Webhook 網址（`/api/chat-clinical` 使用） | 是 |
| `N8N_WEBHOOK_SHARED_SECRET` | 與 n8n Webhook 節點 Header Auth 一致的共用密鑰 | 是 |

### 實習生語音助理

下列五項缺任何一項，`/ws/intern-live` 都會在連線時回報 `server_misconfigured` 並拒絕服務（不影響其他端點）。

| 變數名稱 | 說明 | 必填 |
| --- | --- | --- |
| `GEMINI_API_KEY` | Gemini API 金鑰 | 是 |
| `GEMINI_LIVE_MODEL` | Gemini Live 模型 ID（例如 `gemini-3.8-live`）。**刻意不寫死在程式碼**，ID 有誤或要換模型時只需改這裡 | 是 |
| `SUPABASE_URL` | Supabase 專案 URL | 是 |
| `SUPABASE_SERVICE_ROLE_KEY` | Supabase `service_role` 金鑰。**只放後端環境變數，不可進 APP 或 repo** | 是 |
| `OPENAI_API_KEY` | 用於 `text-embedding-3-small`（1536 維）查詢向量化 | 是 |
| `INTERN_LIVE_VOICE` | 語音名稱，預設 `Zephyr` | 否 |
| `INTERN_LIVE_THINKING_LEVEL` | `thinkingConfig.thinkingLevel`，預設 `minimal`（降低延遲）。若新模型不支援而連線被拒，設為 `off` 即不送此設定 | 否 |
| `INTERN_LIVE_MAX_SESSION_MS` | 單次通話時長上限，預設 `600000`（10 分鐘） | 否 |
| `INTERN_LIVE_IDLE_MS` | 閒置（無語音／逐字稿活動）逾時，預設 `120000`（2 分鐘） | 否 |
| `INTERN_LIVE_MAX_CONCURRENT` | 全站同時通話數上限，預設 `5` | 否 |
| `INTERN_LIVE_STARTUP_MS` | 驗證通過後到 `ready` 的啟動期限，預設 `20000` | 否 |
| `INTERN_LIVE_TURN_GRACE_MS` | 一輪結束後，等這麼久才把該輪寫入 Supabase，讓延遲到達的使用者逐字稿歸回該輪，預設 `800`。不影響 APP 端的即時顯示 | 否 |
| `INTERN_RAG_THRESHOLD` | RAG 相似度門檻（0～1），預設 `0.25` | 否 |

## 安裝與啟動

```bash
npm install
npm start
```

伺服器預設會在 `http://localhost:3000` 啟動。

## API 端點

### `GET /health`

健康檢查，回傳 `200 ok`。

### `POST /api/chat`

家長端聊天訊息代理至 `N8N_WEBHOOK_URL`。

- 若 request body 未帶 `parentId` 也未帶 `babyId`：不需驗證身分即可呼叫（匿名使用）
- 若 request body 帶 `parentId`：需於 `Authorization: Bearer <Firebase ID Token>` 帶入合法 token，且 token 的 uid 須與 `parentId` 一致，否則回傳 `401` / `403`
- 若 request body 帶 `babyId`：
  - 未帶 `parentId`（無法驗證歸屬）→ `401`
  - `babyId` 不是字串 → `400`
  - 該 uid 的 `users/{uid}.babyIds` 不包含此 `babyId` → `403 無權存取此寶寶`（授權來源只認 `babyIds`，不使用舊的單一 `babyId` 欄位）
  - 讀取 Firestore 失敗 → `503`（一律拒絕，不放行）
- 限流：同一使用者（或 IP）每分鐘最多 3 次，超過回傳 `429`；失敗的請求（例如上游 n8n 回傳 5xx）不計入次數

### `POST /api/chat-clinical`

醫護端聊天訊息代理至 `N8N_WEBHOOK_URL_CLINICAL`。

- 一律需於 `Authorization: Bearer <Firebase ID Token>` 帶入合法 token，否則回傳 `401`
- 若 request body 帶 `clinicianId`：token 的 uid 須與其一致，否則回傳 `403`
- `users/{uid}.role` 須為 `clinician` 或 `superuser`，否則回傳 `403 僅限醫護人員使用`；讀取 Firestore 失敗回傳 `503`（一律拒絕）
- 醫護可存取所有寶寶（與 `firestore.rules` 的 `canAccessBaby` 一致），因此不逐一檢查 `babyId` 歸屬
- 限流：同一使用者（或 IP）每分鐘最多 3 次，與 `/api/chat` 分開計算；失敗的請求不計入次數

### `POST /api/danger-event`

前端（`jaundice`／`jaundice_inside`）命中危險關鍵字時上報，寫入 Supabase `danger_events`。

Request body（JSON）：

| 欄位 | 型別 | 必填 | 說明 |
|---|---|---|---|
| `source` | `"parent"` \| `"clinician"` | 是 | 來源前端 |
| `keyword` | string（≤100 字） | 是 | 命中的關鍵字 |
| `text` | string（超過 2000 字截斷） | 否 | 觸發當下的輸入原文；前端可設定不送 |
| `userId` | string | 否 | `parentId` / `clinicianId` |
| `clientId` | string | 否 | 前端 localStorage UUID |
| `babyId` | string | 否 | 病嬰 ID |

- 回應：成功 `204`；格式錯誤 `400`；寫入失敗 `500`；超過限流 `429`
- **身分驗證不阻擋**：沒帶 token（匿名）或 token 無效都照常寫入，`verified = false`，`user_id` 為前端宣稱的值（可被偽造，僅供參考）；帶合法 Firebase ID Token 時 `user_id` 一律採用 token 解出的 uid，`verified = true`
- 限流：每分鐘最多 10 次（已驗證以 uid、否則以 IP 為 key），與聊天額度分開計算
- 後端 log 只記錄錯誤訊息，**不記錄使用者輸入內容**

#### Supabase 設定

在 Supabase **SQL Editor** 執行 [`supabase/danger_events.sql`](supabase/danger_events.sql)（可重複執行；內含執行後的驗證查詢）。資料表啟用 RLS 且不建 policy，僅 `service_role` 可 INSERT。`content` 欄位是使用者輸入原文，屬高度敏感個資，請限制 Dashboard 存取。

## 實習生語音助理（`/ws/intern-live`）

```
APP (Firebase 登入的 intern)
   ⇅ WebSocket  JSON：{type:'auth'|'audio'|'end'} ⇄ {type:'ready'|'audio'|'transcript'|'interrupted'|'turn_complete'|'error'}
本服務 intern/liveBridge.js  ── 驗證 → 建立對話紀錄 → 代理 Gemini Live
   ⇅ Gemini Live API（@google/genai）
Gemini ── function call: search_knowledge_base(query)
   → intern/ragService.js：OpenAI embedding → Supabase RPC match_intern_rag_chunks → 結果只回給模型，不傳給 APP
對話紀錄 → intern/conversationStore.js → Supabase（intern_conversations / intern_messages）
```

### 協定

連線 `wss://<host>/ws/intern-live` 後：

**APP → 伺服器**（皆為 JSON 文字訊息；二進位訊息會被拒絕）

| 訊息 | 說明 |
| --- | --- |
| `{"type":"auth","token":"<Firebase ID Token>"}` | **第一則必須是它**，10 秒內送出。token 不放網址參數，避免出現在伺服器 log |
| `{"type":"audio","data":"<base64>"}` | PCM16 mono **16 kHz**；收到 `ready` 之後才會被處理。單包上限約 1.4 秒；`mimeType` 由伺服器固定，不採用前端傳入的值 |
| `{"type":"end"}` | 主動結束通話 |

**伺服器 → APP**

| 訊息 | 說明 |
| --- | --- |
| `{"type":"ready","maxSeconds":600}` | 可以開始送音訊 |
| `{"type":"audio","data":"<base64>","mimeType":"audio/pcm;rate=24000"}` | 模型語音 |
| `{"type":"transcript","role":"user"\|"assistant","text":"…"}` | 逐字稿**增量**，APP 依 `role` 累加到畫面下方的文字 |
| `{"type":"interrupted"}` | 使用者打斷，APP 應清空播放佇列 |
| `{"type":"turn_complete"}` | 一輪結束，APP 可封存目前的文字泡泡 |
| `{"type":"error","code":"…","message":"…"}` | 之後伺服器會關閉連線 |

**WebSocket 關閉碼**

| 碼 | reason | 意義 |
| --- | --- | --- |
| 4001 | `auth_required` / `invalid_token` / `bad_token` | 未驗證或 token 無效（含已撤銷） |
| 4003 | `forbidden` / `inactive` | 角色不是 `intern`，或帳號已停用 |
| 4008 | `auth_timeout` / `idle_timeout` | 驗證逾時／閒置逾時 |
| 4009 | `max_duration` | 達單次時長上限 |
| 4011 | `replaced` | 同帳號在別處開始通話，這條被取代 |
| 1003 | `text_only` | 送了二進位訊息 |
| 1008 | `client_too_slow` | 往 APP 的送出佇列過大 |
| 1011 | `log_unavailable` / `gemini_connect_failed` / `startup_timeout` / `server_misconfigured` / `auth_lookup_failed` … | 伺服器或上游錯誤（`error` 訊息有說明） |
| 1012 | `server_restart` | 伺服器重啟，請稍後重連 |
| 1013 | `busy` / `server_busy` | 目前人數已滿 |

### 安全設計

- **身分只取自伺服器驗證**：`verifyIdToken(token, true)`（含撤銷檢查）→ `users/{uid}.role === 'intern'` 且 `isActive !== false`（與 APP 的判斷一致）。對話紀錄的 `intern_uid` 一律是驗證後的 uid，**不接受任何前端傳入的 ID**。查不到授權資料時一律拒絕（fail closed）
- **驗證通過後才建立對話紀錄與 Gemini session**，未授權流量不會消耗 Gemini / OpenAI 額度
- **`intern` 沒有 Firestore 資料權限**（設計如此，見 App 專案 CLAUDE.md）；本功能只讀取 `users/{uid}` 判斷角色，RAG 知識庫**不含任何個案資料**
- **濫用防護**：同帳號只保留一條連線（新的取代舊的）、全站同時通話數上限、單次時長上限、閒置逾時、啟動期限、音訊速率上限（約 1.5 倍即時，超過丟棄）、單一訊息 256 KB 上限、往 APP 與往 Gemini 的送出佇列上限（超過 2 MB 即結束通話）、未驗證連線數上限與 10 秒驗證期限、WebSocket 心跳清除斷線連線
- **上游名額**：同時通話上限以「名額」計算，在驗證通過的同步區段內預留（涵蓋等資料庫、等 Gemini 的整個啟動期間，多條連線同時進來也不會超額），直到 session 關閉**且**其 Gemini 連線已收斂才釋放。被取代或逾時的 session 若 Gemini 連線仍卡住，名額會一直被佔用
- **對話紀錄 fail closed**：每筆 Supabase 寫入有 5 秒逾時；連續失敗 3 次或待寫入超過 20 筆就結束通話，寧可中斷也不要無紀錄地繼續。對話 ID 由後端先產生再寫入，因此即使「建立」的結果不確定，收尾時仍會對同一個 ID 補寫結束時間
- **log 不記對話內容**，只記狀態與長度
- **Supabase 三張表啟用 RLS 且刻意不建 policy**，並 `REVOKE` `anon` / `authenticated`；只有後端以 `service_role` 存取

### Supabase 設定

1. 在 Supabase **SQL Editor** 執行 [`supabase/intern_schema.sql`](supabase/intern_schema.sql)（可重複執行；內含執行後的驗證查詢）
2. 知識庫 `intern_rag_chunks` 的 `embedding` 為 `vector(1536)`，**必須使用 `text-embedding-3-small`** 向量化；若改用其他 embedding 模型，維度不同就要重建該表
3. 匯入文件由管理者以 `service_role` 寫入 `intern_rag_chunks`（匯入腳本尚未提供）。在補上資料之前，模型的每次查詢都會得到「查無資料」

### 已知限制與待辦

- **尚未用真實 Gemini / OpenAI / Supabase 做端對端測試**。`GEMINI_LIVE_MODEL` 的實際 ID，以及該模型是否支援輸入／輸出轉錄與工具呼叫，需實測確認
- 系統提示詞（`intern/prompt.js`）是草稿，臨床相關措辭需由醫護人員審閱；提示詞刻意不寫任何數值，數值一律只能引用 RAG 結果
- **身分只在連線時驗證一次**，之後靠單次時長上限（預設 10 分鐘）兜底；被停用的帳號最多還能講完當次通話
- 逐字稿來自 Live API 的 transcription，**不保證與語音完全一致**，且輸入逐字稿與模型回合之間沒有順序保證，逐字稿片段也沒有回合 ID 或時間戳。本服務在一輪結束後等 `INTERN_LIVE_TURN_GRACE_MS`（預設 800 ms）再存檔，讓稍晚到達的使用者逐字稿歸回該輪；**若使用者逐字稿比寬限時間更晚到，會被歸到下一輪**（順序錯位、或與下一題合併）。這是協定本身的限制，只能降低機率
- Gemini `connect()` 無法取消。若它永遠不收斂（上游異常），對應的名額不會釋放（逾時不等於資源已釋放），日誌會在 60 秒時記錄 `gemini connect() still pending` 警告；累積到同時通話數上限時需重啟服務
- 往 Gemini 的送出佇列上限是讀取 SDK 內部欄位 `session.conn.ws.bufferedAmount`，SDK 升級後若欄位消失，這項防護會自動失效（退回僅靠音訊速率限制），升級 `@google/genai` 後需要重新確認
- 對話紀錄**尚無保存期限與自動刪除機制**；實習生可能在對話中說出個資，上線前需決定保存政策
- Render **免費方案閒置約 15 分鐘會休眠**，喚醒需 30～50 秒，語音通話第一次連線會卡很久，建議使用不休眠的方案
- WebSocket **不檢查 `Origin`**（CORS 白名單只作用於 HTTP API）；防護完全靠 Firebase token 與角色檢查
- 本服務為單一實例設計（同帳號唯一連線、同時通話數上限都存在記憶體中）；若改為多實例需另外處理

## 安全性設計（聊天代理）

- **身分驗證**：透過 Firebase Admin SDK 驗證 ID Token，並嚴格比對宣稱身分與 token uid，防止冒用他人身分
- **授權檢查（fail closed）**：Admin SDK 會繞過 Firestore Security Rules，因此由本服務自行檢查寶寶所有權（`users.babyIds`）與醫護角色；查不到授權資料或讀取失敗時一律拒絕
- **已知限制**：`/api/chat` 在未帶 `parentId` / `babyId` 時仍允許匿名呼叫（僅以 IP 限流）；`/api/chat`、`/api/chat-clinical` 不檢查帳號的 `isActive`，被停用的帳號在 token 有效期間（約 1 小時）仍可使用（實習生語音端點則有檢查 `isActive` 與 token 撤銷）
- **請求限流**：以 `express-rate-limit` 限制每位使用者的請求頻率，避免上游 n8n 配額被打爆；並以 `skipFailedRequests` 讓失敗請求不計入額度，避免前端自動重試吃掉使用者額度
- **Webhook 共用密鑰**：呼叫 n8n Webhook 時夾帶共用密鑰，防止有心人繞過本代理直接打 n8n Webhook
- **CORS 白名單**：僅允許已知的前端網域（家長端 / 醫護端）跨網域呼叫 API
