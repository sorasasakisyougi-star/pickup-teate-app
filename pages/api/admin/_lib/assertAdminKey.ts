import type { NextApiRequest } from "next";

export function assertAdminKey(req: NextApiRequest) {
  const expected = process.env.ADMIN_KEY;
  if (!expected) throw new Error("Missing env: ADMIN_KEY");

  const headerKey = req.headers["x-admin-key"];
  const key = Array.isArray(headerKey) ? headerKey[0] : headerKey;

  if (!key || key !== expected) {
    const err: any = new Error("Unauthorized");
    err.statusCode = 401;
    throw err;
  }
}
