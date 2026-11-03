// RAG 檢索：問題 → OpenAI text-embedding-3-small（1536 維）→ Supabase RPC
// match_intern_rag_chunks。知識庫僅含黃疸護理衛教內容，不含任何個案資料。
const { OpenAI } = require('openai');
const { getSupabase } = require('./supabaseClient');

const EMBEDDING_MODEL = 'text-embedding-3-small';
const MATCH_COUNT = 3;
const MAX_CONTEXT_CHARS = 1500; // 回傳給模型的上下文上限，避免拖慢語音回應
const MAX_QUERY_CHARS = 200;
const REQUEST_TIMEOUT_MS = 8000;

function matchThreshold() {
  const n = Number(process.env.INTERN_RAG_THRESHOLD);
  return Number.isFinite(n) && n > 0 && n < 1 ? n : 0.25;
}

let openai = null;
function getOpenAI() {
  if (!openai) {
    const apiKey = process.env.OPENAI_API_KEY;
    if (!apiKey) throw new Error('OPENAI_API_KEY 未設定');
    openai = new OpenAI({ apiKey, timeout: REQUEST_TIMEOUT_MS, maxRetries: 1 });
  }
  return openai;
}

/**
 * 查詢知識庫。永遠不 throw，呼叫端依 status 決定要給模型什麼提示。
 * @returns {Promise<{status:'ok'|'empty'|'error', context:string, sources:Array<{id:number, section_title:string, source_file:string}>}>}
 */
async function searchKnowledgeBase(rawQuery) {
  const query = String(rawQuery || '').trim().slice(0, MAX_QUERY_CHARS);
  if (!query) return { status: 'empty', context: '', sources: [] };

  try {
    const embeddingRes = await getOpenAI().embeddings.create({
      model: EMBEDDING_MODEL,
      input: query,
    });
    const embedding = embeddingRes.data[0].embedding;

    const { data, error } = await getSupabase()
      .rpc('match_intern_rag_chunks', {
        query_embedding: embedding,
        match_threshold: matchThreshold(),
        match_count: MATCH_COUNT,
      })
      .abortSignal(AbortSignal.timeout(REQUEST_TIMEOUT_MS));

    if (error) {
      console.error('[intern-rag] supabase error:', error.message);
      return { status: 'error', context: '', sources: [] };
    }
    if (!data || data.length === 0) {
      return { status: 'empty', context: '', sources: [] };
    }

    let context = '';
    const sources = [];
    for (let i = 0; i < data.length; i++) {
      const row = data[i];
      let snippet = `【參考條目 ${i + 1}】(章節: ${row.section_title || '未命名'})\n${String(row.content).trim()}`;
      const remaining = MAX_CONTEXT_CHARS - context.length;
      if (snippet.length > remaining) {
        // 第一筆太長就截斷（不能整筆放行，否則上限形同虛設）；之後的條目放不下就停止
        if (context.length > 0 || remaining < 200) break;
        snippet = snippet.slice(0, remaining) + '…（內容過長已截斷）';
      }
      context += snippet + '\n\n';
      sources.push({
        id: row.id,
        section_title: row.section_title || '',
        source_file: row.source_file || '',
      });
    }
    return { status: 'ok', context: context.trim(), sources };
  } catch (err) {
    console.error('[intern-rag] search failed:', err?.name, err?.message);
    return { status: 'error', context: '', sources: [] };
  }
}

module.exports = { searchKnowledgeBase };
