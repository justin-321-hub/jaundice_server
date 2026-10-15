// 說明：Express 後端（無語音版）
// 提供靜態前端 + API：/api/chat
// 需求：Node 18+ (原生 fetch)、dotenv、express、cors

require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');
const admin = require('firebase-admin');
const rateLimit = require('express-rate-limit');

const app = express();

// Render 在反向代理後面，需要信任 X-Forwarded-For 才能拿到真實的使用者 IP
app.set('trust proxy', 1);

/* =========================
   Firebase Admin 初始化
   （用於驗證前端注入的 Firebase ID Token）
   ========================= */
if (!admin.apps.length) {
  const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (serviceAccountJson) {
    admin.initializeApp({
      credential: admin.credential.cert(JSON.parse(serviceAccountJson)),
    });
  } else {
    // 若未提供 FIREBASE_SERVICE_ACCOUNT_JSON，退回使用
    // GOOGLE_APPLICATION_CREDENTIALS 指向的服務帳戶檔案（Application Default Credentials）
    admin.initializeApp();
  }
}

/* =========================
   寶寶所有權檢查（與 firestore.rules 的 ownsBaby / canAccessBaby 保持一致）
   - 授權來源只認 users/{uid}.babyIds（僅後端 Admin SDK 可寫），
     不可相信前端傳來的 babyId，也不可使用舊的單一 babyId 欄位
   - Admin SDK 會繞過 Security Rules，故此處需自行檢查
   ========================= */
async function getUserDoc(uid) {
  const snap = await admin.firestore().collection('users').doc(uid).get();
  return snap.exists ? snap.data() : null;
}

function parentOwnsBaby(userDoc, babyId) {
  return Array.isArray(userDoc?.babyIds) && userDoc.babyIds.includes(babyId);
}

function isClinicianOrSuperuser(userDoc) {
  return ['clinician', 'superuser'].includes(userDoc?.role);
}

/* =========================
   身分驗證中介層
   規則：
   - request body 沒有 parentId 也沒有 babyId（未登入的匿名使用者）→ 不強制驗證，直接放行
   - request body 有 babyId 但沒有 parentId → 拒絕（無法驗證寶寶歸屬）
   - request body 有 parentId → 必須帶合法的 Authorization: Bearer <Firebase ID Token>，
     且 token 解出的 uid 必須與宣稱的 parentId 完全一致，否則拒絕
   - request body 有 babyId → 該 uid 的 users.babyIds 必須包含它，否則 403
   ========================= */
