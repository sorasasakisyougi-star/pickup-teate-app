import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import test from "node:test";

import type { NextApiRequest, NextApiResponse } from "next";

import powerAutomateHandler, {
  __setCreateSupabaseClientForTests,
  __setSendPowerAutomateForTests,
} from "../../pages/api/powerautomate.ts";
import { SESSION_COOKIE_NAME } from "../../lib/auth/cookies.ts";
import { createSessionToken } from "../../lib/auth/session.ts";

const POWER_AUTOMATE_ENV_KEYS = [
  "NEXT_PUBLIC_SUPABASE_URL",
  "NEXT_PUBLIC_SUPABASE_ANON_KEY",
  "SUPABASE_URL",
  "SUPABASE_SERVICE_ROLE_KEY",
  "POWER_AUTOMATE_WEBHOOK_URL",
  "ADMIN_KEY",
  "AUTH_SESSION_SECRET",
  "APP_ORIGIN",
  "AUTH_OPERATOR_EMAILS",
  "AUTH_ADMIN_EMAILS",
] as const;

type JsonRecord = Record<string, unknown>;

type PickupOrderStub = {
  id: string;
  driver_name: string;
  vehicle_name: string;
  is_bus: boolean;
  from_id: number | null;
  to_id: number | null;
  to1_id: number | null;
  to2_id: number | null;
  to3_id: number | null;
  to4_id: number | null;
  to5_id: number | null;
  to6_id: number | null;
  to7_id: number | null;
  amount_yen: number;
  report_at: string;
  depart_odometer_km: number;
  arrive_odometer_km: number;
  arrive1_odometer_km: number | null;
  arrive2_odometer_km: number | null;
  arrive3_odometer_km: number | null;
  arrive4_odometer_km: number | null;
  arrive5_odometer_km: number | null;
  arrive6_odometer_km: number | null;
  arrive7_odometer_km: number | null;
  depart_photo_url: string | null;
  arrive_photo_url: string | null;
  arrive1_photo_url: string | null;
  arrive2_photo_url: string | null;
  arrive3_photo_url: string | null;
  arrive4_photo_url: string | null;
  arrive5_photo_url: string | null;
  arrive6_photo_url: string | null;
  arrive7_photo_url: string | null;
};

type LocationStub = {
  id: number;
  name: string;
};

type RideLogStub = {
  id: string;
  status: string;
  notes: string | null;
  employee_name: string;
};

type SupabaseStubOptions = {
  order?: PickupOrderStub | null;
  locations?: LocationStub[];
  drivers?: Array<{ id: number; name: string }>;
  vehicles?: Array<{ id: number; name: string }>;
  rideLogs?: RideLogStub[];
  nextRideLogId?: string;
  orderQueryError?: boolean;
  locationQueryError?: boolean;
  rideLogQueryError?: boolean;
  rideLogUpdateError?: boolean;
  rideLogUpdateErrorStatus?: string;
};

function isUuidLike(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}

function buildDeliveryNotes(
  orderId: string,
  status: string,
  extraTokens: string[] = [],
) {
  return [
    "kind:power_automate_delivery",
    `power_automate_order:${orderId}`,
    `status:${status}`,
    ...extraTokens,
  ].join(";");
}

function createRideLogStub(
  orderId: string,
  status: string,
  overrides: Partial<RideLogStub> = {},
): RideLogStub {
  return {
    id: overrides.id ?? "11111111-1111-1111-1111-111111111111",
    status,
    notes:
      overrides.notes ??
      buildDeliveryNotes(orderId, status),
    employee_name: overrides.employee_name ?? "運転者A",
  };
}

function findRideLogByOrderId(rideLogs: Map<string, RideLogStub>, orderId: string) {
  const marker = `power_automate_order:${orderId}`;
  for (const row of rideLogs.values()) {
    if (typeof row.notes === "string" && row.notes.includes(marker)) {
      return row;
    }
  }
  return null;
}

function createPickupOrderStub(overrides: Partial<PickupOrderStub> = {}): PickupOrderStub {
  return {
    id: "order-1",
    driver_name: "運転者A",
    vehicle_name: "車両A",
    is_bus: false,
    from_id: 1,
    to_id: 2,
    to1_id: null,
    to2_id: null,
    to3_id: null,
    to4_id: null,
    to5_id: null,
    to6_id: null,
    to7_id: null,
    amount_yen: 1400,
    report_at: "2026-04-07T03:45:00.000Z",
    depart_odometer_km: 100,
    arrive_odometer_km: 121,
    arrive1_odometer_km: null,
    arrive2_odometer_km: null,
    arrive3_odometer_km: null,
    arrive4_odometer_km: null,
    arrive5_odometer_km: null,
    arrive6_odometer_km: null,
    arrive7_odometer_km: null,
    depart_photo_url: "https://photo.example.com/depart.jpg",
    arrive_photo_url: "https://photo.example.com/arrive.jpg",
    arrive1_photo_url: null,
    arrive2_photo_url: null,
    arrive3_photo_url: null,
    arrive4_photo_url: null,
    arrive5_photo_url: null,
    arrive6_photo_url: null,
    arrive7_photo_url: null,
    ...overrides,
  };
}

function createLocationStubs(count: number): LocationStub[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: index + 1,
    name: `地点${index + 1}`,
  }));
}

