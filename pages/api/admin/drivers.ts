import type { NextApiRequest, NextApiResponse } from "next";
import { assertAdminKey, supabaseAdmin } from "./_lib/supabaseAdmin";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const sb = supabaseAdmin();

  try {
    if (req.method === "GET") {
      const { data, error } = await sb
        .from("drivers")
        .select("id,name,sort_order,created_at")
        .order("sort_order", { ascending: true })
        .order("id", { ascending: true });

      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true, data });
    }

    // write系は管理キー必須
    assertAdminKey(req);

    if (req.method === "POST") {
      const name = String(req.body?.name ?? "").trim();
      const sort_order = Number(req.body?.sort_order ?? 0);
      if (!name) return res.status(400).json({ ok: false, error: "name required" });

      const { error } = await sb.from("drivers").insert({ name, sort_order });
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true });
    }

    if (req.method === "PUT") {
      const id = Number(req.body?.id);
      const name = String(req.body?.name ?? "").trim();
      const sort_order = Number(req.body?.sort_order ?? 0);
      if (!id) return res.status(400).json({ ok: false, error: "id required" });

      const patch: any = { sort_order };
      if (name) patch.name = name;

      const { error } = await sb.from("drivers").update(patch).eq("id", id);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true });
    }

    if (req.method === "DELETE") {
      const id = Number(req.body?.id);
      if (!id) return res.status(400).json({ ok: false, error: "id required" });

      const { error } = await sb.from("drivers").delete().eq("id", id);
      if (error) return res.status(500).json({ ok: false, error: error.message });
      return res.status(200).json({ ok: true });
    }

    return res.status(405).json({ ok: false, error: "Method not allowed" });
  } catch (e: any) {
    const code = e?.statusCode || 500;
    return res.status(code).json({ ok: false, error: e?.message || "error" });
  }
}
