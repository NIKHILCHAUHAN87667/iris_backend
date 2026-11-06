import { createClient } from "@supabase/supabase-js";

let supabase;

export default function getSupabase() {
  if (supabase) return supabase;
  const url = process.env.SUPABASE_URL;
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !serviceRoleKey) throw new Error("Supabase Storage is not configured. Set SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY on the backend.");
  supabase = createClient(url, serviceRoleKey);
  return supabase;
}