function createSequentialArrivalOrder(arrivalCount: number): PickupOrderStub {
  const locationColumns = [
    "to_id",
    "to1_id",
    "to2_id",
    "to3_id",
    "to4_id",
    "to5_id",
    "to6_id",
    "to7_id",
  ] as const;
  const odometerColumns = [
    "arrive_odometer_km",
    "arrive1_odometer_km",
    "arrive2_odometer_km",
    "arrive3_odometer_km",
    "arrive4_odometer_km",
    "arrive5_odometer_km",
    "arrive6_odometer_km",
    "arrive7_odometer_km",
  ] as const;
  const photoColumns = [
    "arrive_photo_url",
    "arrive1_photo_url",
    "arrive2_photo_url",
    "arrive3_photo_url",
    "arrive4_photo_url",
    "arrive5_photo_url",
    "arrive6_photo_url",
    "arrive7_photo_url",
  ] as const;
  const segmentLengths = [10, 13, 12, 15, 14, 16, 17, 18];

  const order = createPickupOrderStub({
    amount_yen: 0,
    depart_photo_url: "https://photo.example.com/depart.jpg",
    arrive_photo_url: null,
  });

  let currentOdometer = 100;
  for (let index = 0; index < arrivalCount; index += 1) {
    currentOdometer += segmentLengths[index] ?? 10;
    order[locationColumns[index]] = index + 2;
    order[odometerColumns[index]] = currentOdometer;
    order[photoColumns[index]] = `https://photo.example.com/arrive-${index + 1}.jpg`;
  }

  return order;
}

