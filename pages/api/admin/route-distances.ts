import type { NextApiRequest, NextApiResponse } from "next";
import { assertAdminKey } from "@/lib/admin/assertAdminKey";
import { supabaseAdmin } from "@/lib/admin/supabaseAdmin";

type RouteDistanceRow = {
  id: number;
  from_location_id: number;
  to_location_id: number;
  distance_km: number;
  created_at?: string;
  updated_at?: string;
};

type Data =
  | { ok: true; items?: any[]; item?: RouteDistanceRow | null }
  | { ok: false; error: string };

export default async function handler(
  req: NextApiRequest,
  res: NextApiResponse<Data>
) {
  try {
    assertAdminKey(req);

    if (req.method === "GET") {
      const { data, error } = await supabaseAdmin
        .from("route_distances")
        .select(`
          id,
          from_location_id,
          to_location_id,
          distance_km,
          created_at,
          updated_at,
          from_location:locations!route_distances_from_location_id_fkey (
            id,
            name
          ),
          to_location:locations!route_distances_to_location_id_fkey (
            id,
            name
          )
        `)
        .order("id", { ascending: true });

      if (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }

      return res.status(200).json({ ok: true, items: data ?? [] });
    }

    if (req.method === "POST") {
      const { from_location_id, to_location_id, distance_km } = req.body ?? {};

      if (!from_location_id || !to_location_id) {
        return res
          .status(400)
          .json({ ok: false, error: "出発地と到着地は必須です" });
      }

      if (Number(from_location_id) === Number(to_location_id)) {
        return res
          .status(400)
          .json({ ok: false, error: "同じ地点同士は登録できません" });
      }

      const km = Number(distance_km);
      if (!Number.isFinite(km) || km < 0) {
        return res
          .status(400)
          .json({ ok: false, error: "距離は0以上の数値で入力してください" });
      }

      const { data, error } = await supabaseAdmin
        .from("route_distances")
        .upsert(
          {
            from_location_id: Number(from_location_id),
            to_location_id: Number(to_location_id),
            distance_km: km,
          },
          {
            onConflict: "from_location_id,to_location_id",
          }
        )
        .select()
        .single();

      if (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }

      return res.status(200).json({ ok: true, item: data });
    }

    if (req.method === "DELETE") {
      const { id } = req.body ?? {};

      if (!id) {
        return res.status(400).json({ ok: false, error: "idが必要です" });
      }

      const { error } = await supabaseAdmin
        .from("route_distances")
        .delete()
        .eq("id", Number(id));

      if (error) {
        return res.status(500).json({ ok: false, error: error.message });
      }

      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET,POST,DELETE");
    return res.status(405).json({ ok: false, error: "Method Not Allowed" });
  } catch (e: any) {
    const message =
      e?.message === "UNAUTHORIZED"
        ? "Unauthorized"
        : e?.message || "Internal Server Error";

    const status = e?.message === "UNAUTHORIZED" ? 401 : 500;
    return res.status(status).json({ ok: false, error: message });
  }
}
