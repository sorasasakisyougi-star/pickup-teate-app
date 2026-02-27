import { NextRequest, NextResponse } from "next/server";

export async function POST(req: NextRequest) {
  try {
    const body = await req.json();

    console.log("[/api/powerautomate] received body:", body);

    const webhookUrl = process.env.POWER_AUTOMATE_WEBHOOK_URL;
    if (!webhookUrl) {
      return NextResponse.json(
        { ok: false, error: "POWER_AUTOMATE_WEBHOOK_URL is not set" },
        { status: 500 }
      );
    }

    const r = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // 受けたものをそのまま送る（payloadで再ラップしない）
      body: JSON.stringify(body),
    });

    const text = await r.text();

    console.log("[/api/powerautomate] webhook status:", r.status);
    console.log("[/api/powerautomate] webhook response:", text);

    return NextResponse.json({
      ok: r.ok,
      status: r.status,
      responseText: text,
    });
  } catch (e: any) {
    console.error("[/api/powerautomate] error:", e);
    return NextResponse.json(
      { ok: false, error: e?.message ?? "unknown error" },
      { status: 500 }
    );
  }
}