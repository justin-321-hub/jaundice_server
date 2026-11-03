// Supabase 連線（僅後端使用 service_role key，絕不可進 APP / repo）
const { createClient } = require('@supabase/supabase-js');

let client = null;

function getSupabase() {
  if (!client) {
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('SUPABASE_URL 或 SUPABASE_SERVICE_ROLE_KEY 未設定');
    }
    client = createClient(url, key, {
      auth: { persistSession: false, autoRefreshToken: false },
    });
  }
  return client;
}

module.exports = { getSupabase };