async function verifyParentIdentity(req, res, next) {
  const claimedParentId = req.body?.parentId;
  const claimedBabyId = req.body?.babyId;

  if (claimedBabyId != null && typeof claimedBabyId !== 'string') {
    return res.status(400).json({ error: 'babyId 格式錯誤' });
  }
  if (claimedBabyId && !claimedParentId) {
    return res.status(401).json({ error: '提供 babyId 時必須登入' });
  }
  if (!claimedParentId) return next();

  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : null;

  if (!token) {
    return res.status(401).json({ error: '缺少 Authorization Token' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    if (decoded.uid !== claimedParentId) {
      console.warn('[auth] uid mismatch:', decoded.uid, '!=', claimedParentId);
      return res.status(403).json({ error: 'Token 與 parentId 不一致' });
    }
    req.verifiedUid = decoded.uid;
  } catch (err) {
    console.error('[auth] verifyIdToken failed:', err?.message);
    return res.status(401).json({ error: 'Token 無效或已過期' });
  }

  if (!claimedBabyId) return next();

  try {
    const userDoc = await getUserDoc(req.verifiedUid);
    if (!parentOwnsBaby(userDoc, claimedBabyId)) {
      console.warn('[auth] baby ownership denied:', req.verifiedUid, claimedBabyId);
      return res.status(403).json({ error: '無權存取此寶寶' });
    }
    next();
  } catch (err) {
    // 查不到授權資料時一律拒絕（fail closed）
    console.error('[auth] ownership lookup failed:', err?.message);
    return res.status(503).json({ error: '暫時無法驗證寶寶歸屬，請稍後再試' });
  }
}

/* =========================
   醫護端身分驗證中介層
   規則：
   - 一律要求帶合法的 Authorization: Bearer <Firebase ID Token>，即「有登入才能用」
   - request body 有 clinicianId → token 解出的 uid 必須與宣稱的 clinicianId 完全一致，否則拒絕
     （比照家長端 verifyParentIdentity 的 uid 比對方式）
   - users/{uid}.role 必須是 clinician 或 superuser，否則 403
     （與 firestore.rules 的 canAccessBaby 一致：醫護可存取所有寶寶，故不再逐一檢查 babyId 歸屬）
   ========================= */
async function requireAuth(req, res, next) {
  const authHeader = req.headers['authorization'] || '';
  const token = authHeader.startsWith('Bearer ')
    ? authHeader.slice('Bearer '.length).trim()
    : null;

  if (!token) {
    return res.status(401).json({ error: '缺少 Authorization Token' });
  }

  try {
    const decoded = await admin.auth().verifyIdToken(token);

    const claimedClinicianId = req.body?.clinicianId;
    if (claimedClinicianId && decoded.uid !== claimedClinicianId) {
      console.warn('[auth-clinical] uid mismatch:', decoded.uid, '!=', claimedClinicianId);
      return res.status(403).json({ error: 'Token 與 clinicianId 不一致' });
    }

    req.verifiedUid = decoded.uid;
  } catch (err) {
    console.error('[auth-clinical] verifyIdToken failed:', err?.message);
    return res.status(401).json({ error: 'Token 無效或已過期' });
  }

  try {
    const userDoc = await getUserDoc(req.verifiedUid);
    if (!isClinicianOrSuperuser(userDoc)) {
      console.warn('[auth-clinical] role denied:', req.verifiedUid, userDoc?.role);
      return res.status(403).json({ error: '僅限醫護人員使用' });
    }
    next();
  } catch (err) {
    // 查不到授權資料時一律拒絕（fail closed）
    console.error('[auth-clinical] role lookup failed:', err?.message);
    return res.status(503).json({ error: '暫時無法驗證身分，請稍後再試' });
  }
}

/* =========================
   Rate limiting（S3：防止配額被打爆）
   規則：
   - 每分鐘最多 3 次請求
   - 已登入（req.verifiedUid 由前面的身分驗證中介層設定）→ 以 uid 為 key
   - 未登入 → 退回以 IP 為 key
   - 失敗的請求（回應狀態碼 >= 400，例如上游 n8n 5xx）不計入額度
   - /api/chat 與 /api/chat-clinical 各自獨立計算，互不影響
   ========================= */
function createChatRateLimiter() {
  return rateLimit({
    windowMs: 60 * 1000,
    max: 3,
    // 上游失敗（狀態碼 >= 400）的請求不計入額度，避免前端自動重試吃掉使用者額度
    skipFailedRequests: true,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator: (req) => req.verifiedUid || req.ip,
    handler: (_req, res) => {
      res.status(429).json({ error: '請求太頻繁，請稍後再試' });
    }
  });
}

const chatRateLimiter = createChatRateLimiter();
const chatClinicalRateLimiter = createChatRateLimiter();

/* =========================
   n8n Webhook 共用密鑰
   （與 n8n Webhook 節點的 Header Auth credential 值一致，
   防止繞過本代理直接呼叫 n8n webhook）
   ========================= */
const N8N_WEBHOOK_SHARED_SECRET = process.env.N8N_WEBHOOK_SHARED_SECRET;

/* =========================
   CORS（允許前端來源：家長端 + 醫護端）
   ========================= */
app.use(cors({
  origin: ['https://jaundice.smartchat.live','https://jaundice-inside.smartchat.live','https://justin-321-hub.github.io','https://justin-321-hub.github.io/jaundice-test/'],
  methods: ['GET', 'POST', 'OPTIONS'],
  // 保留 X-Client-Id 供多使用者識別
  allowedHeaders: ['Content-Type', 'Authorization', 'X-Client-Id'],
  maxAge: 86400
}));
app.options('*', cors());

/* =========================
   通用中介層
   ========================= */
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

/* 健康檢查 */
app.get('/health', (_req, res) => res.status(200).send('ok'));

/* =========================
   n8n 代理：文字 → 你的 n8n Webhook
   ========================= */
app.post('/api/chat', verifyParentIdentity, chatRateLimiter, async (req, res) => {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return res.status(500).json({ error: '缺少 N8N_WEBHOOK_URL' });
  if (!N8N_WEBHOOK_SHARED_SECRET) return res.status(500).json({ error: '缺少 N8N_WEBHOOK_SHARED_SECRET' });

  // 讀取 clientId（body 優先，其次 header），預設 anon
  const cid = req.body?.clientId || req.headers['x-client-id'] || 'anon';

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        // 某些 WAF/Cloudflare 對沒有 UA 的請求會擋
        'User-Agent': 'fourleaf-proxy/1.0',
        // 將 clientId 也轉傳到上游
        'X-Client-Id': cid,
        // 與 n8n Webhook 的 Header Auth credential 對應，防止繞過本代理直打 webhook
        'X-Webhook-Secret': N8N_WEBHOOK_SHARED_SECRET
      },
      // 將 clientId 合併進 body，避免前端漏傳
      body: JSON.stringify({ ...(req.body || {}), clientId: cid })
    });

    const ct = r.headers.get('content-type') || '';
    const raw = await r.text(); // 先取字串，避免空 body 解析失敗

    if (!r.ok) {
      console.error('[chat] upstream error:', r.status, raw);
      return res
        .status(r.status)
        .type(ct || 'application/json')
        .send(raw || JSON.stringify({ error: 'chat error' }));
    }

    if (ct.includes('application/json')) {
      return res.status(200).type('application/json').send(raw || '{}');
    } else {
      return res.status(200).json({ text: raw });
    }
  } catch (err) {
    console.error('[chat] fetch failed:', err?.name, err?.message, err?.cause?.code);
    return res.status(502).json({
      error: 'Upstream fetch failed',
      detail: err?.message || String(err)
    });
  }
});

