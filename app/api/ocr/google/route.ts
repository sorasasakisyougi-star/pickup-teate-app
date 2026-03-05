// app/api/ocr/google/route.ts
import { NextResponse } from "next/server";
import crypto from "crypto";

export const runtime = "nodejs";

type VisionAnnotateResponse = {
  responses?: Array<{
    textAnnotations?: Array<{ description?: string }>;
    fullTextAnnotation?: { text?: string };
    error?: { message?: string };
  }>;
};

function base64Url(input: Buffer | string) {
  const buf = Buffer.isBuffer(input) ? input : Buffer.from(input);
  return buf
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/g, "");
}

function getRequiredEnv(name: string) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env: ${name}`);
  return v;
}

function normalizePrivateKey(raw: string) {
  // Vercelのenvで \n が文字列として入っても復元
  const fixed = raw.replace(/\\n/g, "\n").trim();

  // 先頭/末尾のガード（BEGIN/ENDが欠ける事故を検出）
  if (!fixed.includes("BEGIN PRIVATE KEY")) {
    throw new Error("GOOGLE_PRIVATE_KEY is missing 'BEGIN PRIVATE KEY' line");
  }
  if (!fixed.includes("END PRIVATE KEY")) {
    throw new Error("GOOGLE_PRIVATE_KEY is missing 'END PRIVATE KEY' line");
  }
  return fixed;
}

function maskEmail(email: string) {
  // ログに出しても安全な程度にマスク
  const [user, domain] = email.split("@");
  if (!domain) return "***";
  return `${(user ?? "").slice(0, 3)}***@${domain}`;
}

async function getGoogleAccessToken() {
  const clientEmail = getRequiredEnv("GOOGLE_CLIENT_EMAIL").trim();
  const privateKey = normalizePrivateKey(getRequiredEnv("GOOGLE_PRIVATE_KEY"));
  const tokenUri =
    (process.env.GOOGLE_TOKEN_URI?.trim() as string) ||
    "https://oauth2.googleapis.com/token";

  const now = Math.floor(Date.now() / 1000);
  const header = { alg: "RS256", typ: "JWT" };
  const claimSet = {
    iss: clientEmail,
    scope: "https://www.googleapis.com/auth/cloud-platform",
    aud: tokenUri,
    exp: now + 3600,
    iat: now,
  };

  const unsigned =
    `${base64Url(JSON.stringify(header))}.` +
    `${base64Url(JSON.stringify(claimSet))}`;

  // 署名
  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();

  let signature: Buffer;
  try {
    signature = signer.sign(privateKey);
  } catch (e) {
    // ここで落ちるのは鍵フォーマット崩れが多い
    throw new Error(
      `JWT signing failed (private key format?): ${e instanceof Error ? e.message : "unknown"}`
    );
  }

  const jwt = `${unsigned}.${base64Url(signature)}`;

  const resp = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
      assertion: jwt,
    }),
    cache: "no-store",
  });

  const text = await resp.text();

  if (!resp.ok) {
    // tokenエラーは本文が重要（invalid_grant等）
    // ただしjwt本体は絶対出さない
    throw new Error(
      `Token error ${resp.status}: ${text.slice(0, 800)} (email=${maskEmail(clientEmail)})`
    );
  }

  const data = (text ? JSON.parse(text) : {}) as { access_token?: string };
  if (!data.access_token) throw new Error("No access_token in token response");
  return data.access_token;
}

function normalizeForDigits(text: string) {
  const z2h = (s: string) =>
    s.replace(/[０-９]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    );

  return z2h(text)
    .replace(/[OoＯｏ]/g, "0")
    .replace(/[IlIｌ｜]/g, "1");
}

function extractDigitsCandidates(text: string) {
  const normalized = normalizeForDigits(text);
  // 4〜8桁をODO候補として抽出
  const matches = normalized.match(/\d{4,8}/g) ?? [];
  return {
    normalizedText: normalized,
    candidates: Array.from(new Set(matches)),
  };
}

export async function POST(req: Request) {
  const started = Date.now();

  try {
    const form = await req.formData();
    const file = form.get("image");

    if (!(file instanceof File)) {
      return NextResponse.json(
        { ok: false, error: "image file is required" },
        { status: 400 }
      );
    }

    const arrayBuffer = await file.arrayBuffer();
    const base64Image = Buffer.from(arrayBuffer).toString("base64");

    // 1) token
    const accessToken = await getGoogleAccessToken();

    // 2) vision annotate
    const visionResp = await fetch(
      "https://vision.googleapis.com/v1/images:annotate",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${accessToken}`,
        },
        body: JSON.stringify({
          requests: [
            {
              image: { content: base64Image },
              features: [{ type: "TEXT_DETECTION", maxResults: 10 }],
            },
          ],
        }),
        cache: "no-store",
      }
    );

    const visionText = await visionResp.text();

    if (!visionResp.ok) {
      // Vision側のエラー本文も重要（403/billing等）
      throw new Error(
        `Vision API error ${visionResp.status}: ${visionText.slice(0, 1200)}`
      );
    }

    const visionData = (visionText ? JSON.parse(visionText) : {}) as VisionAnnotateResponse;
    const first = visionData.responses?.[0];

    if (first?.error?.message) {
      throw new Error(`Vision response error: ${first.error.message}`);
    }

    const rawText =
      first?.fullTextAnnotation?.text ||
      first?.textAnnotations?.[0]?.description ||
      "";

    const { normalizedText, candidates } = extractDigitsCandidates(rawText);

    const ms = Date.now() - started;
    console.log("[GOOGLE_OCR_OK]", {
      ms,
      bytes: file.size,
      candidatesCount: candidates.length,
    });

    return NextResponse.json({
      ok: true,
      rawText,
      normalizedText,
      candidates,
      bestCandidate: candidates[0] ?? null,
    });
  } catch (e) {
    const ms = Date.now() - started;

    // ここが重要：Vercel Logsで原因が必ず見える
    console.error("[GOOGLE_OCR_FATAL]", { ms, error: e });

    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json(
      { ok: false, error: message },
      { status: 500 }
    );
  }
}
