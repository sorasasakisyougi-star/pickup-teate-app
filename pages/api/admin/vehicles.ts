import type { NextApiRequest, NextApiResponse } from "next";
import { supabaseAdmin } from "@/lib/admin/supabaseAdmin";
import { assertAdminKey } from "@/lib/admin/assertAdminKey";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === "GET") {
      const { data, error } = await supabaseAdmin
        .from("vehicles")
        .select("id,name")
        .order("name", { ascending: true });

      if (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }

      return res.status(200).json({ ok: true, items: data ?? [] });
    }

    assertAdminKey(req);

    if (req.method === "POST") {
      const name = String(req.body?.name ?? "").trim();
      if (!name) {
        return res.status(400).json({ ok: false, error: "name is required" });
      }

      const existing = await supabaseAdmin
        .from("vehicles")
        .select("id")
        .eq("name", name)
        .maybeSingle();

      if (existing.error) {
        return res.status(500).json({ ok: false, error: existing.error.message });
      }

      if (existing.data) {
        return res.status(409).json({ ok: false, error: "同名の車両が既に存在します" });
      }

      const { data, error } = await supabaseAdmin
        .from("vehicles")
        .insert({ name })
        .select("id,name")
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

      const { error } = await supabaseAdmin.from("vehicles").delete().eq("id", id);
      if (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }

      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e: any) {
    const msg = e?.message ?? "Server error";
    if (msg === "Unauthorized") {
      return res.status(401).json({ ok: false, error: "Unauthorized" });
    }
    return res.status(500).json({ ok: false, error: msg });
  }
}
