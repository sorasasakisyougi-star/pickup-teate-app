// Phase 2c manual drainer: POST /api/lw/process-inbox
// Pulls rows from lw_inbox where status='received', runs them through the
// parse→enrich→map→forward pipeline, and marks each row with its terminal
// status (forwarded / invalid / failed). No auto-polling yet.

import crypto from 'node:crypto';

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import {
  listPendingInbox,
  markInboxStatus,
  claimInboxRow,
  type InboxRow,
} from '@/lib/lineworks/inbox';
import {
  createSupabaseEnrichClient,
  type EnrichDbClient,
} from '@/lib/lineworks/enrich';
import { forwardToPowerAutomate } from '@/lib/lineworks/forward';
import type { V1Payload } from '@/lib/lineworks/mapper';
import { processInboxRow, type ProcessOutcome } from '@/lib/lineworks/process';
import { createBotClientFromEnv, type BotClient } from '@/lib/lineworks/botClient';

// better-sqlite3 + Supabase client require Node runtime.
export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const DEFAULT_BATCH_LIMIT = 10;
const MAX_BATCH_LIMIT = 100;

type RowResult = {
  messageHash: string;
  terminal: 'forwarded' | 'invalid' | 'failed';
  code?: string;
  error?: string;
  userMessage?: string;
  attempts?: number;
  replyStatus?: 'sent' | 'skipped' | 'failed' | 'disabled';
  replyError?: string;
};

const FORWARDED_REPLY_TEXT = '送迎記録を登録しました';

/**
 * What to say back to the sender (if anything). `failed` is intentionally
 * silent — we log the error server-side but don't spam the driver while
 * we debug. `invalid` with an empty userMessage (e.g. not_a_soutei_message)
 * also stays silent.
 */
function computeReplyText(outcome: ProcessOutcome): string | null {
  if (outcome.terminal === 'forwarded') return FORWARDED_REPLY_TEXT;
  if (outcome.terminal === 'invalid' && outcome.userMessage.length > 0) {
    return outcome.userMessage;
  }
  return null;
}

/**
 * Fire-and-forget-ish Bot reply. Reply failure is logged but MUST NOT
 * roll back the inbox status — persistence already recorded the terminal
 * result from the Power Automate forwarding path, which is the source
 * of truth for the pipeline.
 */
async function tryReply(
  botClient: BotClient | null,
  outcome: ProcessOutcome,
  detail: RowResult,
): Promise<void> {
  if (!botClient) {
    detail.replyStatus = 'disabled';
    return;
  }
  if (!outcome.senderUserId) {
    detail.replyStatus = 'skipped';
    return;
  }
  const text = computeReplyText(outcome);
  if (!text) {
    detail.replyStatus = 'skipped';
    return;
  }
  const result = await botClient.sendText(outcome.senderUserId, text);
  if (result.ok) {
    detail.replyStatus = 'sent';
  } else {
    detail.replyStatus = 'failed';
    detail.replyError = result.error;
    console.warn(
      '[lw/process-inbox] reply failed (inbox status preserved):',
      detail.messageHash,
      result.error,
    );
  }
}

