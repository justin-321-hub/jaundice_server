-- ============================================================
-- 實習生語音助理（Gemini Live + RAG）Supabase 結構
-- 在 Supabase Dashboard → SQL Editor 整份貼上執行（可重複執行）
--
-- 設計原則：
--   * 只有後端用 service_role key 存取；APP 與 anon / authenticated 一律無權限
--   * 三張表都啟用 RLS 且「刻意不建立任何 policy」→ 預設全部拒絕
--     （service_role 會繞過 RLS，所以後端不受影響）
--   * 再用 REVOKE 明確收回 anon / authenticated 的權限（雙重保險，
--     因為 Supabase 預設會把 public schema 的資料表開放成 REST API）
--   * intern_uid 存的是「後端驗證 Firebase token 後取得的 uid」，
--     絕不採信前端傳來的值
--   * embedding 維度 1536 = OpenAI text-embedding-3-small；
--     之後若換 embedding 模型，維度不同就必須重建 intern_rag_chunks
-- ============================================================

-- 1. pgvector
create extension if not exists vector with schema extensions;

-- ------------------------------------------------------------
-- 2. 對話（一次語音通話 = 一筆）
-- ------------------------------------------------------------
create table if not exists public.intern_conversations (
  id          uuid primary key default gen_random_uuid(),
  intern_uid  text not null,                       -- Firebase Auth uid（後端驗證後寫入）
  model       text,                                -- 實際使用的 Live 模型 ID
  started_at  timestamptz not null default now(),
  ended_at    timestamptz,
  end_reason  text                                 -- client_closed / max_duration / idle_timeout / error ...
);

create index if not exists intern_conversations_uid_started_idx
  on public.intern_conversations (intern_uid, started_at desc);

-- ------------------------------------------------------------
-- 3. 對話訊息（逐字稿，每個 turn 結束時寫入）
-- ------------------------------------------------------------
create table if not exists public.intern_messages (
  id               bigint generated always as identity primary key,
  conversation_id  uuid not null
                   references public.intern_conversations (id) on delete cascade,
  intern_uid       text not null,                  -- 冗餘存一份，方便依實習生稽核／刪除
  role             text not null check (role in ('user', 'assistant')),
  content          text not null,
  interrupted      boolean not null default false, -- 該句是否被使用者打斷（內容可能不完整）
  sources          jsonb not null default '[]'::jsonb,  -- 該回覆引用的 RAG 條目（id / section_title）
  created_at       timestamptz not null default now()
);

create index if not exists intern_messages_conv_created_idx
  on public.intern_messages (conversation_id, created_at);

create index if not exists intern_messages_uid_created_idx
  on public.intern_messages (intern_uid, created_at desc);

-- ------------------------------------------------------------
-- 4. RAG 知識庫（黃疸護理衛教；不放任何個案資料）
-- ------------------------------------------------------------
create table if not exists public.intern_rag_chunks (
  id             bigint generated always as identity primary key,
  source_file    text not null,                    -- 來源檔名
  section_title  text not null default '',         -- 章節名稱
  content        text not null,                    -- 帶階層路徑前綴的文字
  metadata       jsonb not null default '{}'::jsonb,
  embedding      extensions.vector(1536) not null,
  created_at     timestamptz not null default now()
);

create index if not exists intern_rag_chunks_embedding_hnsw_idx
  on public.intern_rag_chunks
  using hnsw (embedding extensions.vector_cosine_ops);

-- ------------------------------------------------------------
-- 5. 向量檢索函式（後端以 service_role 呼叫）
-- ------------------------------------------------------------
create or replace function public.match_intern_rag_chunks (
  query_embedding  extensions.vector(1536),
  match_threshold  double precision default 0.25,
  match_count      integer          default 3
)
returns table (
  id             bigint,
  source_file    text,
  section_title  text,
  content        text,
  metadata       jsonb,
  similarity     double precision
)
language sql
stable
set search_path = public, extensions
as $$
  select
    c.id,
    c.source_file,
    c.section_title,
    c.content,
    c.metadata,
    1 - (c.embedding <=> query_embedding) as similarity
  from public.intern_rag_chunks c
  where 1 - (c.embedding <=> query_embedding) > match_threshold
  order by c.embedding <=> query_embedding
  limit match_count;
$$;

-- ------------------------------------------------------------
-- 6. 權限：RLS 啟用 + 不建 policy + 收回 anon / authenticated
-- ------------------------------------------------------------
alter table public.intern_conversations enable row level security;
alter table public.intern_messages      enable row level security;
alter table public.intern_rag_chunks    enable row level security;

revoke all on table public.intern_conversations from anon, authenticated;
revoke all on table public.intern_messages      from anon, authenticated;
revoke all on table public.intern_rag_chunks    from anon, authenticated;

-- service_role 雖然會繞過 RLS，但「資料表權限」仍然要有。Supabase 自 2026-10-30 起，
-- 新建立的表不再自動授權給 Data API 的角色，所以必須明確授予（最小權限）：
--   * 對話：INSERT（建立，id 由後端先產生）、UPDATE（寫 ended_at）、
--           SELECT（UPDATE ... WHERE id = ... 需要對 id 欄位的 SELECT 權限）
--   * 訊息：INSERT（逐字稿只增不改；之後若要做管理端查詢再另行授予 SELECT）
--   * 知識庫：SELECT（檢索）＋ 寫入權限（由管理者以 service_role 匯入／維護文件，非個案資料）
-- identity 欄位（bigint generated always as identity）INSERT 不需要另外授予 sequence 權限
grant select, insert, update on table public.intern_conversations to service_role;
grant insert                 on table public.intern_messages      to service_role;
grant select, insert, update, delete on table public.intern_rag_chunks to service_role;

-- 函式預設 PUBLIC 可執行，且會暴露成 /rest/v1/rpc/...，必須明確收回
revoke all on function public.match_intern_rag_chunks(extensions.vector, double precision, integer)
  from public, anon, authenticated;
grant execute on function public.match_intern_rag_chunks(extensions.vector, double precision, integer)
  to service_role;

-- ------------------------------------------------------------
-- 驗證（建議執行後跑一次，預期結果見註解）
-- ------------------------------------------------------------
-- 預期：三張表的 rowsecurity 都是 true
--   select tablename, rowsecurity from pg_tables
--   where schemaname = 'public' and tablename like 'intern_%';
--
-- 預期：三張表都沒有任何 policy（0 筆）
--   select tablename, policyname from pg_policies
--   where schemaname = 'public' and tablename like 'intern_%';
--
-- 預期：anon / authenticated 對這三張表沒有任何權限（0 筆）
--   select grantee, table_name, privilege_type
--   from information_schema.role_table_grants
--   where table_schema = 'public' and table_name like 'intern_%'
--     and grantee in ('anon', 'authenticated');