function withPowerAutomateEnv(
  values: Partial<Record<(typeof POWER_AUTOMATE_ENV_KEYS)[number], string>>,
  fn: () => Promise<void> | void,
) {
  const previous = new Map<string, string | undefined>();
  for (const key of POWER_AUTOMATE_ENV_KEYS) {
    previous.set(key, process.env[key]);
  }

  process.env.NEXT_PUBLIC_SUPABASE_URL = "https://example.supabase.co";
  process.env.SUPABASE_URL = "https://example.supabase.co";
  process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY = "anon-test-key";
  process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-test-key";
  process.env.POWER_AUTOMATE_WEBHOOK_URL = "https://flow.example.com/hook";
  process.env.ADMIN_KEY = "admin-key-test";
  process.env.AUTH_SESSION_SECRET = "12345678901234567890123456789012";
  process.env.APP_ORIGIN = "https://pickup.example.com";
  process.env.AUTH_OPERATOR_EMAILS = "operator@example.com";
  process.env.AUTH_ADMIN_EMAILS = "admin@example.com";

  for (const [key, value] of Object.entries(values)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  return Promise.resolve()
    .then(() => fn())
    .finally(() => {
      __setCreateSupabaseClientForTests(null);
      __setSendPowerAutomateForTests(null);
      for (const key of POWER_AUTOMATE_ENV_KEYS) {
        const previousValue = previous.get(key);
        if (previousValue === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = previousValue;
        }
      }
    });
}

function createMockRequest({
  method = "POST",
  origin,
  cookie,
  body,
  query,
  adminKey,
  authorization,
}: {
  method?: string;
  origin?: string;
  cookie?: string;
  body?: unknown;
  query?: Record<string, string | string[]>;
  adminKey?: string;
  authorization?: string;
} = {}): NextApiRequest {
  return {
    method,
    body,
    query: query ?? {},
    headers: {
      origin,
      cookie,
      "x-admin-key": adminKey,
      authorization,
    },
    cookies: {},
  } as unknown as NextApiRequest;
}

function createMockResponse() {
  const headers = new Map<string, string | string[]>();

  const response = {
    statusCode: 200,
    jsonBody: undefined as JsonRecord | undefined,
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    setHeader(name: string, value: string | string[]) {
      headers.set(name.toLowerCase(), value);
      return response;
    },
    status(code: number) {
      response.statusCode = code;
      return response;
    },
    json(body: JsonRecord) {
      response.jsonBody = body;
      return response;
    },
  };

  return response as unknown as NextApiResponse & {
    statusCode: number;
    jsonBody: JsonRecord | undefined;
  };
}

function createSessionCookie(userId: string, email: string) {
  const token = createSessionToken({ userId, email });
  return {
    token,
    header: `${SESSION_COOKIE_NAME}=${encodeURIComponent(token)}`,
  };
}

function createSupabaseStub(options: SupabaseStubOptions = {}) {
  const order = options.order === undefined ? createPickupOrderStub() : options.order;

  const locations =
    options.locations ??
    [
      { id: 1, name: "地点1" },
      { id: 2, name: "地点2" },
    ];
  const drivers = options.drivers ?? [{ id: 10, name: "運転者A" }];
  const vehicles = options.vehicles ?? [{ id: 20, name: "車両A" }];
  const rideLogs = new Map<string, RideLogStub>(
    (options.rideLogs ?? []).map((log) => [log.id, { ...log }]),
  );
  let nextRideLogIdSequence = 1;
  const nextRideLogId =
    options.nextRideLogId ??
    "11111111-1111-1111-1111-000000000001";

  const client = {
    from(table: string) {
      if (table === "pickup_orders") {
        return {
          select() {
            const filters: Record<string, unknown> = {};
            return {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return this;
              },
              async maybeSingle() {
                if (options.orderQueryError) {
                  return { data: null, error: { message: "order query failed" } };
                }
                if (!order || filters.id !== order.id) {
                  return { data: null, error: null };
                }
                return { data: order, error: null };
              },
            };
          },
        };
      }

      if (table === "locations") {
        return {
          select() {
            const filters: Record<string, unknown> = {};
            return {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return this;
              },
              async maybeSingle() {
                if (options.locationQueryError) {
                  return { data: null, error: { message: "location query failed" } };
                }
                const data =
                  locations.find((location) => location.id === filters.id) ?? null;
                return { data, error: null };
              },
            };
          },
        };
      }

      if (table === "drivers") {
        return {
          select() {
            const filters: Record<string, unknown> = {};
            return {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return this;
              },
              async maybeSingle() {
                const data = drivers.find((driver) => driver.name === filters.name) ?? null;
                return { data, error: null };
              },
            };
          },
        };
      }

      if (table === "vehicles") {
        return {
          select() {
            const filters: Record<string, unknown> = {};
            return {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return this;
              },
              async maybeSingle() {
                const data = vehicles.find((vehicle) => vehicle.name === filters.name) ?? null;
                return { data, error: null };
              },
            };
          },
        };
      }

      if (table === "ride_logs") {
        return {
          select() {
            const filters: Record<string, unknown> = {};
            const execute = async () => {
              if (options.rideLogQueryError) {
                return { data: null, error: { message: "ride_log query failed" } };
              }
              if (typeof filters.id === "string") {
                if (!isUuidLike(filters.id)) {
                  return {
                    data: null,
                    error: {
                      message: `invalid input syntax for type uuid: "${filters.id}"`,
                      code: "22P02",
                    },
                  };
                }
                const data = rideLogs.get(filters.id) ?? null;
                return { data: data ? [data] : [], error: null };
              }
              if (typeof filters.notes_like === "string") {
                const needle = filters.notes_like.replaceAll("%", "");
                const data = Array.from(rideLogs.values()).filter((log) =>
                  typeof log.notes === "string" ? log.notes.includes(needle) : false,
                );
                return { data, error: null };
              }
              return { data: Array.from(rideLogs.values()), error: null };
            };

            const query = {
              eq(column: string, value: unknown) {
                filters[column] = value;
                return query;
              },
              like(column: string, value: unknown) {
                filters[`${column}_like`] = value;
                return query;
              },
              limit() {
                return query;
              },
              async maybeSingle() {
                const result = await execute();
                if (result.error) {
                  return { data: null, error: result.error };
                }
                const data = Array.isArray(result.data) ? result.data[0] ?? null : null;
                return { data, error: null };
              },
              then(
                resolve: (value: { data: RideLogStub[] | null; error: { message: string; code?: string } | null }) => unknown,
                reject?: (reason: unknown) => unknown,
              ) {
                return execute().then(resolve, reject);
              },
            };
            return query;
          },
          insert(payload: Record<string, unknown>) {
            return {
              select() {
                return {
                  async single() {
                    const id =
                      typeof payload.id === "string" && payload.id
                        ? payload.id
                        : options.nextRideLogId
                          ? options.nextRideLogId
                          : nextRideLogId.replace(/000001$/, String(nextRideLogIdSequence++).padStart(6, "0"));
                    if (rideLogs.has(id)) {
                      return { data: null, error: { code: "23505", message: "duplicate key" } };
                    }
                    const row: RideLogStub = {
                      id,
                      status: typeof payload.status === "string" ? payload.status : "",
                      notes: typeof payload.notes === "string" ? payload.notes : null,
                      employee_name:
                        typeof payload.employee_name === "string" ? payload.employee_name : "",
                    };
                    rideLogs.set(id, row);
                    return { data: { id: row.id, status: row.status }, error: null };
                  },
                };
              },
            };
          },
          update(payload: Record<string, unknown>) {
            return {
              eq(column: string, value: unknown) {
                const id = column === "id" && typeof value === "string" ? value : "";
                return {
                  select() {
                    return {
                      async single() {
                        if (
                          options.rideLogUpdateError ||
                          (typeof options.rideLogUpdateErrorStatus === "string" &&
                            options.rideLogUpdateErrorStatus === payload.status)
                        ) {
                          return { data: null, error: { message: "ride_log update failed" } };
                        }
                        const current = rideLogs.get(id);
                        if (!current) {
                          return { data: null, error: { message: "ride_log missing" } };
                        }
                        const next: RideLogStub = {
                          ...current,
                          status:
                            typeof payload.status === "string" ? payload.status : current.status,
                          notes:
                            typeof payload.notes === "string"
                              ? payload.notes
                              : payload.notes === null
                                ? null
                                : current.notes,
                          employee_name:
                            typeof payload.employee_name === "string"
                              ? payload.employee_name
                              : current.employee_name,
                        };
                        rideLogs.set(id, next);
                        return { data: { id: next.id, status: next.status }, error: null };
                      },
                    };
                  },
                };
              },
            };
          },
        };
      }

      throw new Error(`unexpected table: ${table}`);
    },
  };

  return {
    client,
    rideLogs,
  };
}

test("powerautomate route rejects unsupported method", async () => {
  await withPowerAutomateEnv({}, async () => {
    const req = createMockRequest({ method: "DELETE" });
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 405);
    assert.equal(res.jsonBody?.error, "method_not_allowed");
    assert.equal(res.getHeader("cache-control"), "no-store");
  });
});

test("powerautomate route rejects untrusted origin", async () => {
  await withPowerAutomateEnv({}, async () => {
    const { token, header } = createSessionCookie("admin-1", "admin@example.com");
    const req = createMockRequest({
      method: "POST",
      origin: "https://evil.example.com",
      cookie: header,
      body: { order_id: "order-1" },
    });
    req.cookies = { [SESSION_COOKIE_NAME]: token };
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 403);
    assert.equal(res.jsonBody?.error, "forbidden_origin");
  });
});

test("powerautomate route rejects missing session", async () => {
  await withPowerAutomateEnv({}, async () => {
    const req = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      body: { order_id: "order-1" },
    });
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 401);
    assert.equal(res.jsonBody?.error, "unauthorized");
  });
});

