import type { NextApiRequest, NextApiResponse } from "next";
import { assertAdminKey } from "@/lib/admin/assertAdminKey";
import { supabaseAdmin } from "@/lib/admin/supabaseAdmin";

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  try {
    if (req.method === "GET") {
      const { data, error } = await supabaseAdmin
        .from("locations")
        .select("*")
        .order("name", { ascending: true });

      if (error) throw error;
      return res.status(200).json(data ?? []);
    }

    if (req.method === "POST") {
      assertAdminKey(req);

      const { name, kind } = req.body ?? {};
      if (!name || typeof name !== "string") {
        return res.status(400).json({ error: "name is required" });
      }

      const payload = {
        name: name.trim(),
        kind: typeof kind === "string" ? kind.trim() : null,
      };

      const { data, error } = await supabaseAdmin
        .from("locations")
        .insert([payload])
        .select()
        .single();

      if (error) throw error;
      return res.status(200).json(data);
    }

    if (req.method === "DELETE") {
      assertAdminKey(req);

      const { id } = req.body ?? {};
      if (!id) {
        return res.status(400).json({ error: "id is required" });
      }

      const { error } = await supabaseAdmin.from("locations").delete().eq("id", id);
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
