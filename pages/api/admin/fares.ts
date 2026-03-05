import type { NextApiRequest, NextApiResponse } from "next";
import { assertAdminKey, supabaseAdmin } from "./_lib/supabaseAdmin";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const sb = supabaseAdmin();

  try {
    if (req.method === "GET") {
      const { data, error } = await sb.from("route_fares").select("from_id,to_id,amount_yen");
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true, data });
    }

    assertAdminKey(req);

    if (req.method === "POST") {
      const from_id = Number(req.body?.from_id);
      const to_id = Number(req.body?.to_id);
      const amount_yen = Number(req.body?.amount_yen);

      if (!from_id || !to_id || !Number.isFinite(amount_yen)) {
        return res.status(400).json({ ok: false, error: "from_id/to_id/amount_yen required" });
      }

      const { error } = await sb
        .from("route_fares")
        .upsert({ from_id, to_id, amount_yen }, { onConflict: "from_id,to_id" });

      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      const from_id = Number(req.body?.from_id);
      const to_id = Number(req.body?.to_id);
      if (!from_id || !to_id) return res.status(400).json({ ok: false, error: "from_id/to_id required" });

      const { error } = await sb.from("route_fares").delete().eq("from_id", from_id).eq("to_id", to_id);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e: any) {
    const code = e?.statusCode || 500;
    return res.status(code).json({ ok: false, error: e?.message || "error" });
  }
}
