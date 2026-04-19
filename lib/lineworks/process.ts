// Phase 2c pipeline: take a raw LINE WORKS webhook body and drive it through
// parse → enrich → map → forward. Pure-ish: all side effects (DB, HTTP) come
// through injected dependencies, so we can exercise every code path in unit
// tests without Supabase or a real fetch.

import { parseMessageBody, type ParseErrorCode } from './parse';
import {
  resolveDriverByLineWorksUserId,
  resolveRouteLocations,
  computeFareYen,
  resolveSegmentDistances,
  type EnrichDbClient,
  type NamedRow,
} from './enrich';
import { buildV1Payload, type V1Payload } from './mapper';
import type { ForwardResult } from './forward';

export type ProcessOutcome = { senderUserId: string | null } & (
  | {
      terminal: 'forwarded';
      payload: V1Payload;
      receiptId: string | null;
      attempts: number;
    }
  | {
      terminal: 'invalid';
      code: InvalidCode;
      userMessage: string;
    }
  | {
      terminal: 'failed';
      error: string;
      attempts: number;
    }
);

export type InvalidCode =
  | 'not_a_soutei_message'
  | ParseErrorCode
  | 'driver_user_id_not_registered'
  | 'location_not_registered'
  | 'fare_not_registered'
  | 'distance_not_registered'
  | 'missing_message_body'
  | 'missing_sender_user_id'
  | 'missing_message_timestamp';

export type ProcessDeps = {
  db: EnrichDbClient;
  forward: (payload: V1Payload) => Promise<ForwardResult>;
};

type JsonObj = Record<string, unknown>;

function asObj(v: unknown): JsonObj | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as JsonObj) : null;
}

function pickStr(v: unknown): string | null {
  return typeof v === 'string' && v.length > 0 ? v : null;
}

function extractText(body: JsonObj): string | null {
  const content = asObj(body.content);
  return content ? pickStr(content.text) : null;
}

/**
 * LINE WORKS webhook envelope carries only source.userId — no display name.
 * Drivers are resolved by this ID via drivers.lineworks_user_id (Phase 2d).
 */
function extractSenderUserId(body: JsonObj): string | null {
  const source = asObj(body.source);
  return (source && pickStr(source.userId)) || pickStr(body.userId) || null;
}

/**
 * LW Bot docs show two possible shapes:
 *   issuedTime: "2022-01-04T05:16:05.716Z"   (ISO string)
 *   createdTime: 1640281225908                 (ms-epoch number)
 * Accept both; fall back to the inbox row's created_at ISO when absent.
 */