function extractAdminKey(req: NextRequest): string {
  const header = req.headers.get('x-admin-key') || '';
  if (header) return header;
  const auth = req.headers.get('authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
}

/**
 * Length-agnostic timing-safe comparison. Returns false fast on length
 * mismatch (leaking only the length of `expected`, which is a constant)
 * and otherwise runs constant-time on equal-length buffers.
 */
function constantTimeEqual(actual: string, expected: string): boolean {
  const a = Buffer.from(actual, 'utf8');
  const b = Buffer.from(expected, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

function getSupabaseUrl(): string {
  return (
    process.env.SUPABASE_URL?.trim() ||
    process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() ||
    ''
  );
}

function buildEnrichDb(): EnrichDbClient {
  const url = getSupabaseUrl();
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY?.trim() || '';
  if (!url) throw new Error('supabase_url_missing');
  if (!serviceKey) throw new Error('supabase_service_role_key_missing');
  const supabase = createClient(url, serviceKey, {
    auth: { persistSession: false },
  });
  return createSupabaseEnrichClient(supabase);
}

function rowResultFromOutcome(hash: string, outcome: ProcessOutcome): RowResult {
  if (outcome.terminal === 'forwarded') {
    return {
      messageHash: hash,
      terminal: 'forwarded',
      attempts: outcome.attempts,
    };
  }
  if (outcome.terminal === 'invalid') {
    return {
      messageHash: hash,
      terminal: 'invalid',
      code: outcome.code,
      userMessage: outcome.userMessage,
    };
  }
  return {
    messageHash: hash,
    terminal: 'failed',
    error: outcome.error,
    attempts: outcome.attempts,
  };
}

function persistOutcome(row: InboxRow, outcome: ProcessOutcome): void {
  if (outcome.terminal === 'forwarded') {
    markInboxStatus({
      messageHash: row.message_hash,
      status: 'forwarded',
      receiptId: outcome.receiptId,
    });
  } else if (outcome.terminal === 'invalid') {
    markInboxStatus({
      messageHash: row.message_hash,
      status: 'invalid',
      errorMessage: outcome.code,
    });
  } else {
    markInboxStatus({
      messageHash: row.message_hash,
      status: 'failed',
      errorMessage: outcome.error,
    });
  }
}

async function forwardPayload(payload: V1Payload) {
  return forwardToPowerAutomate(payload);
}

export async function POST(req: NextRequest) {
  const expected = process.env.ADMIN_KEY?.trim() || '';
  if (!expected) {
    console.error('[lw/process-inbox] ADMIN_KEY not configured — refusing');
    return NextResponse.json(
      { ok: false, error: 'admin_key_not_configured' },
      { status: 503 },
    );
  }
  if (!constantTimeEqual(extractAdminKey(req), expected)) {
    return NextResponse.json({ ok: false, error: 'unauthorized' }, { status: 401 });
  }

  let limit = DEFAULT_BATCH_LIMIT;
  const body = (await req.json().catch(() => ({}))) as { limit?: number };
  if (typeof body?.limit === 'number' && Number.isFinite(body.limit)) {
    limit = Math.max(1, Math.min(MAX_BATCH_LIMIT, Math.floor(body.limit)));
  }

  let db: EnrichDbClient;
  try {
    db = buildEnrichDb();
  } catch (e) {
    console.error('[lw/process-inbox] supabase client unavailable:', e);
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'supabase_unavailable' },
      { status: 503 },
    );
  }

  const rows = listPendingInbox(limit);
  const details: RowResult[] = [];
  const botClient = createBotClientFromEnv();
  let processed = 0;
  let skipped = 0;
  let forwarded = 0;
  let invalid = 0;
  let failed = 0;

  for (const row of rows) {
    // Atomically transition 'received' → 'processing'. If another worker got
    // the row first, claim fails and we skip — no double-processing.
    if (!claimInboxRow(row.message_hash)) {
      skipped++;
      continue;
    }
    processed++;
    try {
      const outcome = await processInboxRow(row.raw_body, row.created_at, {
        db,
        forward: forwardPayload,
      });
      persistOutcome(row, outcome);
      const detail = rowResultFromOutcome(row.message_hash, outcome);
      // Reply is a pure side effect; its outcome is attached to `detail`
      // but NEVER mutates persisted inbox status.
      await tryReply(botClient, outcome, detail);
      details.push(detail);
      if (outcome.terminal === 'forwarded') forwarded++;
      else if (outcome.terminal === 'invalid') invalid++;
      else failed++;
    } catch (e) {
      console.error('[lw/process-inbox] unexpected error for', row.message_hash, e);
      const msg = e instanceof Error ? e.message : 'unexpected_error';
      markInboxStatus({
        messageHash: row.message_hash,
        status: 'failed',
        errorMessage: msg,
      });
      failed++;
      details.push({
        messageHash: row.message_hash,
        terminal: 'failed',
        error: msg,
      });
    }
  }

  return NextResponse.json(
    {
      ok: true,
      processed,
      skipped,
      forwarded,
      invalid,
      failed,
      details,
    },
    { status: 200 },
  );
}

export async function GET() {
  return NextResponse.json(
    { ok: false, error: 'method_not_allowed' },
    { status: 405 },
  );
}
