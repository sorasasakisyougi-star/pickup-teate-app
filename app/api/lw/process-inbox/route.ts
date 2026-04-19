// Phase 2c manual drainer: POST /api/lw/process-inbox
// Pulls rows from lw_inbox where status='received', runs them through the
// parse→enrich→map→forward pipeline, and marks each row with its terminal
// status (forwarded / invalid / failed). No auto-polling yet.

import { NextRequest, NextResponse } from 'next/server';
import { createClient } from '@supabase/supabase-js';

import {
  listPendingInbox,
  markInboxStatus,
  type InboxRow,
} from '@/lib/lineworks/inbox';
import {
  createSupabaseEnrichClient,
  type EnrichDbClient,
} from '@/lib/lineworks/enrich';
import { forwardToPowerAutomate } from '@/lib/lineworks/forward';
import type { V1Payload } from '@/lib/lineworks/mapper';
import { processInboxRow, type ProcessOutcome } from '@/lib/lineworks/process';

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
};

function extractAdminKey(req: NextRequest): string {
  const header = req.headers.get('x-admin-key') || '';
  if (header) return header;
  const auth = req.headers.get('authorization') || '';
  return auth.startsWith('Bearer ') ? auth.slice('Bearer '.length) : '';
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
  if (extractAdminKey(req) !== expected) {
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
  let forwarded = 0;
  let invalid = 0;
  let failed = 0;

  for (const row of rows) {
    try {
      const outcome = await processInboxRow(row.raw_body, row.created_at, {
        db,
        forward: forwardPayload,
      });
      persistOutcome(row, outcome);
      details.push(rowResultFromOutcome(row.message_hash, outcome));
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
      processed: rows.length,
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
