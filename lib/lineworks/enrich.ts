// Phase 2c enrich layer — resolves LINE WORKS body names to Supabase master
// rows and computes the fare amount. Pure business logic behind an injected
// EnrichDbClient so unit tests don't need a real Supabase instance.

export type NamedRow = { id: number; name: string };
export type FareRow = { from_id: number; to_id: number; amount_yen: number };
export type RouteDistanceRow = {
  from_location_id: number;
  to_location_id: number;
  distance_km: number;
};

export type EnrichDbClient = {
  findDriverByName(name: string): Promise<NamedRow | null>;
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

  let sum = 0;
  let cur = fromId;
  for (const next of arrivalIds as number[]) {
    const leg = await findFareAnyDirection(db, cur, next);
    if (leg == null) return null;
    sum += leg;
    cur = next;
  }
  return sum;
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
  const out: number[] = [];
  let cur = fromId;
  for (const next of arrivalIds) {
    const km = await findRouteDistanceAnyDirection(db, cur, next);
    if (km == null) return null;
    out.push(km);
    cur = next;
  }
  return out;
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

type SupabaseLike = {
  from(table: string): {
    select(cols: string): {
      eq(col: string, val: string | number): {
        maybeSingle<T>(): Promise<{ data: T | null; error: unknown }>;
      };
      match(filter: Record<string, string | number>): {
        maybeSingle<T>(): Promise<{ data: T | null; error: unknown }>;
      };
    };
  };
};

/**
 * Wrap a @supabase/supabase-js client into the EnrichDbClient interface.
 * Errors bubble up as thrown Error; callers should map them to "failed"
 * status so the inbox row can be retried.
 */
export function createSupabaseEnrichClient(supabase: SupabaseLike): EnrichDbClient {
  return {
    async findDriverByName(name) {
      const res = await supabase
        .from('drivers')
        .select('id,name')
        .eq('name', name)
        .maybeSingle<NamedRow>();
      if (res.error) throw new Error('drivers_query_failed');
      return res.data ?? null;
    },
    async findLocationByName(name) {
      const res = await supabase
        .from('locations')
        .select('id,name')
        .eq('name', name)
        .maybeSingle<NamedRow>();
      if (res.error) throw new Error('locations_query_failed');
      return res.data ?? null;
    },
    async findFare(fromId, toId) {
      const res = await supabase
        .from('fares')
        .select('from_id,to_id,amount_yen')
        .match({ from_id: fromId, to_id: toId })
        .maybeSingle<FareRow>();
      if (res.error) throw new Error('fares_query_failed');
      return res.data ?? null;
    },
    async findRouteDistance(fromId, toId) {
      const res = await supabase
        .from('route_distances')
        .select('from_location_id,to_location_id,distance_km')
        .match({ from_location_id: fromId, to_location_id: toId })
        .maybeSingle<RouteDistanceRow>();
      if (res.error) throw new Error('route_distances_query_failed');
      return res.data ?? null;
    },
  };
}
