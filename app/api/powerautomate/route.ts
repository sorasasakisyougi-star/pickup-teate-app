import { NextResponse } from "next/server";

type FlowPayload = Record<string, string | number>;

function mustString(v: unknown): string {
  if (typeof v === "string") return v;
  return "";
}
function mustNumber(v: unknown): number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  return 0;
}

/**
 * ここでは「Excel列名（日本語キー）」が必ず揃っていることを保証する
 * null/undefined を絶対に外へ出さない（Parse JSON落ち対策）
 */
function normalizeExcelPayload(input: any): FlowPayload {
  const o = input ?? {};

  return {
    "日付": mustString(o["日付"]),
    "運転者": mustString(o["運転者"]),
    "出発地": mustString(o["出発地"]),
    "到着１": mustString(o["到着１"]),
    "到着２": mustString(o["到着２"]),
    "到着３": mustString(o["到着３"]),
    "到着４": mustString(o["到着４"]),
    "到着５": mustString(o["到着５"]),
    "バス": mustString(o["バス"]),
    "金額（円）": mustNumber(o["金額（円）"]),
    "距離（始）": mustNumber(o["距離（始）"]),
    "距離（到着１）": mustNumber(o["距離（到着１）"]),
    "距離（到着２）": mustNumber(o["距離（到着２）"]),
    "距離（到着３）": mustNumber(o["距離（到着３）"]),
    "距離（到着４）": mustNumber(o["距離（到着４）"]),
    "距離（到着５）": mustNumber(o["距離（到着５）"]),
    "走行距離（km）": mustNumber(o["走行距離（km）"]),
    "出発写真URL": mustString(o["出発写真URL"]),
    "到着写真URL到着１": mustString(o["到着写真URLto着１"] ?? o["到着写真URL到着１"]), // 事故保険
    "到着写真URLto着１": undefined as any, // 送らない（念のため）
    "到着写真URL到着２": mustString(o["到着写真URL到着２"]),
    "到着写真URL到着３": mustString(o["到着写真URL到着３"]),
    "到着写真URL到着４": mustString(o["到着写真URL到着４"]),
    "到着写真URLto着４": undefined as any,
    "到着写真URLto着３": undefined as any,
    "到着写真URLto着２": undefined as any,
    "到着写真URLto着５": undefined as any,
    "到着写真URL到着５": mustString(o["到着写真URL到着５"]),
    "備考": mustString(o["備考"]),
  };
}

export async function POST(req: Request) {
  const webhook = process.env.POWER_AUTOMATE_WEBHOOK_URL;
  if (!webhook) {
    return NextResponse.json(
      { error: "POWER_AUTOMATE_WEBHOOK_URL is missing. Set it in .env.local" },
      { status: 500 },
    );
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON" }, { status: 400 });
  }

  // フロントからは { payload: { ...Excel列名... } } を送る想定
  const normalized = normalizeExcelPayload(body?.payload);

  // normalizeExcelPayloadが入れた「undefined保険」キーを除去
  for (const k of Object.keys(normalized)) {
    if ((normalized as any)[k] === undefined) delete (normalized as any)[k];
  }

  try {
    const res = await fetch(webhook, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(normalized),
    });

    const text = await res.text().catch(() => "");
    if (!res.ok) {
      return NextResponse.json(
        { error: "Power Automate webhook failed", status: res.status, body: text },
        { status: 502 },
      );
    }

    return NextResponse.json({ ok: true, upstream: text });
  } catch (e: any) {
    return NextResponse.json(
      { error: "Failed to call Power Automate", detail: String(e?.message ?? e) },
      { status: 502 },
    );
  }
}