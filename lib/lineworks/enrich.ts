// Phase 2c enrich layer — resolves LINE WORKS body names to Supabase master
// rows and computes the fare amount. Pure business logic behind an injected
// EnrichDbClient so unit tests don't need a real Supabase instance.

import type { SupabaseClient } from '@supabase/supabase-js';

export type NamedRow = { id: number; name: string };
export type FareRow = { from_id: number; to_id: number; amount_yen: number };
export type RouteDistanceRow = {
  from_location_id: number;
  to_location_id: number;
  distance_km: number;
};

export type EnrichDbClient = {
  findDriverByName(name: string): Promise<NamedRow | null>;
  findDriverByLineWorksUserId(userId: string): Promise<NamedRow | null>;
  findLocationByName(name: string): Promise<NamedRow | null>;
  findFare(fromId: number, toId: number): Promise<FareRow | null>;
  findRouteDistance(fromId: number, toId: number): Promise<RouteDistanceRow | null>;
};

// Single bus fare is fixed — mirrors app/page.tsx:561 (`if (mode === "bus") return 2000`).
export const BUS_FARE_YEN = 2000;

/** Exact-match lookup on drivers.name; returns null when not registered. */
export async function resolveDriverByName(
  db: EnrichDbClient,
  displayName: string,
): Promise<NamedRow | null> {
  const name = displayName.trim();
  if (!name) return null;
  return db.findDriverByName(name);
}

/**
 * Resolve a driver from the LINE WORKS webhook source.userId (UUID). This
 * is the Phase 2d primary path — webhooks do not carry a display name, so
 * drivers must be pre-provisioned with their LW userId via admin/drivers.
 */
export async function resolveDriverByLineWorksUserId(
  db: EnrichDbClient,
  userId: string,
): Promise<NamedRow | null> {
  const id = userId.trim();
  if (!id) return null;
  return db.findDriverByLineWorksUserId(id);
}

/**
 * Resolve the 出発地 + each 到着地 against the locations master. Returns
 * parallel arrays: (fromLocation | null, arrivalLocations[]). Callers decide
 * whether missing locations are fatal — for 通常ルート any null is invalid;
 * for バス the from-side may legitimately be unmapped (the "-" placeholder).
 */
export async function resolveRouteLocations(
  db: EnrichDbClient,
  fromName: string,
  arrivalNames: ReadonlyArray<string>,
): Promise<{ from: NamedRow | null; arrivals: (NamedRow | null)[] }> {
  const fromPromise = fromName === '-' ? Promise.resolve(null) : db.findLocationByName(fromName.trim());
  const arrivalPromises = arrivalNames.map((n) => db.findLocationByName(n.trim()));
  const [from, ...arrivals] = await Promise.all([fromPromise, ...arrivalPromises]);
  return { from, arrivals };
}

/**
 * Compute 金額（円）:
 *  - バス: always 2000 yen (SSOT app/page.tsx)
 *  - 通常ルート: sum of pairwise fare(from→a1) + fare(a1→a2) + ... + fare(a_{n-1}→a_n).
 *    Each leg tries direct (from,to) then reverse (to,from) — mirroring
 *    app/page.tsx:getFareAmount. Any missing leg → null (caller marks invalid).
 */
/** Build the (from, to) pair list for a route's pairwise legs. */
function buildLegs(
  fromId: number,
  arrivalIds: ReadonlyArray<number>,
): ReadonlyArray<[number, number]> {
  const legs: [number, number][] = [];
  let cur = fromId;
  for (const next of arrivalIds) {
    legs.push([cur, next]);
    cur = next;
  }
  return legs;
}

export async function computeFareYen(
  db: EnrichDbClient,
  fromId: number | null,
  arrivalIds: ReadonlyArray<number | null>,
  isBus: boolean,
): Promise<number | null> {
  if (isBus) return BUS_FARE_YEN;
  if (fromId == null) return null;
  if (arrivalIds.length === 0) return null;
  if (arrivalIds.some((id) => id == null)) return null;

  const legs = buildLegs(fromId, arrivalIds as ReadonlyArray<number>);
  // Each leg is independent (cur/next are known up front), so fan out.
  const legFares = await Promise.all(
    legs.map(([a, b]) => findFareAnyDirection(db, a, b)),
  );
  if (legFares.some((yen) => yen == null)) return null;
  return (legFares as number[]).reduce((acc, yen) => acc + yen, 0);
}