/* =========================
   n8n 代理：jaundice_clinical → jaundice-clinical Webhook
   ========================= */
app.post('/api/chat-clinical', requireAuth, chatClinicalRateLimiter, async (req, res) => {
  const url = process.env.N8N_WEBHOOK_URL_CLINICAL;
  if (!url) return res.status(500).json({ error: '缺少 N8N_WEBHOOK_URL_CLINICAL' });
  if (!N8N_WEBHOOK_SHARED_SECRET) return res.status(500).json({ error: '缺少 N8N_WEBHOOK_SHARED_SECRET' });

  const cid = req.body?.clientId || req.headers['x-client-id'] || 'anon';

  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'fourleaf-proxy/1.0',
        'X-Client-Id': cid,
        'X-Webhook-Secret': N8N_WEBHOOK_SHARED_SECRET
      },
      body: JSON.stringify({ ...(req.body || {}), clientId: cid })
    });

    const ct = r.headers.get('content-type') || '';
    const raw = await r.text();

    if (!r.ok) {
      console.error('[chat-clinical] upstream error:', r.status, raw);
      return res
        .status(r.status)
        .type(ct || 'application/json')
        .send(raw || JSON.stringify({ error: 'chat-clinical error' }));
    }

    if (ct.includes('application/json')) {
      return res.status(200).type('application/json').send(raw || '{}');
    } else {
      return res.status(200).json({ text: raw });
    }
  } catch (err) {
    console.error('[chat-clinical] fetch failed:', err?.name, err?.message, err?.cause?.code);
    return res.status(502).json({
      error: 'Upstream fetch failed',
      detail: err?.message || String(err)
    });
  }
});

/* =========================
   （已移除）語音相關端點
   - /api/whisper  轉寫代理
   - /api/tts      文字轉語音
   相關套件/設定（multer、上傳限制等）也已移除
   ========================= */

/* =========================
   啟動服務
   ========================= */
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running: http://localhost:${PORT}`);

});