test("powerautomate status read rejects missing admin auth", async () => {
  await withPowerAutomateEnv({}, async () => {
    const req = createMockRequest({
      method: "GET",
      query: { order_id: "order-1" },
    });
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 401);
    assert.equal(res.jsonBody?.error, "unauthorized");
  });
});

test("powerautomate route rejects invalid admin key", async () => {
  await withPowerAutomateEnv({}, async () => {
    const req = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      adminKey: "wrong-admin-key",
      body: { order_id: "order-1" },
    });
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 401);
    assert.equal(res.jsonBody?.error, "unauthorized");
  });
});

test("powerautomate route does not treat bearer-only auth as admin key auth", async () => {
  await withPowerAutomateEnv({}, async () => {
    const req = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      authorization: "Bearer admin-key-test",
      body: { order_id: "order-1" },
    });
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 401);
    assert.equal(res.jsonBody?.error, "unauthorized");
  });
});

test("powerautomate route rejects unknown role", async () => {
  await withPowerAutomateEnv({}, async () => {
    const { token, header } = createSessionCookie("user-1", "other@example.com");
    const req = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      cookie: header,
      body: { order_id: "order-1" },
    });
    req.cookies = { [SESSION_COOKIE_NAME]: token };
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 403);
    assert.equal(res.jsonBody?.error, "forbidden");
  });
});

test("powerautomate route rejects operator and allows admin only", async () => {
  await withPowerAutomateEnv({}, async () => {
    const operator = createSessionCookie("operator-1", "operator@example.com");
    const operatorReq = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      cookie: operator.header,
      body: { order_id: "order-1" },
    });
    operatorReq.cookies = { [SESSION_COOKIE_NAME]: operator.token };
    const operatorRes = createMockResponse();

    await powerAutomateHandler(operatorReq, operatorRes);

    assert.equal(operatorRes.statusCode, 403);
    assert.equal(operatorRes.jsonBody?.error, "forbidden");
  });
});

test("powerautomate route returns delivery state for admin key protected GET", async () => {
  await withPowerAutomateEnv({}, async () => {
    const stub = createSupabaseStub();
    __setCreateSupabaseClientForTests(() => stub.client as any);

    const req = createMockRequest({
      method: "GET",
      adminKey: "admin-key-test",
      query: { order_id: "order-1" },
    });
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.jsonBody, {
      ok: true,
      order_id: "order-1",
      delivery: {
        state: "unsent",
        can_send: true,
        can_resend: false,
      },
    });
  });
});

test("powerautomate route returns failed delivery state as resendable", async () => {
  await withPowerAutomateEnv({}, async () => {
    const stub = createSupabaseStub({
      rideLogs: [createRideLogStub("order-1", "power_automate_failed")],
    });
    __setCreateSupabaseClientForTests(() => stub.client as any);

    const req = createMockRequest({
      method: "GET",
      adminKey: "admin-key-test",
      query: { order_id: "order-1" },
    });
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.jsonBody?.delivery, {
      state: "failed",
      can_send: true,
      can_resend: true,
    });
  });
});

test("powerautomate route reads delivery state when order id and ride log primary key differ", async () => {
  await withPowerAutomateEnv({}, async () => {
    const stub = createSupabaseStub({
      order: createPickupOrderStub({
        id: "226",
      }),
      rideLogs: [
        createRideLogStub("226", "power_automate_sent", {
          id: "22222222-2222-2222-2222-222222222222",
        }),
      ],
    });
    __setCreateSupabaseClientForTests(() => stub.client as any);

    const req = createMockRequest({
      method: "GET",
      adminKey: "admin-key-test",
      query: { order_id: "226" },
    });
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.deepEqual(res.jsonBody?.delivery, {
      state: "sent",
      can_send: false,
      can_resend: false,
    });
  });
});

test("powerautomate route marks failed after reserve when payload build fails", async () => {
  await withPowerAutomateEnv({}, async () => {
    const stub = createSupabaseStub({ locationQueryError: true });
    __setCreateSupabaseClientForTests(() => stub.client as any);

    const req = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      adminKey: "admin-key-test",
      body: { order_id: "order-1" },
    });
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 500);
    assert.equal(res.jsonBody?.error, "db_query_failed");
    assert.equal(findRideLogByOrderId(stub.rideLogs, "order-1")?.status, "power_automate_failed");
  });
});

test("powerautomate route marks failed after reserve when webhook config is missing and then allows resend", async () => {
  await withPowerAutomateEnv({ POWER_AUTOMATE_WEBHOOK_URL: undefined }, async () => {
    const stub = createSupabaseStub();
    __setCreateSupabaseClientForTests(() => stub.client as any);

    const sendReq = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      adminKey: "admin-key-test",
      body: { order_id: "order-1" },
    });
    const sendRes = createMockResponse();

    await powerAutomateHandler(sendReq, sendRes);

    assert.equal(sendRes.statusCode, 500);
    assert.equal(sendRes.jsonBody?.error, "powerautomate_not_configured");
    assert.equal(findRideLogByOrderId(stub.rideLogs, "order-1")?.status, "power_automate_failed");

    process.env.POWER_AUTOMATE_WEBHOOK_URL = "https://flow.example.com/hook";

    const stateReq = createMockRequest({
      method: "GET",
      adminKey: "admin-key-test",
      query: { order_id: "order-1" },
    });
    const stateRes = createMockResponse();

    await powerAutomateHandler(stateReq, stateRes);

    assert.equal(stateRes.statusCode, 200);
    assert.deepEqual(stateRes.jsonBody?.delivery, {
      state: "failed",
      can_send: true,
      can_resend: true,
    });
  });
});