async function findFareAnyDirection(
  db: EnrichDbClient,
  a: number,
  b: number,
): Promise<number | null> {
  const direct = await db.findFare(a, b);
  if (direct) return direct.amount_yen;
  const reverse = await db.findFare(b, a);
  return reverse?.amount_yen ?? null;
}

/**
 * Resolve the per-segment distances (from→a1, a1→a2, …, a_{n-1}→a_n) against
 * the route_distances master. Tries direct (from,to) then reverse (to,from).
 * Returns null if ANY segment is missing — caller marks the row invalid.
 * The returned array has length == arrivalIds.length.
 */
export async function resolveSegmentDistances(
  db: EnrichDbClient,
  fromId: number,
  arrivalIds: ReadonlyArray<number>,
): Promise<number[] | null> {
  if (arrivalIds.length === 0) return null;
  const legs = buildLegs(fromId, arrivalIds);
  const results = await Promise.all(
    legs.map(([a, b]) => findRouteDistanceAnyDirection(db, a, b)),
  );
  if (results.some((km) => km == null)) return null;
  return results as number[];
}

async function findRouteDistanceAnyDirection(
  db: EnrichDbClient,
  a: number,
  b: number,
): Promise<number | null> {
  const direct = await db.findRouteDistance(a, b);
  if (direct) return direct.distance_km;
  const reverse = await db.findRouteDistance(b, a);
  return reverse?.distance_km ?? null;
}

// --- Supabase adapter ------------------------------------------------------

/**
 * Wrap a @supabase/supabase-js client into the EnrichDbClient interface.
 * Errors bubble up as thrown Error; callers should map them to "failed"
 * status so the inbox row can be retried.
 *
 * NOTE: Typed against `SupabaseClient` directly rather than a hand-rolled
 * structural type, because maybeSingle() returns a PostgrestBuilder that
 * extends PromiseLike — a plain `Promise<...>` fake won't structurally
 * match it without `excessively deep` errors.
 */
export function createSupabaseEnrichClient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  supabase: SupabaseClient<any, any, any, any, any>,
): EnrichDbClient {
  return {
    async findDriverByName(name) {
      const res = await supabase
        .from('drivers')
        .select('id,name')
        .eq('name', name)
        .maybeSingle();
      if (res.error) throw new Error('drivers_query_failed');
      return (res.data as NamedRow | null) ?? null;
    },
    async findDriverByLineWorksUserId(userId) {
      const res = await supabase
        .from('drivers')
        .select('id,name')
        .eq('lineworks_user_id', userId)
        .maybeSingle();
      if (res.error) throw new Error('drivers_query_failed');
      return (res.data as NamedRow | null) ?? null;
    },
    async findLocationByName(name) {
      const res = await supabase
        .from('locations')
        .select('id,name')
        .eq('name', name)
        .maybeSingle();
      if (res.error) throw new Error('locations_query_failed');
      return (res.data as NamedRow | null) ?? null;
    },
    async findFare(fromId, toId) {
      const res = await supabase
        .from('fares')
        .select('from_id,to_id,amount_yen')
        .match({ from_id: fromId, to_id: toId })
        .maybeSingle();
      if (res.error) throw new Error('fares_query_failed');
      return (res.data as FareRow | null) ?? null;
    },
    async findRouteDistance(fromId, toId) {
      const res = await supabase
        .from('route_distances')
        .select('from_location_id,to_location_id,distance_km')
        .match({ from_location_id: fromId, to_location_id: toId })
        .maybeSingle();
      if (res.error) throw new Error('route_distances_query_failed');
      return (res.data as RouteDistanceRow | null) ?? null;
    },
  };
}
