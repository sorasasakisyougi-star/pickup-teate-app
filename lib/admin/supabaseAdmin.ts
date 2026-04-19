import { createClient, SupabaseClient } from "@supabase/supabase-js";

// Lazy-initialised Supabase admin client.
//
// Module-level `const supabaseAdmin = createClient(...)` crashed at import
// time whenever the env wasn't set — including in unit test modules that
// intend to inject a fake via their own wiring. Deferring construction to
// the first property access keeps every existing caller (`supabaseAdmin.from(...)`)
// working unchanged while making test setup ergonomic.

let cached: SupabaseClient | null = null;

function build(): SupabaseClient {
  const supabaseUrl =
    process.env.NEXT_PUBLIC_SUPABASE_URL || process.env.SUPABASE_URL || "";
  const serviceRoleKey = process.env.SUPABASE_SERVICE_ROLE_KEY || "";

  if (!supabaseUrl) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_URL");
  }
  if (!serviceRoleKey) {
    throw new Error("Missing SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

// Proxy so that callers who destructure a method still pay the lazy-init
// cost on first use rather than at module-load.
export const supabaseAdmin: SupabaseClient = new Proxy(
  {} as SupabaseClient,
  {
    get(_target, prop) {
      if (!cached) cached = build();
      const value = (cached as unknown as Record<string | symbol, unknown>)[prop];
      return typeof value === "function"
        ? (value as (...a: unknown[]) => unknown).bind(cached)
        : value;
    },
  },
);
