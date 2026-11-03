// 對話紀錄（Supabase：intern_conversations / intern_messages）
// intern_uid 一律是後端驗證 Firebase token 後取得的 uid，不接受前端傳入。
//
// 每次 I/O 都有逾時：資料庫停滯時要變成「失敗」，通話端的 fail closed 才會生效，
// 也避免 shutdown 時卡在一筆永遠不回來的寫入。
const { getSupabase } = require('./supabaseClient');

const MAX_CONTENT_CHARS = 8000;
const IO_TIMEOUT_MS = 5000;

const deadline = () => AbortSignal.timeout(IO_TIMEOUT_MS);

// id 由呼叫端（後端）先產生：即使 INSERT 已提交但回應逾時、結果不確定，
// 收尾時仍可對同一個 id 補寫 ended_at。
async function createConversation({ id, uid, model }) {
  const { error } = await getSupabase()
    .from('intern_conversations')
    .insert({ id, intern_uid: uid, model })
    .abortSignal(deadline());
  if (error) throw new Error(error.message);
}

async function addMessage({ conversationId, uid, role, content, interrupted, sources }) {
  const { error } = await getSupabase()
    .from('intern_messages')
    .insert({
      conversation_id: conversationId,
      intern_uid: uid,
      role,
      content: String(content).slice(0, MAX_CONTENT_CHARS),
      interrupted: !!interrupted,
      sources: sources || [],
    })
    .abortSignal(deadline());
  if (error) throw new Error(error.message);
}

// 對不存在的 id 更新不會報錯（0 列）；對結果不確定的建立操作，補寫仍是安全的
async function endConversation(conversationId, reason) {
  const { error } = await getSupabase()
    .from('intern_conversations')
    .update({ ended_at: new Date().toISOString(), end_reason: reason })
    .eq('id', conversationId)
    .abortSignal(deadline());
  if (error) throw new Error(error.message);
}

module.exports = { createConversation, addMessage, endConversation };
