// 說明：Express 後端（無語音版）
// 提供靜態前端 + API：/api/chat
// 需求：Node 18+ (原生 fetch)、dotenv、express、cors

require('dotenv').config();
const express = require('express');
const path = require('path');
const cors = require('cors');

const app = express();

/* =========================
   CORS（允許 GitHub Pages 來源）
   ========================= */
app.use(cors({
  origin: ['https://taipei-101-run-up.smartchat.live','https://justin-321-hub.github.io','https://taipei-101-run-up-english.smartchat.live'],
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
app.post('/api/chat', async (req, res) => {
  const url = process.env.N8N_WEBHOOK_URL;
  if (!url) return res.status(500).json({ error: '缺少 N8N_WEBHOOK_URL' });

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
        'X-Client-Id': cid
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