test("powerautomate route recovers dispatched pending to sent without re-dispatching on next post", async () => {
  await withPowerAutomateEnv({}, async () => {
    const firstStub = createSupabaseStub({ rideLogUpdateErrorStatus: "power_automate_sent" });
    __setCreateSupabaseClientForTests(() => firstStub.client as any);
    let sendCallCount = 0;
    __setSendPowerAutomateForTests(async () => {
      sendCallCount += 1;
      return { ok: true, status: 202, text: "accepted" };
    });

    const sendReq = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      adminKey: "admin-key-test",
      body: { order_id: "order-1" },
    });
    const sendRes = createMockResponse();

    await powerAutomateHandler(sendReq, sendRes);

    assert.equal(sendRes.statusCode, 500);
    assert.equal(sendRes.jsonBody?.error, "db_query_failed");
    const pendingRow = findRideLogByOrderId(firstStub.rideLogs, "order-1");
    assert.notEqual(pendingRow?.id, "order-1");
    assert.equal(pendingRow?.status, "power_automate_pending");
    assert.match(String(pendingRow?.notes ?? ""), /dispatch_stage:dispatched/);

    const stateReq = createMockRequest({
      method: "GET",
      adminKey: "admin-key-test",
      query: { order_id: "order-1" },
    });
    const stateRes = createMockResponse();

    await powerAutomateHandler(stateReq, stateRes);

    assert.equal(stateRes.statusCode, 200);
    assert.deepEqual(stateRes.jsonBody?.delivery, {
      state: "pending",
      can_send: false,
      can_resend: false,
    });
    assert.equal(sendCallCount, 1);

    process.env.POWER_AUTOMATE_WEBHOOK_URL = undefined;
    const recoveryStub = createSupabaseStub({
      rideLogs: pendingRow ? [{ ...pendingRow }] : [],
      locationQueryError: true,
    });
    __setCreateSupabaseClientForTests(() => recoveryStub.client as any);

    const recoverReq = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      adminKey: "admin-key-test",
      body: { order_id: "order-1" },
    });
    const recoverRes = createMockResponse();

    await powerAutomateHandler(recoverReq, recoverRes);

    assert.equal(recoverRes.statusCode, 200);
    assert.equal(recoverRes.jsonBody?.ok, true);
    assert.equal(sendCallCount, 1);
    assert.equal(findRideLogByOrderId(recoveryStub.rideLogs, "order-1")?.status, "power_automate_sent");
    assert.match(
      String(findRideLogByOrderId(recoveryStub.rideLogs, "order-1")?.notes ?? ""),
      /status:power_automate_sent/,
    );
  });
});

test("powerautomate route rejects invalid body and extra client fields", async () => {
  await withPowerAutomateEnv({}, async () => {
    const { token, header } = createSessionCookie("admin-1", "admin@example.com");

    const invalidReq = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      cookie: header,
      body: {},
    });
    invalidReq.cookies = { [SESSION_COOKIE_NAME]: token };
    const invalidRes = createMockResponse();
    await powerAutomateHandler(invalidReq, invalidRes);
    assert.equal(invalidRes.statusCode, 400);
    assert.equal(invalidRes.jsonBody?.error, "invalid_request");

    const tamperedReq = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      cookie: header,
      body: {
        order_id: "order-1",
        amount_yen: 999999,
        日付: "2099/1/1 00:00",
      },
    });
    tamperedReq.cookies = { [SESSION_COOKIE_NAME]: token };
    const tamperedRes = createMockResponse();
    await powerAutomateHandler(tamperedReq, tamperedRes);
    assert.equal(tamperedRes.statusCode, 400);
    assert.equal(tamperedRes.jsonBody?.error, "invalid_request");
  });
});

test("powerautomate route fails closed when order is missing", async () => {
  await withPowerAutomateEnv({}, async () => {
    const stub = createSupabaseStub({ order: null });
    __setCreateSupabaseClientForTests(() => stub.client as any);

    const { token, header } = createSessionCookie("admin-1", "admin@example.com");
    const req = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      cookie: header,
      body: { order_id: "order-1" },
    });
    req.cookies = { [SESSION_COOKIE_NAME]: token };
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 404);
    assert.equal(res.jsonBody?.error, "order_not_found");
  });
});

test("powerautomate route fails closed when env is missing", async () => {
  await withPowerAutomateEnv({ SUPABASE_SERVICE_ROLE_KEY: undefined }, async () => {
    const { token, header } = createSessionCookie("admin-1", "admin@example.com");
    const req = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      cookie: header,
      body: { order_id: "order-1" },
    });
    req.cookies = { [SESSION_COOKIE_NAME]: token };
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 500);
    assert.equal(res.jsonBody?.error, "powerautomate_not_configured");
  });
});

test("powerautomate route fails closed when matching delivery log contract is invalid", async () => {
  await withPowerAutomateEnv({}, async () => {
    const stub = createSupabaseStub({
      rideLogs: [
        createRideLogStub("order-1", "unexpected_status", {
          notes: buildDeliveryNotes("order-1", "unexpected_status"),
        }),
      ],
    });
    __setCreateSupabaseClientForTests(() => stub.client as any);

    const req = createMockRequest({
      method: "GET",
      adminKey: "admin-key-test",
      query: { order_id: "order-1" },
    });
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 500);
    assert.equal(res.jsonBody?.error, "db_query_failed");
  });
});

test("powerautomate route returns failure when external send fails", async () => {
  await withPowerAutomateEnv({}, async () => {
    const stub = createSupabaseStub();
    __setCreateSupabaseClientForTests(() => stub.client as any);
    __setSendPowerAutomateForTests(async () => ({
      ok: false,
      status: 500,
      text: "failed",
    }));

    const req = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      adminKey: "admin-key-test",
      body: { order_id: "order-1" },
    });
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 502);
    assert.equal(res.jsonBody?.ok, false);
    assert.equal(res.jsonBody?.error, "external_send_failed");
    assert.equal(findRideLogByOrderId(stub.rideLogs, "order-1")?.status, "power_automate_failed");
  });
});

