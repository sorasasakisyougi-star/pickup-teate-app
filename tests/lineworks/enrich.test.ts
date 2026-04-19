import assert from 'node:assert/strict';
import test from 'node:test';

import {
  resolveDriverByName,
  resolveRouteLocations,
  computeFareYen,
  resolveSegmentDistances,
  BUS_FARE_YEN,
  type EnrichDbClient,
  type NamedRow,
  type FareRow,
  type RouteDistanceRow,
} from '../../lib/lineworks/enrich';

function makeDb(init: {
  drivers?: NamedRow[];
  locations?: NamedRow[];
  fares?: FareRow[];
  routeDistances?: RouteDistanceRow[];
}): EnrichDbClient {
  const drivers = init.drivers ?? [];
  const locations = init.locations ?? [];
  const fares = init.fares ?? [];
  const routes = init.routeDistances ?? [];
  return {
    async findDriverByName(name) {
      return drivers.find((d) => d.name === name) ?? null;
    },
    async findLocationByName(name) {
      return locations.find((l) => l.name === name) ?? null;
    },
    async findFare(fromId, toId) {
      return fares.find((f) => f.from_id === fromId && f.to_id === toId) ?? null;
    },
    async findRouteDistance(fromId, toId) {
      return (
        routes.find((r) => r.from_location_id === fromId && r.to_location_id === toId) ?? null
      );
    },
  };
}

// --- resolveDriverByName ---------------------------------------------------

test('resolveDriverByName — exact match', async () => {
  const db = makeDb({ drivers: [{ id: 10, name: '山田太郎' }] });
  const r = await resolveDriverByName(db, '山田太郎');
  assert.deepEqual(r, { id: 10, name: '山田太郎' });
});

test('resolveDriverByName — returns null when unknown', async () => {
  const db = makeDb({ drivers: [{ id: 10, name: '山田太郎' }] });
  assert.equal(await resolveDriverByName(db, '知らない人'), null);
});

test('resolveDriverByName — trims whitespace', async () => {
  const db = makeDb({ drivers: [{ id: 10, name: '山田太郎' }] });
  const r = await resolveDriverByName(db, '  山田太郎  ');
  assert.deepEqual(r, { id: 10, name: '山田太郎' });
});

test('resolveDriverByName — empty string is null', async () => {
  const db = makeDb({ drivers: [{ id: 10, name: '山田太郎' }] });
  assert.equal(await resolveDriverByName(db, '   '), null);
});

// --- resolveRouteLocations -------------------------------------------------

test('resolveRouteLocations — normal route resolves from + arrivals', async () => {
  const db = makeDb({
    locations: [
      { id: 1, name: '会社' },
      { id: 2, name: 'A病院' },
      { id: 3, name: 'B老人ホーム' },
    ],
  });
  const r = await resolveRouteLocations(db, '会社', ['A病院', 'B老人ホーム']);
  assert.deepEqual(r.from, { id: 1, name: '会社' });
  assert.deepEqual(r.arrivals, [
    { id: 2, name: 'A病院' },
    { id: 3, name: 'B老人ホーム' },
  ]);
});

test('resolveRouteLocations — "-" as from returns null from without DB call', async () => {
  const db = makeDb({ locations: [{ id: 1, name: 'A病院' }] });
  const r = await resolveRouteLocations(db, '-', ['A病院']);
  assert.equal(r.from, null);
  assert.deepEqual(r.arrivals, [{ id: 1, name: 'A病院' }]);
});

test('resolveRouteLocations — missing arrival is null in array', async () => {
  const db = makeDb({ locations: [{ id: 1, name: '会社' }] });
  const r = await resolveRouteLocations(db, '会社', ['未登録']);
  assert.deepEqual(r.from, { id: 1, name: '会社' });
  assert.deepEqual(r.arrivals, [null]);
});

// --- computeFareYen --------------------------------------------------------

test('computeFareYen — bus is always 2000', async () => {
  const db = makeDb({});
  assert.equal(await computeFareYen(db, null, [], true), BUS_FARE_YEN);
  assert.equal(await computeFareYen(db, 1, [2, 3], true), BUS_FARE_YEN);
});

test('computeFareYen — normal: sum of pairwise fares', async () => {
  const db = makeDb({
    fares: [
      { from_id: 1, to_id: 2, amount_yen: 700 },
      { from_id: 2, to_id: 3, amount_yen: 500 },
    ],
  });
  assert.equal(await computeFareYen(db, 1, [2, 3], false), 1200);
});

test('computeFareYen — normal: reverse-direction fallback', async () => {
  const db = makeDb({
    fares: [
      { from_id: 2, to_id: 1, amount_yen: 700 }, // only reverse recorded
    ],
  });
  assert.equal(await computeFareYen(db, 1, [2], false), 700);
});

test('computeFareYen — normal: missing leg returns null', async () => {
  const db = makeDb({
    fares: [{ from_id: 1, to_id: 2, amount_yen: 700 }], // no 2→3 and no 3→2
  });
  assert.equal(await computeFareYen(db, 1, [2, 3], false), null);
});

test('computeFareYen — normal: fromId null returns null', async () => {
  const db = makeDb({});
  assert.equal(await computeFareYen(db, null, [2], false), null);
});

test('computeFareYen — normal: empty arrivals returns null', async () => {
  const db = makeDb({});
  assert.equal(await computeFareYen(db, 1, [], false), null);
});

test('computeFareYen — normal: any null arrivalId returns null', async () => {
  const db = makeDb({});
  assert.equal(await computeFareYen(db, 1, [2, null], false), null);
});

// --- resolveSegmentDistances ----------------------------------------------

test('resolveSegmentDistances — pairwise lookup', async () => {
  const db = makeDb({
    routeDistances: [
      { from_location_id: 1, to_location_id: 2, distance_km: 5.2 },
      { from_location_id: 2, to_location_id: 3, distance_km: 3.1 },
    ],
  });
  assert.deepEqual(await resolveSegmentDistances(db, 1, [2, 3]), [5.2, 3.1]);
});

test('resolveSegmentDistances — reverse-direction fallback', async () => {
  const db = makeDb({
    routeDistances: [{ from_location_id: 2, to_location_id: 1, distance_km: 7.5 }],
  });
  assert.deepEqual(await resolveSegmentDistances(db, 1, [2]), [7.5]);
});

test('resolveSegmentDistances — returns null when any leg missing', async () => {
  const db = makeDb({
    routeDistances: [{ from_location_id: 1, to_location_id: 2, distance_km: 5.2 }],
  });
  assert.equal(await resolveSegmentDistances(db, 1, [2, 3]), null);
});

test('resolveSegmentDistances — empty arrivals returns null', async () => {
  const db = makeDb({});
  assert.equal(await resolveSegmentDistances(db, 1, []), null);
});
