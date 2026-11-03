// 危險關鍵字事件：驗證輸入並寫入 Supabase（danger_events）
// 前端（jaundice / jaundice_inside）命中危險關鍵字時 POST /api/danger-event

const SOURCES = ['parent', 'clinician'];
const MAX_ID_LEN = 128;
const MAX_KEYWORD_LEN = 100;
const MAX_TEXT_LEN = 2000;

function optString(v, max) {
  if (v == null) return null;
  if (typeof v !== 'string') throw new Error('invalid');
  const s = v.trim();
  if (!s) return null;
  return s.slice(0, max);
}

// 回傳可直接寫入資料表的 row；格式不合法時丟出 Error('invalid')
function buildRow(body, { verifiedUid } = {}) {
  const b = body || {};
  if (!SOURCES.includes(b.source)) throw new Error('invalid');
  const keyword = optString(b.keyword, MAX_KEYWORD_LEN);
  if (!keyword) throw new Error('invalid');

  const claimedUserId = optString(b.userId, MAX_ID_LEN);
  return {
    source: b.source,
    keyword,
    content: optString(b.text, MAX_TEXT_LEN), // 前端可能刻意不送內容
    // 有合法 token → 一律採用後端驗證出的 uid，不信前端宣稱的值
    user_id: verifiedUid || claimedUserId,
    verified: !!verifiedUid,
    client_id: optString(b.clientId, MAX_ID_LEN),
    baby_id: optString(b.babyId, MAX_ID_LEN),
  };
}

async function insertDangerEvent(row) {
  const { getSupabase } = require('../intern/supabaseClient');
  const { error } = await getSupabase().from('danger_events').insert(row);
  if (error) throw new Error(error.message);
}

module.exports = { buildRow, insertDangerEvent };
