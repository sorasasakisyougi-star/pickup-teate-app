// POST /api/lw/webhook  — Phase 2b contract:
//   1. Verify X-WORKS-Signature (HMAC-SHA256 base64 over raw body)
//   2. INSERT OR IGNORE into lw_inbox (keyed by sha256(rawBody))
//   3. Return 200 within 2s. NO Power Automate forwarding here — that's 2c.

import { NextRequest, NextResponse } from 'next/server';
import { verifySignature, sha256Hex } from '@/lib/lineworks/verify';
import { insertInbox } from '@/lib/lineworks/inbox';

// better-sqlite3 is native — force Node runtime, not Edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

export async function POST(req: NextRequest) {
  const raw = await req.text();
  const signature = req.headers.get('x-works-signature') || '';
  const secret = process.env.LW_BOT_SECRET || '';
  const botId = process.env.LW_BOT_ID || 'unknown';

  if (!secret) {
    console.error('[lw/webhook] LW_BOT_SECRET not set — refusing');
    return NextResponse.json(
      { ok: false, error: 'bot_secret_missing' },
      { status: 503 },
    );
  }

  if (!verifySignature(raw, signature, secret)) {
    console.warn('[lw/webhook] signature verification failed');
    return NextResponse.json(
      { ok: false, error: 'invalid_signature' },
      { status: 401 },
    );
  }

  let eventType: string | null = null;
  try {
    const parsed = JSON.parse(raw);
    eventType = typeof parsed?.type === 'string' ? parsed.type : null;
  } catch {
    eventType = 'non_json';
  }

  const hash = sha256Hex(raw);
  let inserted = false;
  try {
    const r = insertInbox({
      messageHash: hash,
      botId,
      eventType,
      rawBody: raw,
    });
    inserted = r.inserted;
  } catch (e) {
    console.error('[lw/webhook] inbox insert failed:', e);
    return NextResponse.json(
      { ok: true, error: 'inbox_insert_failed', hash },
      { status: 200 },
    );
  }

  return NextResponse.json(
    { ok: true, hash, duplicate: !inserted, phase: '2b' },
    { status: 200 },
  );
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: 'method_not_allowed' },
    { status: 405 },
  );
}
