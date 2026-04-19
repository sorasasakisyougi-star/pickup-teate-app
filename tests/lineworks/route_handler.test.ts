// Direct handler invocation test for POST /api/lw/webhook.
// Bypasses `next dev`, which has a pre-existing App/Pages router collision
// on /api/powerautomate unrelated to Phase 2b.
//
// Run with: npx tsx --test tests/lineworks/route_handler.test.ts
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NextRequest } from 'next/server';

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-route-'));
  return path.join(dir, 'test.db');
}

function sign(body: string, secret: string): string {
  return crypto.createHmac('sha256', secret).update(body, 'utf8').digest('base64');
}

async function loadRoute() {
  const mod = await import('../../app/api/lw/webhook/route');
  return mod as { POST: (req: NextRequest) => Promise<Response>; GET: () => Promise<Response> };
}

function makeReq(body: string, headers: Record<string, string>): NextRequest {
  const req = new Request('http://localhost/api/lw/webhook', {
    method: 'POST',
    headers,
    body,
  });
  return req as unknown as NextRequest;
}

test('POST returns 200 with valid signature and inserts to inbox', async () => {
  const dbPath = tempDbPath();
  process.env.LW_INBOX_DB_PATH = dbPath;
  process.env.LW_BOT_SECRET = 'secret-phase2b-1';
  process.env.LW_BOT_ID = 'bot-pickup-test';

  const { POST } = await loadRoute();
  const body = JSON.stringify({ type: 'message', content: { text: 'hello' } });
  const res = await POST(makeReq(body, {
    'content-type': 'application/json',
    'x-works-signature': sign(body, process.env.LW_BOT_SECRET!),
  }));
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.duplicate, false);
  assert.equal(json.phase, '2b');
  assert.match(json.hash, /^[0-9a-f]{64}$/);
});

test('POST returns 401 on invalid signature', async () => {
  process.env.LW_INBOX_DB_PATH = tempDbPath();
  process.env.LW_BOT_SECRET = 'secret-phase2b-2';
  const { POST } = await loadRoute();
  const body = '{"type":"message"}';
  const res = await POST(makeReq(body, {
    'x-works-signature': 'd3Jvbmctc2ln',
  }));
  assert.equal(res.status, 401);
  const json = await res.json();
  assert.equal(json.ok, false);
  assert.equal(json.error, 'invalid_signature');
});

test('POST returns duplicate:true on byte-identical replay', async () => {
  process.env.LW_INBOX_DB_PATH = tempDbPath();
  process.env.LW_BOT_SECRET = 'secret-phase2b-3';
  process.env.LW_BOT_ID = 'bot-pickup-test';
  const { POST } = await loadRoute();
  const body = JSON.stringify({ type: 'message', seq: 7 });
  const sig = sign(body, process.env.LW_BOT_SECRET!);

  const r1 = await POST(makeReq(body, { 'x-works-signature': sig }));
  const r2 = await POST(makeReq(body, { 'x-works-signature': sig }));
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  const j1 = await r1.json();
  const j2 = await r2.json();
  assert.equal(j1.duplicate, false);
  assert.equal(j2.duplicate, true);
  assert.equal(j1.hash, j2.hash);
});

test('POST returns 503 when LW_BOT_SECRET missing', async () => {
  process.env.LW_INBOX_DB_PATH = tempDbPath();
  delete process.env.LW_BOT_SECRET;
  const { POST } = await loadRoute();
  const res = await POST(makeReq('{}', { 'x-works-signature': 'x' }));
  assert.equal(res.status, 503);
  const json = await res.json();
  assert.equal(json.error, 'bot_secret_missing');
});

test('GET returns 405', async () => {
  const { GET } = await loadRoute();
  const res = await GET();
  assert.equal(res.status, 405);
});
