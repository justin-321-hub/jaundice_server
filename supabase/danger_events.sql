-- ============================================================
-- 危險關鍵字事件（danger_events）Supabase 結構
-- 在 Supabase Dashboard → SQL Editor 整份貼上執行（可重複執行）
--
-- 設計原則（與 intern_schema.sql 一致）：
--   * 只有後端用 service_role key 寫入；anon / authenticated 一律無權限
--   * 啟用 RLS 且「刻意不建立任何 policy」→ 預設全部拒絕
--   * content 可能含高度敏感個資（使用者輸入原文），務必限制 Dashboard 存取
--   * user_id：後端驗證 Firebase token 通過時為驗證後的 uid（verified = true）；
--     未帶 / 無效 token 時為前端宣稱的值（verified = false，僅供參考，可被偽造）
-- ============================================================

create table if not exists public.danger_events (
  id          bigint generated always as identity primary key,
  source      text not null check (source in ('parent', 'clinician')),
  keyword     text not null,                 -- 命中的關鍵字
  content     text,                          -- 觸發當下的輸入原文（前端設定不送時為 null）
  user_id     text,                          -- parentId / clinicianId（見上方說明）
  verified    boolean not null default false,
  client_id   text,                          -- 前端 localStorage 的 UUID
  baby_id     text,
  created_at  timestamptz not null default now()
);

create index if not exists danger_events_created_idx
  on public.danger_events (created_at desc);

create index if not exists danger_events_user_created_idx
  on public.danger_events (user_id, created_at desc);

alter table public.danger_events enable row level security;

revoke all on table public.danger_events from anon, authenticated;

-- Supabase 新表不再自動授權給 Data API 角色，需明確授予；後端只需要 INSERT
grant insert on table public.danger_events to service_role;

-- ------------------------------------------------------------
-- 驗證（建議執行後跑一次）
-- ------------------------------------------------------------
-- 預期：rowsecurity = true
--   select tablename, rowsecurity from pg_tables
--   where schemaname = 'public' and tablename = 'danger_events';
--
-- 預期：0 筆 policy
--   select policyname from pg_policies
--   where schemaname = 'public' and tablename = 'danger_events';
--
-- 預期：anon / authenticated 0 筆權限
--   select grantee, privilege_type from information_schema.role_table_grants
--   where table_schema = 'public' and table_name = 'danger_events'
--     and grantee in ('anon', 'authenticated');
