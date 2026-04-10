import type { NextApiRequest, NextApiResponse } from "next";

import { createClient } from "@supabase/supabase-js";

import { assertAdminKey } from "../../lib/admin/assertAdminKey.ts";
import { AuthConfigError } from "../../lib/auth/env.ts";
import type { SessionIdentity } from "../../lib/auth/session.ts";
import {
  AuthHttpError,
  requireAdmin,
  requireMethod,
  requireTrustedOrigin,
  writeAuthErrorResponse,
} from "../../lib/auth/guards.ts";

type PowerAutomateRequestPayload = {
  order_id: string;
};

const ARRIVAL_LOCATION_COLUMN_NAMES = [
  "to_id",
  "to1_id",
  "to2_id",
  "to3_id",
  "to4_id",
  "to5_id",
  "to6_id",
  "to7_id",
] as const;

const ARRIVAL_ODOMETER_COLUMN_NAMES = [
  "arrive_odometer_km",
  "arrive1_odometer_km",
  "arrive2_odometer_km",
  "arrive3_odometer_km",
  "arrive4_odometer_km",
  "arrive5_odometer_km",
  "arrive6_odometer_km",
  "arrive7_odometer_km",
] as const;

const ARRIVAL_PHOTO_PATH_COLUMN_NAMES = [
  "arrive_photo_path",
  "arrive1_photo_path",
  "arrive2_photo_path",
  "arrive3_photo_path",
  "arrive4_photo_path",
  "arrive5_photo_path",
  "arrive6_photo_path",
  "arrive7_photo_path",
] as const;

const ARRIVAL_PHOTO_URL_COLUMN_NAMES = [
  "arrive_photo_url",
  "arrive1_photo_url",
  "arrive2_photo_url",
  "arrive3_photo_url",
  "arrive4_photo_url",
  "arrive5_photo_url",
  "arrive6_photo_url",
  "arrive7_photo_url",
] as const;

const ARRIVAL_NAME_PAYLOAD_KEYS = [
  "到着１",
  "到着２",
  "到着３",
  "到着４",
  "到着５",
  "到着６",
  "到着７",
  "到着８",
] as const;

const ARRIVAL_DISTANCE_PAYLOAD_KEYS = [
  "距離（始）〜到着１",
  "距離（到着１〜到着２）",
  "距離（到着２〜到着３）",
  "距離（到着３〜到着４）",
  "距離（到着４〜到着５）",
  "距離（到着５〜到着６）",
  "距離（到着６〜到着７）",
  "距離（到着７〜到着８）",
] as const;

const ARRIVAL_PHOTO_PAYLOAD_KEYS = [
  "到着写真URL到着１",
  "到着写真URL到着２",
  "到着写真URL到着３",
  "到着写真URL到着４",
  "到着写真URL到着５",
  "到着写真URL到着６",
  "到着写真URL到着７",
  "到着写真URL到着８",
] as const;

type ArrivalLocationColumnName = (typeof ARRIVAL_LOCATION_COLUMN_NAMES)[number];
type ArrivalOdometerColumnName = (typeof ARRIVAL_ODOMETER_COLUMN_NAMES)[number];
type ArrivalPhotoPathColumnName = (typeof ARRIVAL_PHOTO_PATH_COLUMN_NAMES)[number];
type ArrivalPhotoUrlColumnName = (typeof ARRIVAL_PHOTO_URL_COLUMN_NAMES)[number];

export const PICKUP_ORDER_MAX_ARRIVALS = ARRIVAL_LOCATION_COLUMN_NAMES.length;

export type PickupOrderArrival = {
  location_id: number | null;
  odometer_km: number | null;
  // photo_path is kept for DB/internal storage only.
  // Existing Power Automate / Excel integrations continue to rely on photo_url.
  photo_path?: string | null;
  photo_url: string | null;
};

type PickupOrderArrivalColumns = {
  [K in ArrivalLocationColumnName]: number | null;
} & {
  [K in ArrivalOdometerColumnName]: number | null;
} & {
  [K in ArrivalPhotoUrlColumnName]: string | null;
};

export type PickupOrderArrivalPhotoPathColumns = {
  [K in ArrivalPhotoPathColumnName]: string | null;
};

type PickupOrderRow = {
  id: string | number;
  driver_name: string;
  vehicle_name: string;
  is_bus: boolean;
  from_id: number | null;
  amount_yen: number;
  report_at: string;
  depart_odometer_km: number;
  depart_photo_url: string | null;
} & PickupOrderArrivalColumns;

