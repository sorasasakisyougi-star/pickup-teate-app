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
  return raw.replace(/\\n/g, "\n");
}

async function getGoogleAccessToken() {
  const clientEmail = getRequiredEnv("GOOGLE_CLIENT_EMAIL");
  const privateKey = normalizePrivateKey(getRequiredEnv("GOOGLE_PRIVATE_KEY"));
  const tokenUri =
    process.env.GOOGLE_TOKEN_URI || "https://oauth2.googleapis.com/token";

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

  const signer = crypto.createSign("RSA-SHA256");
  signer.update(unsigned);
  signer.end();
  const signature = signer.sign(privateKey);

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

  if (!resp.ok) {
    const text = await resp.text();
    throw new Error(`Token error ${resp.status}: ${text}`);
  }

  const data = (await resp.json()) as { access_token?: string };
  if (!data.access_token) {
    throw new Error("No access_token returned from Google OAuth");
  }
  return data.access_token;
}

function extractDigitsCandidates(text: string) {
  const z2h = (s: string) =>
    s.replace(/[０-９]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
    );

  const normalized = z2h(text)
    .replace(/[OoＯｏ]/g, "0")
    .replace(/[IlIｌ｜]/g, "1");

  const matches = normalized.match(/\d{4,8}/g) ?? [];

  return {
    normalizedText: normalized,
    candidates: Array.from(new Set(matches)),
  };
}

export async function POST(req: Request) {
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

    const accessToken = await getGoogleAccessToken();

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

    if (!visionResp.ok) {
      const text = await visionResp.text();
      return NextResponse.json(
        {
          ok: false,
          error: `Vision API error ${visionResp.status}`,
          detail: text,
        },
        { status: 502 }
      );
    }

    const visionData = (await visionResp.json()) as VisionAnnotateResponse;
    const first = visionData.responses?.[0];

    if (first?.error?.message) {
      return NextResponse.json(
        { ok: false, error: first.error.message },
        { status: 502 }
      );
    }

    const rawText =
      first?.fullTextAnnotation?.text ||
      first?.textAnnotations?.[0]?.description ||
      "";

    const { normalizedText, candidates } = extractDigitsCandidates(rawText);

    return NextResponse.json({
      ok: true,
      rawText,
      normalizedText,
      candidates,
      bestCandidate: candidates[0] ?? null,
    });
  } catch (e) {
    const message = e instanceof Error ? e.message : "Unknown error";
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}
