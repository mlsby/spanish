import { createClient, type SupabaseClient, type Session } from "@supabase/supabase-js";

/**
 * URL och publishable key är publika by design — de skickas med varje
 * klientanrop och allt skydd ligger i row level security-policyerna
 * (varje rad kräver auth.uid() = user_id). Databaslösenord och service-
 * nycklar finns aldrig här.
 */
const SUPABASE_URL = "https://aszqdjakksvrusmtmjtn.supabase.co";
const SUPABASE_KEY = "sb_publishable_hnxunR3z0HYH_qHYEk6kAA_m66qKw00";

export function createSupabase(): SupabaseClient {
  return createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: {
      persistSession: true,
      autoRefreshToken: true,
      detectSessionInUrl: true, // magic link-klick i samma webbläsare loggar in direkt
    },
  });
}

export type { SupabaseClient, Session };