type LocationRow = {
  id: number;
  name: string;
};

type MasterNameRow = {
  id: number;
  name: string;
};

type DeliveryLogRow = {
  id: string;
  status: string;
  notes: string | null;
  employee_name: string | null;
};

type DeliveryState = "unsent" | "pending" | "sent" | "failed";
type DeliveryDispatchStage = "reserved" | "dispatched";

type DeliveryStateSnapshot = {
  state: DeliveryState;
  canSend: boolean;
  canResend: boolean;
  duplicateCode: "already_sent" | "send_in_progress" | null;
  dispatchStage: DeliveryDispatchStage | null;
};

type PowerAutomateAdminContext = {
  identity: SessionIdentity;
  authSource: "admin_session" | "admin_key";
};

type PowerAutomateExecutionContext = {
  identity: SessionIdentity;
  authSource: "admin_session" | "admin_key" | "pickup_order_public";
};

type PowerAutomatePayload = {
  ExcelPath: string;
  日付: string;
  運転者: string;
  車両: string;
  出発地: string;
  到着１: string;
  到着２: string;
  到着３: string;
  到着４: string;
  到着５: string;
  到着６: string;
  到着７: string;
  到着８: string;
  バス: string;
  "金額（円）": number;
  "距離（始）": number | "";
  "距離（終）": number | "";
  "距離（始）〜到着１": number | "";
  "距離（到着１〜到着２）": number | "";
  "距離（到着２〜到着３）": number | "";
  "距離（到着３〜到着４）": number | "";
  "距離（到着４〜到着５）": number | "";
  "距離（到着５〜到着６）": number | "";
  "距離（到着６〜到着７）": number | "";
  "距離（到着７〜到着８）": number | "";
  "総走行距離（km）": number | "";
  "想定距離（km）": "";
  "超過距離（km）": "";
  距離警告: "";
  区間警告詳細: "";
  備考: "";
  出発写真URL: string;
  到着写真URL到着１: string;
  到着写真URL到着２: string;
  到着写真URL到着３: string;
  到着写真URL到着４: string;
  到着写真URL到着５: string;
  到着写真URL到着６: string;
  到着写真URL到着７: string;
  到着写真URL到着８: string;
};

class PowerAutomateConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PowerAutomateConfigError";
  }
}

class PowerAutomateValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PowerAutomateValidationError";
  }
}

class PowerAutomateOrderNotFoundError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PowerAutomateOrderNotFoundError";
  }
}

class PowerAutomateDatabaseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PowerAutomateDatabaseError";
  }
}

class PowerAutomateSendError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PowerAutomateSendError";
  }
}

class PowerAutomateConflictError extends Error {
  readonly publicCode: "already_sent" | "send_in_progress";

  constructor(publicCode: "already_sent" | "send_in_progress") {
    super(publicCode);
    this.name = "PowerAutomateConflictError";
    this.publicCode = publicCode;
  }
}

let createSupabaseClient = createClient;

type SendPowerAutomateResult = {
  ok: boolean;
  status: number;
  text: string;
};

type SendPowerAutomate = (
  webhookUrl: string,
  payload: PowerAutomatePayload,
) => Promise<SendPowerAutomateResult>;

const DELIVERY_STATUS_PENDING = "power_automate_pending";
const DELIVERY_STATUS_SENT = "power_automate_sent";
const DELIVERY_STATUS_FAILED = "power_automate_failed";
const DELIVERY_NOTE_PREFIX = "power_automate_order:";
const POWER_AUTOMATE_ADMIN_KEY_IDENTITY: SessionIdentity = {
  userId: "admin-key",
  email: "admin-key@local.invalid",
};
const PICKUP_ORDER_PUBLIC_IDENTITY: SessionIdentity = {
  userId: "pickup-order-public",
  email: "pickup-order@local.invalid",
};

let sendPowerAutomate: SendPowerAutomate = async (webhookUrl, payload) => {
  const response = await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const text = await response.text();
  return {
    ok: response.ok,
    status: response.status,
    text,
  };
};

export function __setCreateSupabaseClientForTests(override: typeof createClient | null) {
  createSupabaseClient = override ?? createClient;
}

export function __setSendPowerAutomateForTests(override: SendPowerAutomate | null) {
  sendPowerAutomate =
    override ??
    (async (webhookUrl, payload) => {
      const response = await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await response.text();
      return {
        ok: response.ok,
        status: response.status,
        text,
      };
    });
}

