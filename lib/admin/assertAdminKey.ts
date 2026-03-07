import type { NextApiRequest } from "next";

export function assertAdminKey(req: NextApiRequest) {
  const envKey = process.env.ADMIN_KEY;

  if (!envKey) {
    throw new Error("ADMIN_KEY is not set");
  }

  const headerKey = req.headers["x-admin-key"];
  const authHeader = req.headers.authorization;

  const xAdminKey =
    typeof headerKey === "string" ? headerKey : Array.isArray(headerKey) ? headerKey[0] : "";

  const bearer =
    typeof authHeader === "string" && authHeader.startsWith("Bearer ")
      ? authHeader.slice("Bearer ".length)
      : "";

  const actualKey = xAdminKey || bearer;

  if (!actualKey || actualKey !== envKey) {
    const err = new Error("Unauthorized");
    (err as Error & { statusCode?: number }).statusCode = 401;
    throw err;
  }
}