test("powerautomate route reconstructs payload server-side from order_id only", async () => {
  await withPowerAutomateEnv({}, async () => {
    const stub = createSupabaseStub();
    __setCreateSupabaseClientForTests(() => stub.client as any);

    const sent: Array<{ url: string; payload: Record<string, unknown> }> = [];
    __setSendPowerAutomateForTests(async (url, payload) => {
      sent.push({ url, payload: payload as unknown as Record<string, unknown> });
      return {
        ok: true,
        status: 202,
        text: "accepted",
      };
    });

    const req = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      adminKey: "admin-key-test",
      body: { order_id: "order-1" },
    });
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(res.jsonBody?.ok, true);
    assert.equal(res.jsonBody?.status, 202);
    assert.equal("token" in (res.jsonBody ?? {}), false);
    assert.equal("secret" in (res.jsonBody ?? {}), false);
    assert.equal("sessionToken" in (res.jsonBody ?? {}), false);
    assert.equal("admin_key" in (res.jsonBody ?? {}), false);

    assert.equal(sent.length, 1);
    assert.equal(sent[0].url, "https://flow.example.com/hook");
    const payload = sent[0].payload;
    assert.equal(payload["運転者"], "運転者A");
    assert.equal(payload["車両"], "車両A");
    assert.equal(payload["出発地"], "地点1");
    assert.equal(payload["到着１"], "地点2");
    assert.equal(payload["金額（円）"], 1400);
    assert.equal(payload["距離（始）"], 100);
    assert.equal(payload["距離（終）"], 121);
    assert.equal(payload["距離（始）〜到着１"], 21);
    assert.equal(payload["総走行距離（km）"], 21);
    assert.equal(payload["備考"], "");
    assert.equal(payload["出発写真URL"], "https://photo.example.com/depart.jpg");
    assert.equal(payload["到着写真URL到着１"], "https://photo.example.com/arrive.jpg");
    assert.equal(typeof payload["ExcelPath"], "string");
    assert.equal(typeof payload["日付"], "string");
    assert.match(String(payload["ExcelPath"]), /^\/General\/雇用\/送迎\/\d{4}年送迎記録表\/送迎\d+月自動反映\.xlsx$/);
    const deliveryRow = findRideLogByOrderId(stub.rideLogs, "order-1");
    assert.equal(deliveryRow?.status, "power_automate_sent");
    assert.notEqual(deliveryRow?.id, "order-1");
    assert.equal(isUuidLike(String(deliveryRow?.id ?? "")), true);
    assert.match(
      String(deliveryRow?.notes ?? ""),
      /auth_source:admin_key/,
    );
  });
});

test("powerautomate route reconstructs eight arrivals and segment distances server-side", async () => {
  await withPowerAutomateEnv({}, async () => {
    const stub = createSupabaseStub({
      order: createSequentialArrivalOrder(8),
      locations: createLocationStubs(9),
    });
    __setCreateSupabaseClientForTests(() => stub.client as any);

    const sent: Array<{ payload: Record<string, unknown> }> = [];
    __setSendPowerAutomateForTests(async (_url, payload) => {
      sent.push({ payload: payload as unknown as Record<string, unknown> });
      return {
        ok: true,
        status: 202,
        text: "accepted",
      };
    });

    const req = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      adminKey: "admin-key-test",
      body: { order_id: "order-1" },
    });
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(sent.length, 1);

    const payload = sent[0].payload;
    assert.equal(payload["出発地"], "地点1");
    assert.equal(payload["到着１"], "地点2");
    assert.equal(payload["到着２"], "地点3");
    assert.equal(payload["到着３"], "地点4");
    assert.equal(payload["到着４"], "地点5");
    assert.equal(payload["到着５"], "地点6");
    assert.equal(payload["到着６"], "地点7");
    assert.equal(payload["到着７"], "地点8");
    assert.equal(payload["到着８"], "地点9");
    assert.equal(payload["距離（始）"], 100);
    assert.equal(payload["距離（終）"], 215);
    assert.equal(payload["距離（始）〜到着１"], 10);
    assert.equal(payload["距離（到着１〜到着２）"], 13);
    assert.equal(payload["距離（到着２〜到着３）"], 12);
    assert.equal(payload["距離（到着３〜到着４）"], 15);
    assert.equal(payload["距離（到着４〜到着５）"], 14);
    assert.equal(payload["距離（到着５〜到着６）"], 16);
    assert.equal(payload["距離（到着６〜到着７）"], 17);
    assert.equal(payload["距離（到着７〜到着８）"], 18);
    assert.equal(payload["総走行距離（km）"], 115);
    assert.equal(payload["到着写真URL到着１"], "https://photo.example.com/arrive-1.jpg");
    assert.equal(payload["到着写真URL到着８"], "https://photo.example.com/arrive-8.jpg");
  });
});

test("powerautomate route accepts admin session and records admin_session auth source", async () => {
  await withPowerAutomateEnv({}, async () => {
    const stub = createSupabaseStub();
    __setCreateSupabaseClientForTests(() => stub.client as any);
    __setSendPowerAutomateForTests(async () => ({
      ok: true,
      status: 202,
      text: "accepted",
    }));

    const { token, header } = createSessionCookie("admin-1", "admin@example.com");
    const req = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      cookie: header,
      body: { order_id: "order-1" },
    });
    req.cookies = { [SESSION_COOKIE_NAME]: token };
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(findRideLogByOrderId(stub.rideLogs, "order-1")?.status, "power_automate_sent");
    assert.match(
      String(findRideLogByOrderId(stub.rideLogs, "order-1")?.notes ?? ""),
      /auth_source:admin_session/,
    );
  });
});

