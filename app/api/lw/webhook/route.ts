// POST /api/lw/webhook  — Phase 2b contract (fail-closed edition):
//   1. Verify X-WORKS-Signature (HMAC-SHA256 base64 over raw body)
//   2. Extract messageId (log + hash-only fallback when not extractable)
//   3. INSERT OR IGNORE into lw_inbox (keyed by sha256(rawBody))
//   4. Return 200 within 2s on success. insert failure → 503 (fail-closed).
//   NO Power Automate forwarding here — that's 2c.

import { NextRequest, NextResponse } from 'next/server';
import { verifySignature, sha256Hex } from '@/lib/lineworks/verify';
import { insertInbox } from '@/lib/lineworks/inbox';

// better-sqlite3 is native — force Node runtime, not Edge.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

type JsonObj = Record<string, unknown>;

function asObj(v: unknown): JsonObj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObj) : null;
}

function pickStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/**
 * Best-effort messageId extractor. LINE WORKS event shapes differ by event type,
 * so we probe several known paths before giving up. Callers MUST treat null as
 * "unknown id — dedup still works via sha256(rawBody)".
 */
export function extractMessageId(parsed: unknown): string | null {
  const root = asObj(parsed);
  if (!root) return null;
  const content = asObj(root.content);
  return (
    pickStr(root.messageId) ||
    pickStr(root.eventId) ||
    (content && pickStr(content.messageId)) ||
    (content && pickStr(content.eventId)) ||
    pickStr(root.id) ||
    null
  );
}

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

  let parsed: unknown = null;
  let eventType: string | null = null;
  try {
    parsed = JSON.parse(raw);
    const t = asObj(parsed)?.type;
    eventType = typeof t === 'string' ? t : null;
  } catch {
    eventType = 'non_json';
  }

  const hash = sha256Hex(raw);
  const messageId = extractMessageId(parsed);
  if (!messageId) {
    console.warn(
      `[lw/webhook] messageId not extractable — fallback to hash-only dedup (hash=${hash}, event_type=${eventType})`,
    );
  }

  try {
    const r = insertInbox({
      messageHash: hash,
      messageId,
      botId,
      eventType,
      rawBody: raw,
    });
    return NextResponse.json(
      {
        ok: true,
        hash,
        messageId,
        duplicate: !r.inserted,
        phase: '2b',
      },
      { status: 200 },
    );
  } catch (e) {
    // fail-closed: do NOT 200 on inbox failure — LINE WORKS must retry.
    console.error('[lw/webhook] inbox insert failed:', e);
    return NextResponse.json(
      { ok: false, error: 'inbox_insert_failed', hash },
      { status: 503 },
    );
  }
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: 'method_not_allowed' },
    { status: 405 },
  );
}