export async function sendPowerAutomateForOrder(
  orderIdInput: string,
  executionContext: PowerAutomateExecutionContext,
): Promise<{ status: number }> {
  const supabase = getPowerAutomateSupabaseClient();
  const order = await fetchOrderById(supabase, orderIdInput);
  const orderId = String(order.id);
  let deliveryReserved = false;
  let deliveryDispatched = false;
  let deliveryLogId: string | null = null;

  try {
    const deliveryAttempt = await reserveDeliveryAttempt(supabase, order, executionContext);
    deliveryLogId = deliveryAttempt.deliveryLogId;
    if (deliveryAttempt.action === "finalize_dispatched_pending") {
      await updateDeliveryLogStatus(
        supabase,
        deliveryLogId,
        orderId,
        order.driver_name,
        executionContext,
        DELIVERY_STATUS_SENT,
      );
      return {
        status: 200,
      };
    }

    deliveryReserved = true;

    const flowPayload = await buildPowerAutomatePayload(supabase, order);
    const webhookUrl = readRequiredEnv("POWER_AUTOMATE_WEBHOOK_URL");
    const sendResult = await sendPowerAutomate(webhookUrl, flowPayload);
    if (!sendResult.ok) {
      throw new PowerAutomateSendError("external_send_failed");
    }
    deliveryDispatched = true;
    await updateDeliveryLogStatus(
      supabase,
      deliveryLogId,
      orderId,
      order.driver_name,
      executionContext,
      DELIVERY_STATUS_PENDING,
      "dispatched",
    );
    await updateDeliveryLogStatus(
      supabase,
      deliveryLogId,
      orderId,
      order.driver_name,
      executionContext,
      DELIVERY_STATUS_SENT,
    );

    return {
      status: sendResult.status,
    };
  } catch (error) {
    if (deliveryReserved && !deliveryDispatched && deliveryLogId) {
      try {
        await updateDeliveryLogStatus(
          supabase,
          deliveryLogId,
          orderId,
          order.driver_name,
          executionContext,
          DELIVERY_STATUS_FAILED,
        );
      } catch (rollbackError) {
        throw rollbackError;
      }
    } else if (deliveryReserved && deliveryDispatched && deliveryLogId) {
      try {
        await updateDeliveryLogStatus(
          supabase,
          deliveryLogId,
          orderId,
          order.driver_name,
          executionContext,
          DELIVERY_STATUS_PENDING,
          "dispatched",
        );
      } catch (recoveryError) {
        throw recoveryError;
      }
    }
    throw error;
  }
}

export async function autoSendPickupOrderToPowerAutomate(orderId: string): Promise<{
  state: "sent" | "pending" | "failed";
  error?: string;
}> {
  try {
    await sendPowerAutomateForOrder(orderId, {
      identity: PICKUP_ORDER_PUBLIC_IDENTITY,
      authSource: "pickup_order_public",
    });
    return {
      state: "sent",
    };
  } catch (error) {
    if (error instanceof PowerAutomateConflictError) {
      if (error.publicCode === "already_sent") {
        return {
          state: "sent",
        };
      }

      return {
        state: "pending",
      };
    }

    if (error instanceof PowerAutomateSendError) {
      return {
        state: "failed",
        error: "external_send_failed",
      };
    }

    if (error instanceof PowerAutomateConfigError || error instanceof AuthConfigError) {
      return {
        state: "failed",
        error: "powerautomate_not_configured",
      };
    }

    if (error instanceof PowerAutomateDatabaseError) {
      return {
        state: "failed",
        error: "db_query_failed",
      };
    }

    if (error instanceof PowerAutomateOrderNotFoundError) {
      return {
        state: "failed",
        error: "order_not_found",
      };
    }

    if (error instanceof PowerAutomateValidationError) {
      return {
        state: "failed",
        error: "invalid_request",
      };
    }

    return {
      state: "failed",
    };
  }
}

function readRequiredEnv(name: "SUPABASE_SERVICE_ROLE_KEY" | "POWER_AUTOMATE_WEBHOOK_URL"): string {
  const value = process.env[name]?.trim();
  if (!value) {
    throw new PowerAutomateConfigError(`${name} is required`);
  }
  return value;
}

function getPowerAutomateSupabaseClient() {
  const supabaseUrl =
    process.env.SUPABASE_URL?.trim() || process.env.NEXT_PUBLIC_SUPABASE_URL?.trim() || "";
  if (!supabaseUrl) {
    throw new PowerAutomateConfigError("SUPABASE_URL or NEXT_PUBLIC_SUPABASE_URL is required");
  }

  const serviceRoleKey = readRequiredEnv("SUPABASE_SERVICE_ROLE_KEY");
  return createSupabaseClient(supabaseUrl, serviceRoleKey, {
    auth: {
      autoRefreshToken: false,
      persistSession: false,
    },
  });
}