test("powerautomate route blocks duplicate send when already sent", async () => {
  await withPowerAutomateEnv({}, async () => {
    const stub = createSupabaseStub({
      rideLogs: [createRideLogStub("order-1", "power_automate_sent")],
    });
    __setCreateSupabaseClientForTests(() => stub.client as any);

    const req = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      adminKey: "admin-key-test",
      body: { order_id: "order-1" },
    });
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.jsonBody?.error, "already_sent");
  });
});

test("powerautomate route blocks duplicate send when pending", async () => {
  await withPowerAutomateEnv({}, async () => {
    const stub = createSupabaseStub({
      rideLogs: [
        createRideLogStub("order-1", "power_automate_pending", {
          notes: buildDeliveryNotes("order-1", "power_automate_pending", [
            "dispatch_stage:reserved",
          ]),
        }),
      ],
    });
    __setCreateSupabaseClientForTests(() => stub.client as any);
    let sendCallCount = 0;
    __setSendPowerAutomateForTests(async () => {
      sendCallCount += 1;
      return { ok: true, status: 202, text: "accepted" };
    });

    const req = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      adminKey: "admin-key-test",
      body: { order_id: "order-1" },
    });
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 409);
    assert.equal(res.jsonBody?.error, "send_in_progress");
    assert.notEqual(findRideLogByOrderId(stub.rideLogs, "order-1")?.id, "order-1");
    assert.equal(sendCallCount, 0);
  });
});

test("powerautomate route fails closed for legacy pending without dispatch_stage", async () => {
  await withPowerAutomateEnv({}, async () => {
    const stub = createSupabaseStub({
      rideLogs: [
        createRideLogStub("order-1", "power_automate_pending", {
          notes: buildDeliveryNotes("order-1", "power_automate_pending"),
        }),
      ],
    });
    __setCreateSupabaseClientForTests(() => stub.client as any);
    let sendCallCount = 0;
    __setSendPowerAutomateForTests(async () => {
      sendCallCount += 1;
      return { ok: true, status: 202, text: "accepted" };
    });

    const stateReq = createMockRequest({
      method: "GET",
      adminKey: "admin-key-test",
      query: { order_id: "order-1" },
    });
    const stateRes = createMockResponse();

    await powerAutomateHandler(stateReq, stateRes);

    assert.equal(stateRes.statusCode, 500);
    assert.equal(stateRes.jsonBody?.error, "db_query_failed");
    assert.equal(sendCallCount, 0);

    const sendReq = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      adminKey: "admin-key-test",
      body: { order_id: "order-1" },
    });
    const sendRes = createMockResponse();

    await powerAutomateHandler(sendReq, sendRes);

    assert.equal(sendRes.statusCode, 500);
    assert.equal(sendRes.jsonBody?.error, "db_query_failed");
    assert.equal(sendCallCount, 0);
  });
});

test("powerautomate route allows resend only from failed state", async () => {
  await withPowerAutomateEnv({}, async () => {
    const stub = createSupabaseStub({
      rideLogs: [createRideLogStub("order-1", "power_automate_failed")],
    });
    __setCreateSupabaseClientForTests(() => stub.client as any);
    __setSendPowerAutomateForTests(async () => ({
      ok: true,
      status: 202,
      text: "accepted",
    }));

    const req = createMockRequest({
      method: "POST",
      origin: "https://pickup.example.com",
      adminKey: "admin-key-test",
      body: { order_id: "order-1" },
    });
    const res = createMockResponse();

    await powerAutomateHandler(req, res);

    assert.equal(res.statusCode, 200);
    assert.equal(findRideLogByOrderId(stub.rideLogs, "order-1")?.status, "power_automate_sent");
  });
});

test("app/page.tsx removes unused powerautomate call and keeps save flow", () => {
  const pagePath = path.resolve(process.cwd(), "app/page.tsx");
  const source = fs.readFileSync(pagePath, "utf8");

  assert.equal(source.includes("async function postToFlow("), false);
  assert.equal(source.includes("/api/powerautomate"), false);
  assert.equal(source.includes("type FlowPayload"), false);
  assert.equal(source.includes("ExcelPath:"), false);
  assert.equal(source.includes("await postToFlow(newRecordId)"), false);
  assert.equal(source.includes("保存しました（Power Automate送信は失敗）"), false);
  assert.equal(source.includes("const saved = await savePickupOrder(payloadForRoute);"), true);
  assert.equal(source.includes("arrivals: visibleArrivalPayload"), true);
  assert.equal(source.includes("const uploadedPhotoRefs = hasSelectedPhotos"), true);
  assert.equal(source.includes("await uploadSelectedPhotoReferences({"), true);
  assert.equal(source.includes("depart_photo_path: uploadedPhotoRefs.depart.photo_path"), true);
  assert.equal(source.includes("depart_photo_url: uploadedPhotoRefs.depart.photo_url"), true);
  assert.equal(source.includes("photo_path: uploadedPhotoRefs.arrivals[index]?.photo_path ?? null"), true);
  assert.equal(source.includes("photo_url: uploadedPhotoRefs.arrivals[index]?.photo_url ?? null"), true);
  assert.equal(source.includes("photoKind: `arrival_${index}`"), true);
  assert.equal(source.includes("let shouldRollbackUploadedPhotos = false;"), true);
  assert.equal(source.includes("await deleteUploadedPhotosForRollback(uploadedPaths);"), true);
  assert.equal(
    source.includes("await deleteUploadedPhotosForRollback(uploadedPhotoPathsForRollback);"),
    true,
  );
  assert.equal(source.includes("photo_rollback_incomplete"), true);
  assert.equal(source.includes("photo_rollback_unconfirmed"), true);
  assert.equal(source.includes("[uploadSelectedPhotoReferences] rollback failed"), true);
  assert.equal(source.includes("[onSave] rollback uploaded photos failed"), true);
  assert.equal(source.includes("toPhotoUploadUserMessage(error)"), true);
  assert.equal(source.includes("写真サイズが大きすぎます。8MB以下の画像を選択してください。"), true);
  assert.equal(source.includes('saved.delivery?.state === "sent"'), true);
  assert.equal(source.includes('saved.delivery?.state === "pending"'), true);
  assert.equal(source.includes('saved.delivery?.state === "failed"'), true);
  assert.equal(source.includes("保存して送信しました"), true);
  assert.equal(source.includes("保存しました。送信中です。管理ページで確認してください"), true);
  assert.equal(source.includes("保存しました。送信は失敗したため管理ページから再送してください"), true);
  assert.equal(source.includes("⚠️ 写真が送信できませんでした（後で再送できます）"), false);
  assert.equal(source.includes("uploadPhotoAsync({ orderId: newRecordId"), false);
});

