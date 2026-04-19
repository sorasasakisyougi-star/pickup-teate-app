// Direct handler invocation tests for POST /api/lw/process-inbox.
// Covers auth + config gates + empty-inbox happy path. The full
// parse→enrich→map→forward pipeline is exercised by process.test.ts — here
// we only prove the HTTP layer wires auth, config, and DB access correctly.

import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import { NextRequest } from 'next/server';

function tempDbPath(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lw-proc-route-'));
  return path.join(dir, 'test.db');
}

async function loadRoute() {
  const mod = await import('../../app/api/lw/process-inbox/route');
  return mod as {
    POST: (req: NextRequest) => Promise<Response>;
    GET: () => Promise<Response>;
  };
}

function makeReq(headers: Record<string, string>, body: string = '{}'): NextRequest {
  const req = new Request('http://localhost/api/lw/process-inbox', {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body,
  });
  return req as unknown as NextRequest;
}

function setStandardEnv() {
  process.env.ADMIN_KEY = 'test-admin-key';
  process.env.SUPABASE_URL = 'https://fake.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
  process.env.LW_INBOX_DB_PATH = tempDbPath();
}

test('POST 503 when ADMIN_KEY not configured', async () => {
  delete process.env.ADMIN_KEY;
  const { POST } = await loadRoute();
  const res = await POST(makeReq({}));
  assert.equal(res.status, 503);
  const json = await res.json();
  assert.equal(json.error, 'admin_key_not_configured');
});

test('POST 401 when admin key missing', async () => {
  setStandardEnv();
  const { POST } = await loadRoute();
  const res = await POST(makeReq({}));
  assert.equal(res.status, 401);
  const json = await res.json();
  assert.equal(json.error, 'unauthorized');
});

test('POST 401 when admin key wrong', async () => {
  setStandardEnv();
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ 'x-admin-key': 'wrong' }));
  assert.equal(res.status, 401);
});

test('POST accepts Bearer authorization header', async () => {
  setStandardEnv();
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ authorization: 'Bearer test-admin-key' }));
  assert.equal(res.status, 200);
});

test('POST 503 when SUPABASE_URL missing', async () => {
  setStandardEnv();
  delete process.env.SUPABASE_URL;
  delete process.env.NEXT_PUBLIC_SUPABASE_URL;
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ 'x-admin-key': 'test-admin-key' }));
  assert.equal(res.status, 503);
  const json = await res.json();
  assert.equal(json.error, 'supabase_url_missing');
});

test('POST 503 when SUPABASE_SERVICE_ROLE_KEY missing', async () => {
  setStandardEnv();
  delete process.env.SUPABASE_SERVICE_ROLE_KEY;
  const { POST } = await loadRoute();
  const res = await POST(makeReq({ 'x-admin-key': 'test-admin-key' }));
  assert.equal(res.status, 503);
  const json = await res.json();
  assert.equal(json.error, 'supabase_service_role_key_missing');
});

test('POST 200 with zeros when inbox is empty', async () => {
  setStandardEnv();
  const { POST } = await loadRoute();
  const res = await POST(
    makeReq({ 'x-admin-key': 'test-admin-key' }, JSON.stringify({ limit: 5 })),
  );
  assert.equal(res.status, 200);
  const json = await res.json();
  assert.equal(json.ok, true);
  assert.equal(json.processed, 0);
  assert.equal(json.skipped, 0);
  assert.equal(json.forwarded, 0);
  assert.equal(json.invalid, 0);
  assert.equal(json.failed, 0);
  assert.deepEqual(json.details, []);
});

test('POST 200 with clamped limit when body.limit > MAX', async () => {
  setStandardEnv();
  const { POST } = await loadRoute();
  const res = await POST(
    makeReq({ 'x-admin-key': 'test-admin-key' }, JSON.stringify({ limit: 99999 })),
  );
  assert.equal(res.status, 200);
});

test('POST 200 with bad body JSON falls back to default limit', async () => {
  setStandardEnv();
  const { POST } = await loadRoute();
  const req = new Request('http://localhost/api/lw/process-inbox', {
    method: 'POST',
    headers: { 'x-admin-key': 'test-admin-key' },
    body: 'not-json',
  });
  const res = await POST(req as unknown as NextRequest);
  assert.equal(res.status, 200);
});

test('GET 405', async () => {
  const { GET } = await loadRoute();
  const res = await GET();
  assert.equal(res.status, 405);
});