function parseRequestPayload(body: unknown): PowerAutomateRequestPayload {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    throw new PowerAutomateValidationError("body must be an object");
  }

  const record = body as Record<string, unknown>;
  const keys = Object.keys(record);
  if (keys.length !== 1 || keys[0] !== "order_id") {
    throw new PowerAutomateValidationError("unexpected field");
  }

  if (typeof record.order_id !== "string" || !record.order_id.trim()) {
    throw new PowerAutomateValidationError("order_id is required");
  }

  return {
    order_id: record.order_id.trim(),
  };
}

function parseQueryOrderId(query: NextApiRequest["query"]): PowerAutomateRequestPayload {
  const raw = Array.isArray(query.order_id) ? query.order_id[0] : query.order_id;
  if (typeof raw !== "string" || !raw.trim()) {
    throw new PowerAutomateValidationError("order_id is required");
  }
  return {
    order_id: raw.trim(),
  };
}

function asFiniteNumberOrEmpty(value: unknown): number | "" {
  if (typeof value !== "number" || !Number.isFinite(value)) return "";
  return value;
}

function asNonNegativeSegment(start: number | "", end: number | ""): number | "" {
  if (typeof start !== "number" || typeof end !== "number") return "";
  const diff = end - start;
  if (!Number.isFinite(diff) || diff < 0) return "";
  return diff;
}

function sumNumericSegments(values: Array<number | "">): number | "" {
  const numbers = values.filter(
    (value): value is number => typeof value === "number" && Number.isFinite(value),
  );
  if (!numbers.length) {
    return "";
  }
  return numbers.reduce((sum, value) => sum + value, 0);
}

function isPickupOrderArrivalEmpty(arrival: PickupOrderArrival) {
  return (
    arrival.location_id == null &&
    arrival.odometer_km == null &&
    arrival.photo_path == null &&
    arrival.photo_url == null
  );
}

export function buildPickupOrderArrivalsFromColumns(
  row: PickupOrderArrivalColumns,
): PickupOrderArrival[] {
  return ARRIVAL_LOCATION_COLUMN_NAMES.map((locationColumn, index) => ({
    location_id: row[locationColumn] ?? null,
    odometer_km: row[ARRIVAL_ODOMETER_COLUMN_NAMES[index]] ?? null,
    // Reconstructed arrivals are used by the existing downstream payload path,
    // so photo_path is intentionally not promoted into the Power Automate contract.
    photo_path: null,
    photo_url: row[ARRIVAL_PHOTO_URL_COLUMN_NAMES[index]] ?? null,
  }));
}

export function mapPickupOrderArrivalsToColumns(
  arrivals: readonly PickupOrderArrival[],
): PickupOrderArrivalColumns {
  const row = {} as PickupOrderArrivalColumns;
  ARRIVAL_LOCATION_COLUMN_NAMES.forEach((locationColumn, index) => {
    row[locationColumn] = arrivals[index]?.location_id ?? null;
    row[ARRIVAL_ODOMETER_COLUMN_NAMES[index]] = arrivals[index]?.odometer_km ?? null;
    row[ARRIVAL_PHOTO_URL_COLUMN_NAMES[index]] = arrivals[index]?.photo_url ?? null;
  });
  return row;
}

export function mapPickupOrderArrivalPhotoPathsToColumns(
  arrivals: readonly PickupOrderArrival[],
): PickupOrderArrivalPhotoPathColumns {
  const row = {} as PickupOrderArrivalPhotoPathColumns;
  // photo_path is persisted for later internal reference only; flow/excel payloads still read photo_url.
  ARRIVAL_PHOTO_PATH_COLUMN_NAMES.forEach((columnName, index) => {
    row[columnName] = arrivals[index]?.photo_path ?? null;
  });
  return row;
}

export function buildEmptyPickupOrderArrivalPhotoPathColumns(): PickupOrderArrivalPhotoPathColumns {
  return mapPickupOrderArrivalPhotoPathsToColumns([]);
}

