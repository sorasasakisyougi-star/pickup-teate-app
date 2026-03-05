import { createClient } from "@supabase/supabase-js";

export function supabaseAdmin() {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL!;
  // どっちの名前でも拾えるようにする（事故防止）
  const serviceKey =
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    "";

  if (!url || !serviceKey) {
    throw new Error("Missing NEXT_PUBLIC_SUPABASE_URL or SUPABASE_SERVICE_ROLE_KEY");
  }

  return createClient(url, serviceKey, { auth: { persistSession: false } });
}

export function assertAdminKey(req: any) {
  const adminKey = process.env.ADMIN_KEY || "";
  const got = String(req.headers["x-admin-key"] || "");
  if (!adminKey || got !== adminKey) {
    const err: any = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}
