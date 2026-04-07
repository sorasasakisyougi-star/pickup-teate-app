import type { NextApiRequest, NextApiResponse } from "next";
import { supabaseAdmin } from "@/lib/admin/supabaseAdmin";
import { assertAdminKey } from "@/lib/admin/assertAdminKey";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === "GET") {
      const { data, error } = await supabaseAdmin
        .from("fares")
        .select("from_id,to_id,amount_yen")
        .order("from_id", { ascending: true });

      if (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }

      return res.status(200).json({ ok: true, items: data ?? [] });
    }

    assertAdminKey(req);

    if (req.method === "POST") {
      const from_id = Number(req.body?.from_id);
      const to_id = Number(req.body?.to_id);
      const amount_yen = Number(req.body?.amount_yen);

      if (!from_id || !to_id || !Number.isFinite(amount_yen) || amount_yen <= 0) {
        return res.status(400).json({ ok: false, error: "invalid payload" });
      }

      if (from_id === to_id) {
        return res.status(400).json({ ok: false, error: "same location is not allowed" });
      }

      const { data, error } = await supabaseAdmin
        .from("fares")
        .upsert({ from_id, to_id, amount_yen }, { onConflict: "from_id,to_id" })
        .select("from_id,to_id,amount_yen")
        .single();

      if (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }

      return res.status(200).json({ ok: true, item: data });
    }

    if (req.method === "DELETE") {
      const from_id = Number(req.body?.from_id);
      const to_id = Number(req.body?.to_id);

      if (!from_id || !to_id) {
        return res.status(400).json({ ok: false, error: "from_id and to_id are required" });
      }

      const { error } = await supabaseAdmin
        .from("fares")
        .delete()
        .eq("from_id", from_id)
        .eq("to_id", to_id);

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