function getContiguousPickupOrderArrivals(row: PickupOrderArrivalColumns): PickupOrderArrival[] {
  const arrivals = buildPickupOrderArrivalsFromColumns(row);
  const contiguous: PickupOrderArrival[] = [];
  let encounteredEmpty = false;

  for (const arrival of arrivals) {
    if (isPickupOrderArrivalEmpty(arrival)) {
      encounteredEmpty = true;
      continue;
    }

    if (encounteredEmpty) {
      throw new PowerAutomateValidationError("pickup_order_arrivals_have_gap");
    }

    contiguous.push(arrival);
  }

  return contiguous;
}

function getJstParts(date: Date) {
  const parts = new Intl.DateTimeFormat("ja-JP", {
    timeZone: "Asia/Tokyo",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).formatToParts(date);

  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
  };
}

function formatDateTimeForExcel(date: Date): string {
  const { year, month, day, hour, minute } = getJstParts(date);
  return `${Number(year)}/${Number(month)}/${Number(day)} ${hour}:${minute}`;
}

function buildExcelPathForJst(date: Date): string {
  const { year, month } = getJstParts(date);
  return `/General/雇用/送迎/${year}年送迎記録表/送迎${Number(month)}月自動反映.xlsx`;
}

async function fetchOrderById(
  supabase: ReturnType<typeof getPowerAutomateSupabaseClient>,
  orderId: string,
): Promise<PickupOrderRow> {
  const result = await supabase
    .from("pickup_orders")
    .select(
      "id,driver_name,vehicle_name,is_bus,from_id,to_id,to1_id,to2_id,to3_id,to4_id,to5_id,to6_id,to7_id,amount_yen,report_at,depart_odometer_km,arrive_odometer_km,arrive1_odometer_km,arrive2_odometer_km,arrive3_odometer_km,arrive4_odometer_km,arrive5_odometer_km,arrive6_odometer_km,arrive7_odometer_km,depart_photo_url,arrive_photo_url,arrive1_photo_url,arrive2_photo_url,arrive3_photo_url,arrive4_photo_url,arrive5_photo_url,arrive6_photo_url,arrive7_photo_url",
    )
    .eq("id", orderId)
    .maybeSingle<PickupOrderRow>();

  if (result.error) {
    throw new PowerAutomateDatabaseError("pickup_orders_query_failed");
  }
  if (!result.data) {
    throw new PowerAutomateOrderNotFoundError("order_not_found");
  }
  return result.data;
}

function buildDeliveryNote(
  orderId: string,
  status: string,
  identity: SessionIdentity,
  authSource: PowerAutomateExecutionContext["authSource"],
  dispatchStage?: DeliveryDispatchStage | null,
): string {
  const parts = [
    "kind:power_automate_delivery",
    `${DELIVERY_NOTE_PREFIX}${orderId}`,
    `status:${status}`,
    `auth_source:${authSource}`,
    `actor_user_id:${identity.userId}`,
    `actor_email:${identity.email}`,
    `at:${new Date().toISOString()}`,
  ];

  if (dispatchStage) {
    parts.push(`dispatch_stage:${dispatchStage}`);
  }

  return parts.join(";");
}

function readDeliveryDispatchStage(notes: string | null): DeliveryDispatchStage | null {
  if (!notes) {
    return null;
  }

  for (const token of notes.split(";")) {
    if (!token.startsWith("dispatch_stage:")) {
      continue;
    }

    const value = token.slice("dispatch_stage:".length);
    if (value === "reserved" || value === "dispatched") {
      return value;
    }
    throw new PowerAutomateDatabaseError("delivery_log_invalid_dispatch_stage");
  }

  return null;
}

async function fetchDeliveryLogByOrderId(
  supabase: ReturnType<typeof getPowerAutomateSupabaseClient>,
  orderId: string,
): Promise<DeliveryLogRow | null> {
  const result = await supabase
    .from("ride_logs")
    .select("id,status,notes,employee_name")
    .like("notes", `%${DELIVERY_NOTE_PREFIX}${orderId};%`)
    .limit(2);

  if (result.error) {
    throw new PowerAutomateDatabaseError("delivery_log_query_failed");
  }
  if (!result.data?.length) {
    return null;
  }
  if (result.data.length > 1) {
    throw new PowerAutomateDatabaseError("delivery_log_multiple_rows");
  }
  return result.data[0] ?? null;
}