test("app/api/photos/route.ts stores uploads in supabase storage without localhost bridge", () => {
  const routePath = path.resolve(process.cwd(), "app/api/photos/route.ts");
  const routeSource = fs.readFileSync(routePath, "utf8");
  const configPath = path.resolve(process.cwd(), "lib/photoApiConfig.ts");
  const configSource = fs.readFileSync(configPath, "utf8");

  assert.equal(routeSource.includes("127.0.0.1:3001"), false);
  assert.equal(routeSource.includes('storage: "supabase-storage"'), true);
  assert.equal(routeSource.includes("storage.from(bucket).upload"), true);
  assert.equal(routeSource.includes("MAX_PHOTO_FILE_BYTES"), true);
  assert.equal(routeSource.includes("ALLOWED_IMAGE_CONTENT_TYPES"), true);
  assert.equal(routeSource.includes("forbidden_origin"), true);
  assert.equal(routeSource.includes("ensureTrustedOrigin(request);"), true);
  assert.equal(routeSource.includes("export async function DELETE(request: Request)"), true);
  assert.equal(routeSource.includes("photo_paths_required"), true);
  assert.equal(routeSource.includes("requested_paths"), true);
  assert.equal(routeSource.includes("deleted_paths"), true);
  assert.equal(routeSource.includes("failed_paths"), true);
  assert.equal(routeSource.includes("const success = failedPaths.length === 0;"), true);
  assert.equal(routeSource.includes("status: success ? 200 : 502"), true);
  assert.equal(routeSource.includes("photo_storage_delete_incomplete"), true);
  assert.equal(routeSource.includes("photo_path"), true);
  assert.equal(routeSource.includes("photo_url"), true);
  assert.equal(routeSource.includes("pickup-orders/pending"), true);
  assert.equal(configSource.includes("DEFAULT_PHOTO_STORAGE_BUCKET"), true);
  assert.equal(configSource.includes("order-photos"), true);
  assert.equal(configSource.includes("127.0.0.1:3001"), false);
});

test("app/admin/page.tsx adds admin-only manual Power Automate controls", () => {
  const adminPagePath = path.resolve(process.cwd(), "app/admin/page.tsx");
  const source = fs.readFileSync(adminPagePath, "utf8");

  assert.equal(source.includes('apiGet(`/api/admin/drivers?ts=${ts}`)'), true);
  assert.equal(source.includes('apiGet(`/api/admin/vehicles?ts=${ts}`)'), true);
  assert.equal(source.includes('apiGet(`/api/admin/locations?ts=${ts}`)'), true);
  assert.equal(source.includes('apiGet(`/api/admin/fares?ts=${ts}`)'), true);
  assert.equal(source.includes("/api/admin/orders?ts="), true);
  assert.equal(source.includes("/api/powerautomate?order_id="), true);
  assert.equal(source.includes('await apiPost("/api/powerautomate", { order_id: trimmed });'), true);
  assert.equal(source.includes("await readPowerAutomateState(trimmed);"), true);
  assert.equal(source.includes('message === "already_sent" ||'), true);
  assert.equal(source.includes('message === "send_in_progress" ||'), true);
  assert.equal(source.includes('message === "external_send_failed"'), true);
  assert.equal(source.includes("await readPowerAutomateState(trimmed);\n        return;"), true);
  assert.equal(source.includes('setPowerAutomateDeliveryState("sent")'), false);
  assert.equal(source.includes('setPowerAutomateDeliveryState("pending")'), false);
  assert.equal(source.includes('setPowerAutomateDeliveryState("failed")'), false);
  assert.equal(source.includes('setPowerAutomateMessage("Power Automate を送信しました。")'), false);
  assert.equal(source.includes("最新の保存済み注文"), true);
  assert.equal(source.includes("選んで状態確認"), true);
  assert.equal(source.includes("selectPowerAutomateOrder(item)"), true);
  assert.equal(source.includes("送信状態を確認"), true);
  assert.equal(source.includes("Power Automate送信"), true);
  assert.equal(source.includes("送信状態: "), true);
  assert.equal(source.includes("未送信"), true);
  assert.equal(source.includes("送信中"), true);
  assert.equal(source.includes("送信済み"), true);
  assert.equal(source.includes("送信失敗"), true);
});
