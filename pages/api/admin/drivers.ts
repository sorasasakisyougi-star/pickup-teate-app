import type { NextApiRequest, NextApiResponse } from "next";
import { supabaseAdmin } from "@/lib/admin/supabaseAdmin";
import { assertAdminKey } from "@/lib/admin/assertAdminKey";
import { isValidUuid, UUID_INVALID_MESSAGE } from "@/lib/admin/uuid";

// Minimal surface of the Supabase client that the drivers route uses.
// Declaring this structurally (rather than importing the real type) keeps
// the test double simple.
type DriversDbClient = typeof supabaseAdmin;

let currentDb: DriversDbClient = supabaseAdmin;

/** Test-only: swap the Supabase client used by this route. */
export function __setSupabaseForTests(override: DriversDbClient | null) {
  currentDb = override ?? supabaseAdmin;
}

type UuidParseResult =
  | { ok: true; value: string | null }
  | { ok: false; message: string };

function parseLineWorksUserId(raw: unknown): UuidParseResult {
  if (raw == null) return { ok: true, value: null };
  if (typeof raw !== "string") {
    return { ok: false, message: UUID_INVALID_MESSAGE };
  }
  const trimmed = raw.trim();
  if (trimmed.length === 0) return { ok: true, value: null };
  if (!isValidUuid(trimmed)) {
    return { ok: false, message: UUID_INVALID_MESSAGE };
  }
  return { ok: true, value: trimmed };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    // Phase 2d Step 0 fix: every method is admin-gated. The old GET
    // exposed lineworks_user_id unauthenticated, which is a direct leak.
    assertAdminKey(req);

    const db = currentDb;

    if (req.method === "GET") {
      const { data, error } = await db
        .from("drivers")
        .select("id,name,lineworks_user_id")
        .order("name", { ascending: true });

      if (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }

      return res.status(200).json({ ok: true, items: data ?? [] });
    }

    if (req.method === "POST") {
      const name = String(req.body?.name ?? "").trim();
      if (!name) {
        return res.status(400).json({ ok: false, error: "name is required" });
      }

      const uuidResult = parseLineWorksUserId(req.body?.lineworks_user_id);
      if (!uuidResult.ok) {
        return res.status(400).json({ ok: false, error: uuidResult.message });
      }
      const lineworksUserId = uuidResult.value;

      const existingByName = await db
        .from("drivers")
        .select("id")
        .eq("name", name)
        .maybeSingle();

      if (existingByName.error) {
        return res.status(500).json({ ok: false, error: existingByName.error.message });
      }

      if (existingByName.data) {
        return res.status(409).json({ ok: false, error: "同名の運転手が既に存在します" });
      }

      // 409 on duplicate lineworks_user_id (was 500 from a raw DB
      // unique-violation — opaque to the operator).
      if (lineworksUserId) {
        const existingByUuid = await db
          .from("drivers")
          .select("id")
          .eq("lineworks_user_id", lineworksUserId)
          .maybeSingle();
        if (existingByUuid.error) {
          return res.status(500).json({ ok: false, error: existingByUuid.error.message });
        }
        if (existingByUuid.data) {
          return res
            .status(409)
            .json({ ok: false, error: "同じ LINE WORKS ユーザーIDの運転手が既に存在します" });
        }
      }

      const { data, error } = await db
        .from("drivers")
        .insert({ name, lineworks_user_id: lineworksUserId })
        .select("id,name,lineworks_user_id")
        .single();

      if (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }

      return res.status(200).json({ ok: true, item: data });
    }

    if (req.method === "PATCH") {
      const id = Number(req.body?.id);
      if (!id) {
        return res.status(400).json({ ok: false, error: "id is required" });
      }

      const uuidResult = parseLineWorksUserId(req.body?.lineworks_user_id);
      if (!uuidResult.ok) {
        return res.status(400).json({ ok: false, error: uuidResult.message });
      }
      const lineworksUserId = uuidResult.value;

      // 409 when the target UUID is already owned by a different driver.
      if (lineworksUserId) {
        const existingByUuid = await db
          .from("drivers")
          .select("id")
          .eq("lineworks_user_id", lineworksUserId)
          .maybeSingle();
        if (existingByUuid.error) {
          return res.status(500).json({ ok: false, error: existingByUuid.error.message });
        }
        if (existingByUuid.data && existingByUuid.data.id !== id) {
          return res
            .status(409)
            .json({ ok: false, error: "同じ LINE WORKS ユーザーIDの運転手が既に存在します" });
        }
      }

      const { data, error } = await db
        .from("drivers")
        .update({ lineworks_user_id: lineworksUserId })
        .eq("id", id)
        .select("id,name,lineworks_user_id")
        .single();

      if (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }

      return res.status(200).json({ ok: true, item: data });
    }

    if (req.method === "DELETE") {
      const id = Number(req.body?.id);
      if (!id) {
        return res.status(400).json({ ok: false, error: "id is required" });
      }

      const { error } = await db.from("drivers").delete().eq("id", id);
      if (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e: unknown) {
    const msg = e instanceof Error ? e.message : "Server error";
    if (msg === "Unauthorized" || msg === "ADMIN_KEY is not set") {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    return res.status(500).json({ ok: false, error: msg });
  }
}
