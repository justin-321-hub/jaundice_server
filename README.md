# jaundice_server

新生兒黃疸衛教聊天服務的後端。以 Express 提供靜態前端頁面，並作為 [n8n](https://n8n.io/) Webhook 的代理伺服器，整合 Firebase 身分驗證與請求限流，供家長端與醫護端兩種聊天入口使用。

## 功能特色

- **靜態前端託管**：伺服器啟動時同時提供 `public/` 目錄下的前端頁面
- **雙聊天入口代理**
  - `/api/chat`：家長端，未登入可用；若帶 `parentId` 則需驗證身分
  - `/api/chat-clinical`：醫護端，強制登入才能使用
- **Firebase 身分驗證**：以 Firebase ID Token 驗證使用者身分，並比對 token 內的 uid 與宣稱的 `parentId` / `clinicianId` 是否一致
- **請求限流（Rate Limiting）**：每個使用者（或 IP）每分鐘最多 3 次請求，家長端與醫護端各自獨立計算
- **n8n Webhook 共用密鑰**：呼叫上游 n8n Webhook 時帶入共用密鑰，避免被繞過代理直接呼叫
- **CORS 白名單**：僅允許指定前端網域跨網域存取
- **健康檢查**：`GET /health`

## 環境需求

- Node.js 18 以上（需原生 `fetch`）

## 環境變數

於專案根目錄建立 `.env` 檔案（或於部署平台設定環境變數）：

| 變數名稱 | 說明 | 必填 |
| --- | --- | --- |
| `PORT` | 伺服器監聽埠，預設 `3000` | 否 |
| `FIREBASE_SERVICE_ACCOUNT_JSON` | Firebase 服務帳戶金鑰（JSON 字串）。未提供時退回使用 `GOOGLE_APPLICATION_CREDENTIALS` 指向的憑證檔案 | 二擇一 |
| `N8N_WEBHOOK_URL` | 家長端 n8n Webhook 網址（`/api/chat` 使用） | 是 |
| `N8N_WEBHOOK_URL_CLINICAL` | 醫護端 n8n Webhook 網址（`/api/chat-clinical` 使用） | 是 |
| `N8N_WEBHOOK_SHARED_SECRET` | 與 n8n Webhook 節點 Header Auth 一致的共用密鑰 | 是 |

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

- 若 request body 未帶 `parentId`：不需驗證身分即可呼叫
- 若 request body 帶 `parentId`：需於 `Authorization: Bearer <Firebase ID Token>` 帶入合法 token，且 token 的 uid 須與 `parentId` 一致，否則回傳 `401` / `403`
- 限流：同一使用者（或 IP）每分鐘最多 3 次，超過回傳 `429`

### `POST /api/chat-clinical`

醫護端聊天訊息代理至 `N8N_WEBHOOK_URL_CLINICAL`。

- 一律需於 `Authorization: Bearer <Firebase ID Token>` 帶入合法 token，否則回傳 `401`
- 若 request body 帶 `clinicianId`：token 的 uid 須與其一致，否則回傳 `403`
- 限流：同一使用者（或 IP）每分鐘最多 3 次，與 `/api/chat` 分開計算

## 安全性設計

- **身分驗證**：透過 Firebase Admin SDK 驗證 ID Token，並嚴格比對宣稱身分與 token uid，防止冒用他人身分
- **請求限流**：以 `express-rate-limit` 限制每位使用者的請求頻率，避免上游 n8n 配額被打爆
- **Webhook 共用密鑰**：呼叫 n8n Webhook 時夾帶共用密鑰，防止有心人繞過本代理直接打 n8n Webhook
- **CORS 白名單**：僅允許已知的前端網域（家長端 / 醫護端）跨網域呼叫 API