function extractIssuedTime(body: JsonObj, fallbackIso: string): Date | null {
  const candidates: unknown[] = [body.issuedTime, body.createdTime];
  for (const raw of candidates) {
    if (typeof raw === 'number' && Number.isFinite(raw)) {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (typeof raw === 'string' && raw.length > 0) {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
  }
  if (fallbackIso) {
    const d = new Date(fallbackIso);
    if (!Number.isNaN(d.getTime())) return d;
  }
  return null;
}

const invalidMessages: Record<InvalidCode, string> = {
  not_a_soutei_message: '',
  no_response: '',
  invalid_format: '入力形式が違います',
  invalid_kubun: '区分は「通常ルート」か「バス」です',
  too_many_arrivals: '到着地は最大8件です',
  missing_arrivals: '到着地がありません',
  missing_odo: 'ODO始/ODO終がありません',
  driver_user_id_not_registered: 'LINE WORKS ユーザーID未登録です',
  location_not_registered: '場所名が未登録です',
  fare_not_registered: '料金マスタが未登録です',
  distance_not_registered: '区間距離マスタが未登録です',
  missing_message_body: '入力形式が違います',
  missing_sender_user_id: '送信者IDが取得できません',
  missing_message_timestamp: '送信時刻が取得できません',
};

function invalid(
  code: InvalidCode,
  senderUserId: string | null,
  overrideMessage?: string,
): ProcessOutcome {
  return {
    senderUserId,
    terminal: 'invalid',
    code,
    userMessage: overrideMessage ?? invalidMessages[code],
  };
}

export async function processInboxRow(
  rawBody: string,
  createdAtIso: string,
  deps: ProcessDeps,
): Promise<ProcessOutcome> {
  let body: JsonObj | null;
  try {
    const parsedJson = JSON.parse(rawBody);
    body = asObj(parsedJson);
  } catch {
    return invalid('missing_message_body', null);
  }
  if (!body) return invalid('missing_message_body', null);

  // Extract the sender's LW userId up front so every outcome can carry it;
  // the Bot reply layer uses this to know who to reply to. When a #送迎
  // shape is invalid, we still want to ping the sender.
  const senderUserId = extractSenderUserId(body);

  const text = extractText(body);
  if (!text) return invalid('missing_message_body', senderUserId);

  const parsed = parseMessageBody(text);
  if (!parsed.ok) {
    if (parsed.code === 'no_response') return invalid('not_a_soutei_message', senderUserId);
    return invalid(parsed.code, senderUserId, parsed.userMessage);
  }

  if (!senderUserId) return invalid('missing_sender_user_id', null);

  const messageTimestamp = extractIssuedTime(body, createdAtIso);
  if (!messageTimestamp) return invalid('missing_message_timestamp', senderUserId);

  let driver;
  try {
    driver = await resolveDriverByLineWorksUserId(deps.db, senderUserId);
  } catch (e) {
    return {
      senderUserId,
      terminal: 'failed',
      error: e instanceof Error ? e.message : 'drivers_query_failed',
      attempts: 0,
    };
  }
  if (!driver) return invalid('driver_user_id_not_registered', senderUserId);

  let locations;
  try {
    locations = await resolveRouteLocations(deps.db, parsed.data.from, parsed.data.arrivals);
  } catch (e) {
    return {
      senderUserId,
      terminal: 'failed',
      error: e instanceof Error ? e.message : 'locations_query_failed',
      attempts: 0,
    };
  }
  // 通常ルート: from must resolve; all arrivals must resolve.
  // バス: from may be "-" (null is OK); arrivals must still resolve.
  if (!parsed.data.isBus && !locations.from) {
    return invalid('location_not_registered', senderUserId);
  }
  const resolvedArrivals: NamedRow[] = locations.arrivals.filter(
    (a): a is NamedRow => a !== null,
  );
  if (resolvedArrivals.length !== locations.arrivals.length) {
    return invalid('location_not_registered', senderUserId);
  }
  const fromId = locations.from?.id ?? null;
  const arrivalIds = resolvedArrivals.map((a) => a.id);

  let fareYen: number | null;
  try {
    fareYen = await computeFareYen(deps.db, fromId, arrivalIds, parsed.data.isBus);
  } catch (e) {
    return {
      senderUserId,
      terminal: 'failed',
      error: e instanceof Error ? e.message : 'fares_query_failed',
      attempts: 0,
    };
  }
  if (fareYen == null) return invalid('fare_not_registered', senderUserId);

  // 通常ルート: require a route_distances row for every leg. Missing → invalid.
  // バス: distances aren't contractually defined (from may be "-") → skip lookup.
  let segmentDistances: number[] | undefined;
  if (!parsed.data.isBus && fromId != null) {
    try {
      const segs = await resolveSegmentDistances(deps.db, fromId, arrivalIds);
      if (segs == null) return invalid('distance_not_registered', senderUserId);
      segmentDistances = segs;
    } catch (e) {
      return {
        senderUserId,
        terminal: 'failed',
        error: e instanceof Error ? e.message : 'route_distances_query_failed',
        attempts: 0,
      };
    }
  }

  const payload = buildV1Payload(parsed.data, {
    driverName: driver.name,
    messageTimestamp,
    fareYen,
    segmentDistances,
  });

  const result = await deps.forward(payload);
  if (result.ok) {
    return {
      senderUserId,
      terminal: 'forwarded',
      payload,
      receiptId: null,
      attempts: result.attempts,
    };
  }
  return {
    senderUserId,
    terminal: 'failed',
    error: result.error,
    attempts: result.attempts,
  };
}
