import type { NextApiRequest, NextApiResponse } from "next";
import { assertAdminKey } from "@/lib/admin/assertAdminKey";
import { supabaseAdmin } from "@/lib/admin/supabaseAdmin";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === "GET") {
      const { data, error } = await supabaseAdmin
        .from("fares")
        .select("*")
        .order("from_id", { ascending: true })
        .order("to_id", { ascending: true });

      if (error) throw error;
      return res.status(200).json(data ?? []);
    }

    if (req.method === "POST") {
      assertAdminKey(req);

      const { from_id, to_id, amount_yen } = req.body ?? {};
      if (!from_id || !to_id || amount_yen == null) {
        return res.status(400).json({ error: "from_id, to_id, amount_yen are required" });
      }

      const amount = Number(amount_yen);
      if (!Number.isFinite(amount)) {
        return res.status(400).json({ error: "amount_yen must be a number" });
      }

      const { data, error } = await supabaseAdmin
        .from("fares")
        .upsert([{ from_id, to_id, amount_yen: amount }], {
          onConflict: "from_id,to_id",
        })
        .select()
        .single();

      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === "DELETE") {
      assertAdminKey(req);

      const { from_id, to_id } = req.body ?? {};
      if (!from_id || !to_id) {
        return res.status(400).json({ error: "from_id and to_id are required" });
      }

      const { error } = await supabaseAdmin
        .from("fares")
        .delete()
        .match({ from_id, to_id });

      if (error) throw error;
      return res.status(200).json({ ok: true });
    }

    res.setHeader("Allow", "GET,POST,DELETE");
    return res.status(405).json({ error: "Method not allowed" });
  } catch (error: unknown) {
    const statusCode =
      typeof error === "object" &&
      error !== null &&
      "statusCode" in error &&
      typeof (error as { statusCode?: unknown }).statusCode === "number"
        ? (error as { statusCode: number }).statusCode
        : 500;

    const message = error instanceof Error ? error.message : "Internal Server Error";
    return res.status(statusCode).json({ error: message });
  }
}
