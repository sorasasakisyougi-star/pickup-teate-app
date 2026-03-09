import type { NextApiRequest, NextApiResponse } from "next";
import { supabaseAdmin } from "@/lib/admin/supabaseAdmin";
import { assertAdminKey } from "@/lib/admin/assertAdminKey";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === "GET") {
      const { data, error } = await supabaseAdmin
        .from("route_distances")
        .select("from_location_id,to_location_id,distance_km")
        .order("from_location_id", { ascending: true });

      if (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }

      return res.status(200).json({ ok: true, items: data ?? [] });
    }

    assertAdminKey(req);

    if (req.method === "POST") {
      const from_location_id = Number(req.body?.from_location_id);
      const to_location_id = Number(req.body?.to_location_id);
      const distance_km = Number(req.body?.distance_km);

      if (!from_location_id || !to_location_id || !Number.isFinite(distance_km)) {
        return res.status(400).json({ ok: false, error: "invalid payload" });
      }

      const { data, error } = await supabaseAdmin
        .from("route_distances")
        .upsert(
          { from_location_id, to_location_id, distance_km },
          { onConflict: "from_location_id,to_location_id" }
        )
        .select("from_location_id,to_location_id,distance_km")
        .single();

      if (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }

      return res.status(200).json({ ok: true, item: data });
    }

    if (req.method === "DELETE") {
      const from_location_id = Number(req.body?.from_location_id);
      const to_location_id = Number(req.body?.to_location_id);

      if (!from_location_id || !to_location_id) {
        return res.status(400).json({ ok: false, error: "from_location_id and to_location_id are required" });
      }

      const { error } = await supabaseAdmin
        .from("route_distances")
        .delete()
        .eq("from_location_id", from_location_id)
        .eq("to_location_id", to_location_id);

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
