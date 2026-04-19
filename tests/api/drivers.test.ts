// Phase 2d Step 0 fix: drivers admin route regressions.
// Covers the 6 minimum-repair items required before Phase 2d-1 can start:
//   1. GET without admin key → 401
//   2. GET with admin key → 200 (+ lineworks_user_id in payload)
//   3. POST invalid UUID → 400
//   4. POST duplicate lineworks_user_id → 409 (not 500)
//   5. PATCH invalid UUID → 400
//   6. PATCH duplicate lineworks_user_id → 409 (not 500)
//
// Also locks the UUID validator unit behaviour to catch typos at the
// client layer, mirroring the server SSOT.

import assert from 'node:assert/strict';
import test, { after } from 'node:test';

// The Supabase admin client throws at module-load time if env is absent, so
// set placeholders BEFORE the module graph imports it. `supabaseAdmin.ts`
// constructs the client but does not reach the network until a query runs.
process.env.SUPABASE_URL = 'https://fake.supabase.co';
process.env.SUPABASE_SERVICE_ROLE_KEY = 'fake-service-role-key';
process.env.ADMIN_KEY = 'test-admin-key';

import handler, {
  __setSupabaseForTests,
} from '../../pages/api/admin/drivers';
import { isValidUuid, UUID_INVALID_MESSAGE } from '../../lib/admin/uuid';

type FakeRes = {
  statusCode: number;
  body: unknown;
  status(code: number): FakeRes;
  json(b: unknown): FakeRes;
};

function makeRes(): FakeRes {
  const res: FakeRes = {
    statusCode: 200,
    body: null,
    status(code) {
      this.statusCode = code;
      return this;
    },
    json(b) {
      this.body = b;
      return this;
    },
  };
  return res;
}

function makeReq(
  method: string,
  body: Record<string, unknown> | undefined,
  headers: Record<string, string> = {},
) {
  return {
    method,
    body,
    headers,
    query: {},
  } as unknown as import('next').NextApiRequest;
}

type DriverRow = { id: number; name: string; lineworks_user_id: string | null };

/**
 * Minimal in-memory fake of the subset of Supabase's builder API that
 * drivers.ts exercises. Each .from(...) call returns a fresh chain so
 * calls don't bleed filters across each other.
 */
function makeFakeSupabase(rows: DriverRow[]) {
  let nextId = rows.reduce((max, r) => Math.max(max, r.id), 0) + 1;

  function buildBuilder() {
    let current: DriverRow[] = [...rows];
    let mutate:
      | { op: 'insert'; row: Partial<DriverRow> }
      | { op: 'update'; set: Partial<DriverRow> }
      | { op: 'delete' }
      | null = null;

    const api = {
      select(_cols: string) {
        return api;
      },
      order(_col: string, _opts: unknown) {
        return Promise.resolve({ data: current, error: null });
      },
      eq(col: keyof DriverRow, val: unknown) {
        current = current.filter((r) => r[col] === val);
        return api;
      },
      match(filter: Partial<DriverRow>) {
        current = current.filter((r) =>
          Object.entries(filter).every(([k, v]) => (r as Record<string, unknown>)[k] === v),
        );
        return api;
      },
      async maybeSingle() {
        if (mutate?.op === 'insert') {
          const row: DriverRow = {
            id: nextId++,
            name: (mutate.row as DriverRow).name,
            lineworks_user_id: (mutate.row as DriverRow).lineworks_user_id ?? null,
          };
          rows.push(row);
          return { data: row, error: null };
        }
        if (current.length === 0) return { data: null, error: null };
        return { data: current[0], error: null };
      },
      async single() {
        const r = await api.maybeSingle();
        if (!r.data) return { data: null, error: { message: 'not_found' } };
        return r;
      },
      insert(row: Partial<DriverRow>) {
        mutate = { op: 'insert', row };
        return api;
      },
      update(set: Partial<DriverRow>) {
        mutate = { op: 'update', set };
        return api;
      },
      delete() {
        mutate = { op: 'delete' };
        return api;
      },
    };
    return api;
  }

  return {
    from(_table: string) {
      return buildBuilder();
    },
  } as unknown as Parameters<typeof __setSupabaseForTests>[0];
}

after(() => {
  __setSupabaseForTests(null);
});

// --- 1. UUID validator ----------------------------------------------------

test('isValidUuid accepts 8-4-4-4-12 hex and rejects typos', () => {
  assert.equal(isValidUuid('c72af563-0f21-4736-11e4-045237113344'), true);
  assert.equal(isValidUuid('C72AF563-0F21-4736-11E4-045237113344'), true);
  assert.equal(isValidUuid('not-a-uuid'), false);
  assert.equal(isValidUuid(''), false);
  assert.equal(isValidUuid('c72af563-0f21-4736-11e4-04523711334'), false);
  assert.equal(isValidUuid(null), false);
  assert.equal(isValidUuid(undefined), false);
  assert.equal(isValidUuid(123), false);
});