async function updateDeliveryLogStatus(
  supabase: ReturnType<typeof getPowerAutomateSupabaseClient>,
  deliveryLogId: string,
  orderId: string,
  driverName: string,
  adminContext: PowerAutomateExecutionContext,
  status: typeof DELIVERY_STATUS_PENDING | typeof DELIVERY_STATUS_SENT | typeof DELIVERY_STATUS_FAILED,
  dispatchStage?: DeliveryDispatchStage | null,
) {
  const result = await supabase
    .from("ride_logs")
    .update({
      status,
      employee_name: driverName,
      notes: buildDeliveryNote(
        orderId,
        status,
        adminContext.identity,
        adminContext.authSource,
        dispatchStage,
      ),
    })
    .eq("id", deliveryLogId)
    .select("id,status")
    .single<{ id: string; status: string }>();

  if (result.error || !result.data) {
    throw new PowerAutomateDatabaseError("delivery_log_update_failed");
  }
}

/**
 * Power Automate delivery state currently lives in ride_logs with a strict contract:
 * - pickup order lookup is keyed by pickup_orders.id
 * - delivery log lookup is keyed by ride_logs.notes containing "power_automate_order:<order_id>"
 * - ride_logs.id is the delivery row primary key used only for updates after lookup
 * - ride_logs.status is exactly one of pending/sent/failed below
 * - pending rows may carry dispatch_stage:reserved or dispatch_stage:dispatched in notes
 * - no row means "unsent"
 * employee_name is copied for display parity only and is not used to resolve state.
 */
function resolveDeliveryStateSnapshot(
  orderId: string,
  current: DeliveryLogRow | null,
): DeliveryStateSnapshot {
  if (!current) {
    return {
      state: "unsent",
      canSend: true,
      canResend: false,
      duplicateCode: null,
      dispatchStage: null,
    };
  }

  if (!current.notes?.includes(`${DELIVERY_NOTE_PREFIX}${orderId}`)) {
    throw new PowerAutomateDatabaseError("delivery_log_contract_violation");
  }

  if (current.status === DELIVERY_STATUS_PENDING) {
    const dispatchStage = readDeliveryDispatchStage(current.notes);
    if (!dispatchStage) {
      throw new PowerAutomateDatabaseError("delivery_log_invalid_dispatch_stage");
    }
    return {
      state: "pending",
      canSend: false,
      canResend: false,
      duplicateCode: "send_in_progress",
      dispatchStage,
    };
  }

  if (current.status === DELIVERY_STATUS_SENT) {
    return {
      state: "sent",
      canSend: false,
      canResend: false,
      duplicateCode: "already_sent",
      dispatchStage: null,
    };
  }

  if (current.status === DELIVERY_STATUS_FAILED) {
    return {
      state: "failed",
      canSend: true,
      canResend: true,
      duplicateCode: null,
      dispatchStage: null,
    };
  }

  throw new PowerAutomateDatabaseError("delivery_log_invalid_status");
}

async function readDeliveryStateSnapshot(
  supabase: ReturnType<typeof getPowerAutomateSupabaseClient>,
  orderId: string,
): Promise<DeliveryStateSnapshot> {
  const current = await fetchDeliveryLogByOrderId(supabase, orderId);
  return resolveDeliveryStateSnapshot(orderId, current);
}

async function reserveDeliveryAttempt(
  supabase: ReturnType<typeof getPowerAutomateSupabaseClient>,
  order: PickupOrderRow,
  adminContext: PowerAutomateExecutionContext,
): Promise<{ action: "send" | "finalize_dispatched_pending"; deliveryLogId: string }> {
  const orderId = String(order.id);
  const current = await fetchDeliveryLogByOrderId(supabase, orderId);
  const deliveryState = resolveDeliveryStateSnapshot(orderId, current);

  if (deliveryState.state === "pending" && deliveryState.dispatchStage === "dispatched") {
    if (!current) {
      throw new PowerAutomateDatabaseError("delivery_log_missing_for_pending_state");
    }
    return {
      action: "finalize_dispatched_pending",
      deliveryLogId: current.id,
    };
  }

  if (!deliveryState.canSend) {
    if (deliveryState.duplicateCode) {
      throw new PowerAutomateConflictError(deliveryState.duplicateCode);
    }
    throw new PowerAutomateDatabaseError("delivery_log_invalid_state");
  }

  if (current) {
    await updateDeliveryLogStatus(
      supabase,
      current.id,
      orderId,
      order.driver_name,
      adminContext,
      DELIVERY_STATUS_PENDING,
      "reserved",
    );
    return {
      action: "send",
      deliveryLogId: current.id,
    };
  }

  const result = await supabase
    .from("ride_logs")
    .insert({
      employee_name: order.driver_name,
      status: DELIVERY_STATUS_PENDING,
      notes: buildDeliveryNote(
        orderId,
        DELIVERY_STATUS_PENDING,
        adminContext.identity,
        adminContext.authSource,
        "reserved",
      ),
    })
    .select("id,status")
    .single<{ id: string; status: string }>();

  if (result.error) {
    const code = (result.error as { code?: string } | null)?.code ?? "";
    if (code === "23505") {
      throw new PowerAutomateConflictError("send_in_progress");
    }
    throw new PowerAutomateDatabaseError("delivery_log_insert_failed");
  }

  return {
    action: "send",
    deliveryLogId: result.data.id,
  };
}

async function fetchLocationNameById(
  supabase: ReturnType<typeof getPowerAutomateSupabaseClient>,
  locationId: number,
): Promise<string> {
  const result = await supabase
    .from("locations")
    .select("id,name")
    .eq("id", locationId)
    .maybeSingle<LocationRow>();

  if (result.error) {
    throw new PowerAutomateDatabaseError("locations_query_failed");
  }
  if (!result.data?.name) {
    throw new PowerAutomateOrderNotFoundError("location_not_found");
  }
  return result.data.name;
}

async function fetchDriverName(
  supabase: ReturnType<typeof getPowerAutomateSupabaseClient>,
  driverName: string,
): Promise<string> {
  const result = await supabase
    .from("drivers")
    .select("id,name")
    .eq("name", driverName)
    .maybeSingle<MasterNameRow>();

  if (result.error) {
    throw new PowerAutomateDatabaseError("drivers_query_failed");
  }
  if (!result.data?.name) {
    throw new PowerAutomateOrderNotFoundError("driver_not_found");
  }
  return result.data.name;
}

async function fetchVehicleName(
  supabase: ReturnType<typeof getPowerAutomateSupabaseClient>,
  vehicleName: string,
): Promise<string> {
  const result = await supabase
    .from("vehicles")
    .select("id,name")
    .eq("name", vehicleName)
    .maybeSingle<MasterNameRow>();

  if (result.error) {
    throw new PowerAutomateDatabaseError("vehicles_query_failed");
  }
  if (!result.data?.name) {
    throw new PowerAutomateOrderNotFoundError("vehicle_not_found");
  }
  return result.data.name;
}

async function buildPowerAutomatePayload(
  supabase: ReturnType<typeof getPowerAutomateSupabaseClient>,
  order: PickupOrderRow,
): Promise<PowerAutomatePayload> {
  const driverNamePromise = fetchDriverName(supabase, order.driver_name);
  const vehicleNamePromise = fetchVehicleName(supabase, order.vehicle_name);
  const fromNamePromise =
    typeof order.from_id === "number" && Number.isFinite(order.from_id)
      ? fetchLocationNameById(supabase, order.from_id)
      : Promise.resolve("");
  const arrivals = getContiguousPickupOrderArrivals(order);
  const arrivalNamePromises = arrivals.map((arrival) =>
    typeof arrival.location_id === "number" && Number.isFinite(arrival.location_id)
      ? fetchLocationNameById(supabase, arrival.location_id)
      : Promise.resolve(""),
  );

  const [driverName, vehicleName, fromName, ...arrivalNames] = await Promise.all([
    driverNamePromise,
    vehicleNamePromise,
    fromNamePromise,
    ...arrivalNamePromises,
  ]);

  const reportDate = Number.isNaN(new Date(order.report_at).getTime())
    ? new Date()
    : new Date(order.report_at);

  const distanceStart = asFiniteNumberOrEmpty(order.depart_odometer_km);
  const arrivalOdometers = arrivals.map((arrival) => asFiniteNumberOrEmpty(arrival.odometer_km));
  const segmentDistances = arrivalOdometers.map((arrivalOdometer, index) =>
    asNonNegativeSegment(index === 0 ? distanceStart : arrivalOdometers[index - 1], arrivalOdometer),
  );
  const distanceEnd =
    arrivalOdometers.length > 0 ? arrivalOdometers[arrivalOdometers.length - 1] : "";
  const totalDistance = sumNumericSegments(segmentDistances);

  const payload: PowerAutomatePayload = {
    ExcelPath: buildExcelPathForJst(reportDate),
    日付: formatDateTimeForExcel(reportDate),
    運転者: driverName,
    車両: vehicleName,
    出発地: order.is_bus ? "" : fromName,
    到着１: order.is_bus ? "" : arrivalNames[0] ?? "",
    到着２: "",
    到着３: "",
    到着４: "",
    到着５: "",
    到着６: "",
    到着７: "",
    到着８: "",
    バス: order.is_bus ? "バス" : "通常ルート",
    "金額（円）": typeof order.amount_yen === "number" && Number.isFinite(order.amount_yen) ? order.amount_yen : 0,
    "距離（始）": distanceStart,
    "距離（終）": distanceEnd,
    "距離（始）〜到着１": segmentDistances[0] ?? "",
    "距離（到着１〜到着２）": "",
    "距離（到着２〜到着３）": "",
    "距離（到着３〜到着４）": "",
    "距離（到着４〜到着５）": "",
    "距離（到着５〜到着６）": "",
    "距離（到着６〜到着７）": "",
    "距離（到着７〜到着８）": "",
    "総走行距離（km）": totalDistance,
    "想定距離（km）": "",
    "超過距離（km）": "",
    距離警告: "",
    区間警告詳細: "",
    備考: "",
    出発写真URL: order.depart_photo_url ?? "",
    到着写真URL到着１: arrivals[0]?.photo_url ?? "",
    到着写真URL到着２: "",
    到着写真URL到着３: "",
    到着写真URL到着４: "",
    到着写真URL到着５: "",
    到着写真URL到着６: "",
    到着写真URL到着７: "",
    到着写真URL到着８: "",
  };

  ARRIVAL_NAME_PAYLOAD_KEYS.forEach((key, index) => {
    payload[key] = order.is_bus ? "" : arrivalNames[index] ?? "";
  });
  ARRIVAL_DISTANCE_PAYLOAD_KEYS.forEach((key, index) => {
    payload[key] = segmentDistances[index] ?? "";
  });
  ARRIVAL_PHOTO_PAYLOAD_KEYS.forEach((key, index) => {
    payload[key] = arrivals[index]?.photo_url ?? "";
  });

  return payload;
}