// --- 2. GET auth ----------------------------------------------------------

test('GET without admin key → 401', async () => {
  __setSupabaseForTests(makeFakeSupabase([]));
  const req = makeReq('GET', undefined, {});
  const res = makeRes();
  await handler(req, res as unknown as import('next').NextApiResponse);
  assert.equal(res.statusCode, 401);
  const body = res.body as { error?: string };
  assert.equal(body.error, 'Unauthorized');
});

test('GET with admin key → 200 and returns lineworks_user_id', async () => {
  __setSupabaseForTests(
    makeFakeSupabase([
      { id: 1, name: '山田太郎', lineworks_user_id: 'c72af563-0f21-4736-11e4-045237113344' },
      { id: 2, name: '鈴木花子', lineworks_user_id: null },
    ]),
  );
  const req = makeReq('GET', undefined, { 'x-admin-key': 'test-admin-key' });
  const res = makeRes();
  await handler(req, res as unknown as import('next').NextApiResponse);
  assert.equal(res.statusCode, 200);
  const body = res.body as { items: DriverRow[] };
  assert.equal(body.items.length, 2);
  assert.equal(body.items[0].lineworks_user_id, 'c72af563-0f21-4736-11e4-045237113344');
  assert.equal(body.items[1].lineworks_user_id, null);
});

// --- 3. POST invalid UUID → 400 ------------------------------------------

test('POST invalid UUID → 400 with canonical error message', async () => {
  __setSupabaseForTests(makeFakeSupabase([]));
  const req = makeReq(
    'POST',
    { name: '佐藤次郎', lineworks_user_id: 'not-a-uuid' },
    { 'x-admin-key': 'test-admin-key' },
  );
  const res = makeRes();
  await handler(req, res as unknown as import('next').NextApiResponse);
  assert.equal(res.statusCode, 400);
  const body = res.body as { error: string };
  assert.equal(body.error, UUID_INVALID_MESSAGE);
});

// --- 4. POST duplicate UUID → 409 ----------------------------------------

test('POST duplicate lineworks_user_id → 409 (not 500)', async () => {
  __setSupabaseForTests(
    makeFakeSupabase([
      { id: 1, name: '既存者', lineworks_user_id: 'c72af563-0f21-4736-11e4-045237113344' },
    ]),
  );
  const req = makeReq(
    'POST',
    {
      name: '新人',
      lineworks_user_id: 'c72af563-0f21-4736-11e4-045237113344',
    },
    { 'x-admin-key': 'test-admin-key' },
  );
  const res = makeRes();
  await handler(req, res as unknown as import('next').NextApiResponse);
  assert.equal(res.statusCode, 409);
  const body = res.body as { error: string };
  assert.ok(body.error.includes('LINE WORKS ユーザーID'));
});

// --- 5. PATCH invalid UUID → 400 -----------------------------------------

test('PATCH invalid UUID → 400', async () => {
  __setSupabaseForTests(
    makeFakeSupabase([{ id: 1, name: '山田太郎', lineworks_user_id: null }]),
  );
  const req = makeReq(
    'PATCH',
    { id: 1, lineworks_user_id: 'typo' },
    { 'x-admin-key': 'test-admin-key' },
  );
  const res = makeRes();
  await handler(req, res as unknown as import('next').NextApiResponse);
  assert.equal(res.statusCode, 400);
  const body = res.body as { error: string };
  assert.equal(body.error, UUID_INVALID_MESSAGE);
});

// --- 6. PATCH duplicate UUID → 409 ---------------------------------------

test('PATCH duplicate lineworks_user_id → 409 (not 500)', async () => {
  __setSupabaseForTests(
    makeFakeSupabase([
      { id: 1, name: '既存者', lineworks_user_id: 'c72af563-0f21-4736-11e4-045237113344' },
      { id: 2, name: '対象者', lineworks_user_id: null },
    ]),
  );
  const req = makeReq(
    'PATCH',
    { id: 2, lineworks_user_id: 'c72af563-0f21-4736-11e4-045237113344' },
    { 'x-admin-key': 'test-admin-key' },
  );
  const res = makeRes();
  await handler(req, res as unknown as import('next').NextApiResponse);
  assert.equal(res.statusCode, 409);
  const body = res.body as { error: string };
  assert.ok(body.error.includes('LINE WORKS ユーザーID'));
});