function hasAdminKeyCredential(req: NextApiRequest): boolean {
  const headerKey = req.headers["x-admin-key"];
  return typeof headerKey === "string" && Boolean(headerKey.trim());
}

function requirePowerAutomateAdmin(req: NextApiRequest): PowerAutomateAdminContext {
  if (hasAdminKeyCredential(req)) {
    try {
      assertAdminKey(req);
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      if (message === "ADMIN_KEY is not set") {
        throw new PowerAutomateConfigError("ADMIN_KEY is required");
      }
      if (message === "Unauthorized") {
        throw new AuthHttpError(401, "unauthorized");
      }
      throw error;
    }

    return {
      identity: POWER_AUTOMATE_ADMIN_KEY_IDENTITY,
      authSource: "admin_key",
    };
  }

  const { identity } = requireAdmin(req);
  return {
    identity,
    authSource: "admin_session",
  };
}

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");

  try {
    requireMethod(req, ["GET", "POST"]);
    const method = (req.method ?? "").toUpperCase();
    if (method === "POST") {
      requireTrustedOrigin(req);
    }
    const adminContext = requirePowerAutomateAdmin(req);

    if (method === "GET") {
      const payload = parseQueryOrderId(req.query);
      const supabase = getPowerAutomateSupabaseClient();
      const order = await fetchOrderById(supabase, payload.order_id);
      const orderId = String(order.id);
      const delivery = await readDeliveryStateSnapshot(supabase, orderId);

      return res.status(200).json({
        ok: true,
        order_id: orderId,
        delivery: {
          state: delivery.state,
          can_send: delivery.canSend,
          can_resend: delivery.canResend,
        },
      });
    }

    const payload = parseRequestPayload(req.body);
    const sendResult = await sendPowerAutomateForOrder(payload.order_id, adminContext);

    return res.status(200).json({
      ok: true,
      status: sendResult.status,
    });
  } catch (error) {
    if (error instanceof PowerAutomateValidationError) {
      return res.status(400).json({ ok: false, error: "invalid_request" });
    }
    if (error instanceof PowerAutomateOrderNotFoundError) {
      return res.status(404).json({ ok: false, error: "order_not_found" });
    }
    if (error instanceof PowerAutomateConfigError || error instanceof AuthConfigError) {
      return res.status(500).json({ ok: false, error: "powerautomate_not_configured" });
    }
    if (error instanceof PowerAutomateDatabaseError) {
      return res.status(500).json({ ok: false, error: "db_query_failed" });
    }
    if (error instanceof PowerAutomateSendError) {
      return res.status(502).json({ ok: false, error: "external_send_failed" });
    }
    if (error instanceof PowerAutomateConflictError) {
      return res.status(409).json({ ok: false, error: error.publicCode });
    }
    return writeAuthErrorResponse(res, error);
  }
}
