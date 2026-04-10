"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { uploadPhotoAsync } from "./components/PhotoUploadService";
import {
  classifyPhotoDeleteResultForRollback,
  type PhotoDeleteResult,
} from "./lib/photoRollbackContract.ts";

type DriverRow = { id: number; name: string };
type VehicleRow = { id: number; name: string };
type LocationRow = { id: number; name: string; kind?: string | null };
type FareRow = { from_id: number; to_id: number; amount_yen: number };

type Mode = "route" | "bus";

type PickupOrderArrivalSaveRequest = {
  location_id: number | null;
  odometer_km: number;
  photo_path: string | null;
  photo_url: string | null;
};

type PickupOrderSaveRequest = {
  mode: Mode;
  driver_name: string;
  vehicle_name: string;
  from_id: number | null;
  depart_odometer_km: number;
  depart_photo_path: string | null;
  depart_photo_url: string | null;
  arrivals: PickupOrderArrivalSaveRequest[];
};

type PickupOrderDeliveryState = "sent" | "pending" | "failed";

type PickupOrderSaveResult = {
  id: string;
  delivery?: {
    state: PickupOrderDeliveryState;
    error?: string;
  };
};

type PickupMastersResponse = {
  ok: true;
  drivers: DriverRow[];
  vehicles: VehicleRow[];
  locations: LocationRow[];
  fares: FareRow[];
};

type ArrivalInput = {
  locationId: number | null;
  odo: number | null;
  photoFile?: File | null;
};

type PickupOrderPhotoReference = {
  photo_path: string | null;
  photo_url: string | null;
};

type PickupOrderUploadedPhotoReferences = {
  depart: PickupOrderPhotoReference;
  arrivals: PickupOrderPhotoReference[];
};

const DIFF_LIMIT_KM = 100;
const MAX_ARRIVALS = 8;
const MASTER_UPDATED_KEY = "pickup_masters_updated_at";
const PHOTO_API_URL = process.env.NEXT_PUBLIC_PHOTO_API_URL?.trim() || "/api/photos";

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
    parts.find((p) => p.type === type)?.value ?? "";

  return {
    year: pick("year"),
    month: pick("month"),
    day: pick("day"),
    hour: pick("hour"),
    minute: pick("minute"),
  };
}

function formatReportTimeJa(date: Date) {
  const { year, month, day, hour, minute } = getJstParts(date);
  return `${Number(year) % 100}年${Number(month)}月${Number(day)}日${Number(hour)}時${minute}分（自動）`;
}

function onlyAsciiDigitsFromAnyWidth(s: string) {
  return (s ?? "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[^\d]/g, "");
}

function calcSeg(from: number | null, to: number | null): number | "" {
  if (from == null || to == null) return "";
  const d = to - from;
  if (!Number.isFinite(d)) return "";
  return d >= 0 ? d : "";
}

function sumSegs(values: Array<number | "">): number | "" {
  const nums = values.filter(
    (v): v is number => typeof v === "number" && Number.isFinite(v)
  );
  if (!nums.length) return "";
  return nums.reduce((a, b) => a + b, 0);
}

async function readJsonOrThrow(res: Response) {
  const text = await res.text();
  if (!res.ok) {
    throw new Error(text || `HTTP ${res.status}`);
  }
  if (!text) {
    throw new Error("empty response");
  }
  return JSON.parse(text);
}

function asArrayOrThrow<T>(value: unknown, fieldName: string): T[] {
  if (!Array.isArray(value)) {
    throw new Error(`invalid pickup masters response: ${fieldName}`);
  }
  return value as T[];
}

async function fetchPickupMasters(): Promise<PickupMastersResponse> {
  const res = await fetch(`/api/pickup-masters?ts=${Date.now()}`, {
    cache: "no-store",
    headers: {
      "cache-control": "no-store, no-cache, max-age=0, must-revalidate",
      pragma: "no-cache",
    },
  });
  const data = (await readJsonOrThrow(res)) as Record<string, unknown>;
  if (data.ok !== true) {
    throw new Error("マスタ読込失敗");
  }

  return {
    ok: true,
    drivers: asArrayOrThrow<DriverRow>(data.drivers, "drivers"),
    vehicles: asArrayOrThrow<VehicleRow>(data.vehicles, "vehicles"),
    locations: asArrayOrThrow<LocationRow>(data.locations, "locations"),
    fares: asArrayOrThrow<FareRow>(data.fares, "fares"),
  };
}

async function savePickupOrder(payload: PickupOrderSaveRequest) {
  const res = await fetch("/api/pickup-orders", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  const text = await res.text();
  let data: Record<string, unknown> | null = null;
  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = null;
  }

  if (!res.ok) {
    const errorCode = typeof data?.error === "string" ? data.error : "";
    if (errorCode === "unauthorized") {
      throw new Error("ログインが必要です");
    }
    if (errorCode === "forbidden") {
      throw new Error("保存権限がありません");
    }
    if (errorCode === "forbidden_origin") {
      throw new Error("保存元の検証に失敗しました");
    }
    if (errorCode === "invalid_request") {
      throw new Error("入力内容を確認してください");
    }
    if (errorCode === "master_not_found") {
      throw new Error("マスタ情報を確認してください");
    }
    if (errorCode === "fare_not_found") {
      throw new Error("料金表を確認してください");
    }
    throw new Error("保存でエラー");
  }

  const id = typeof data?.id === "string" ? data.id : "";
  if (!id) {
    throw new Error("保存でエラー");
  }

  const deliveryRecord =
    data?.delivery && typeof data.delivery === "object" && !Array.isArray(data.delivery)
      ? (data.delivery as Record<string, unknown>)
      : null;
  const deliveryState: PickupOrderDeliveryState | null =
    deliveryRecord?.state === "sent" ||
    deliveryRecord?.state === "pending" ||
    deliveryRecord?.state === "failed"
      ? (deliveryRecord.state as PickupOrderDeliveryState)
      : null;
  const delivery =
    deliveryState
      ? {
          state: deliveryState,
          error: typeof deliveryRecord?.error === "string" ? deliveryRecord.error : undefined,
        }
      : undefined;

  return { id, delivery } satisfies PickupOrderSaveResult;
}

function getFareAmount(fromId: number | null, toId: number | null, fares: FareRow[]) {
  if (!fromId || !toId) return null;

  const direct = fares.find((x) => x.from_id === fromId && x.to_id === toId);
  if (direct) return direct.amount_yen;

  const reverse = fares.find((x) => x.from_id === toId && x.to_id === fromId);
  if (reverse) return reverse.amount_yen;

  return null;
}

function emptyArrival(): ArrivalInput {
  return {
    locationId: null,
    odo: null,
    photoFile: null,
  };
}

function emptyPhotoReference(): PickupOrderPhotoReference {
  return {
    photo_path: null,
    photo_url: null,
  };
}

function collectUploadedPhotoPaths(photoRefs: PickupOrderUploadedPhotoReferences): string[] {
  const values = [
    photoRefs.depart.photo_path,
    ...photoRefs.arrivals.map((arrival) => arrival.photo_path),
  ];
  return values.filter((value): value is string => Boolean(value));
}

async function deleteUploadedPhotosForRollback(photoPaths: string[]): Promise<PhotoDeleteResult> {
  if (!photoPaths.length) {
    return {
      requested_paths: [],
      deleted_paths: [],
      failed_paths: [],
    };
  }

  const res = await fetch(PHOTO_API_URL, {
    method: "DELETE",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ photo_paths: photoPaths }),
  });
  const bodyText = await res.text();

  let data: Record<string, unknown> | null = null;
  try {
    data = bodyText ? (JSON.parse(bodyText) as Record<string, unknown>) : null;
  } catch {
    throw new Error("photo_delete_invalid_json");
  }

  const rollbackResult = classifyPhotoDeleteResultForRollback(data, photoPaths);

  if (!res.ok && rollbackResult.failed_paths.length === 0) {
    const errorCode = typeof data?.error === "string" ? data.error : "";
    throw new Error(errorCode || `photo_delete_failed_http_${res.status}`);
  }

  return rollbackResult;
}

function toPhotoUploadUserMessage(error: unknown): string {
  const code = error instanceof Error ? error.message : "";

  if (code.includes("photo_file_too_large")) {
    return "写真サイズが大きすぎます。8MB以下の画像を選択してください。";
  }
  if (code.includes("invalid_photo_content_type")) {
    return "写真形式が未対応です。JPEG/PNG/WebP/HEIC/HEIF/GIF を使用してください。";
  }
  if (code.includes("forbidden_origin")) {
    return "写真送信元の検証に失敗しました。ページを再読み込みして再試行してください。";
  }
  if (code.includes("photo_rollback_incomplete")) {
    return "写真アップロードに失敗し、写真ロールバックが未完了です。管理者へ連絡してください。";
  }
  if (code.includes("photo_rollback_unconfirmed")) {
    return "写真アップロードに失敗し、写真ロールバック結果を確認できませんでした。管理者へ連絡してください。";
  }
  return "写真アップロードに失敗しました。保存されていません。時間をおいて再試行してください。";
}

async function uploadSelectedPhotoReferences(params: {
  departFile: File | null;
  arrivals: ArrivalInput[];
}): Promise<PickupOrderUploadedPhotoReferences> {
  const departUpload = params.departFile
    ? uploadPhotoAsync({
        photoKind: "depart",
        file: params.departFile,
      }).then((uploaded) => ({
        photo_path: uploaded.photoPath,
        photo_url: uploaded.photoUrl,
      }))
    : Promise.resolve(emptyPhotoReference());

  const arrivalUploads = params.arrivals.map((arrival, index) =>
    arrival.photoFile
      ? uploadPhotoAsync({
          photoKind: `arrival_${index}`,
          file: arrival.photoFile,
        }).then((uploaded) => ({
          photo_path: uploaded.photoPath,
          photo_url: uploaded.photoUrl,
        }))
      : Promise.resolve(emptyPhotoReference()),
  );

  const settled = await Promise.allSettled([departUpload, ...arrivalUploads]);
  const rejected = settled.find(
    (item): item is PromiseRejectedResult => item.status === "rejected",
  );

  if (rejected) {
    const uploadedPaths = settled
      .filter((item): item is PromiseFulfilledResult<PickupOrderPhotoReference> => item.status === "fulfilled")
      .map((item) => item.value.photo_path)
      .filter((photoPath): photoPath is string => Boolean(photoPath));

    if (uploadedPaths.length > 0) {
      try {
        const rollbackResult = await deleteUploadedPhotosForRollback(uploadedPaths);
        if (rollbackResult.failed_paths.length > 0) {
          console.error("[uploadSelectedPhotoReferences] rollback incomplete", {
            rollbackResult,
          });
          throw new Error("photo_rollback_incomplete");
        }
      } catch (rollbackError) {
        if (rollbackError instanceof Error && rollbackError.message === "photo_rollback_incomplete") {
          throw rollbackError;
        }
        console.error("[uploadSelectedPhotoReferences] rollback failed", {
          rollbackError,
          uploadedPaths,
        });
        throw new Error("photo_rollback_unconfirmed");
      }
    }

    throw rejected.reason instanceof Error
      ? rejected.reason
      : new Error("photo_upload_failed");
  }

  const values = settled.map(
    (item) => (item as PromiseFulfilledResult<PickupOrderPhotoReference>).value,
  );
  const [depart, ...arrivals] = values;
  return { depart, arrivals };
}

export default function Page() {
  const [mode, setMode] = useState<Mode>("route");

  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [fares, setFares] = useState<FareRow[]>([]);
  const [loadErr, setLoadErr] = useState("");

  const [driverName, setDriverName] = useState("");
  const [vehicleName, setVehicleName] = useState("");

  const [fromId, setFromId] = useState<number | null>(null);
  const [arrivalCount, setArrivalCount] = useState(1);
  const [arrivals, setArrivals] = useState<ArrivalInput[]>(
    Array.from({ length: MAX_ARRIVALS }, () => emptyArrival())
  );

  const [departOdo, setDepartOdo] = useState<number | null>(null);
  const [departPhotoFile, setDepartPhotoFile] = useState<File | null>(null);

  const [status, setStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [note, setNote] = useState("");

  const [now, setNow] = useState<Date>(() => new Date());
  const [mastersLoading, setMastersLoading] = useState(false);

  const lastReloadAtRef = useRef(0);
  const lastSeenMasterUpdateRef = useRef("");
  const mastersLoadingRef = useRef(false);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  const reloadMasters = useCallback(
    async (force = false) => {
      const nowMs = Date.now();
      if (!force && mastersLoadingRef.current) return;
      if (!force && nowMs - lastReloadAtRef.current < 800) return;

      lastReloadAtRef.current = nowMs;
      mastersLoadingRef.current = true;
      setMastersLoading(true);

      try {
        setLoadErr("");

        const masters = await fetchPickupMasters();
        const driversData = masters.drivers;
        const vehiclesData = masters.vehicles;
        const locationsData = masters.locations;
        const faresData = masters.fares;

        const sortedDrivers = [...driversData].sort((a, b) =>
          a.name.localeCompare(b.name, "ja")
        );
        const sortedVehicles = [...vehiclesData].sort((a, b) =>
          a.name.localeCompare(b.name, "ja")
        );
        const sortedLocations = [...locationsData].sort((a, b) =>
          a.name.localeCompare(b.name, "ja")
        );

        setDrivers(sortedDrivers);
        setVehicles(sortedVehicles);
        setLocations(sortedLocations);
        setFares(faresData);

        setDriverName((prev) => {
          if (prev && sortedDrivers.some((d) => d.name === prev)) return prev;
          return sortedDrivers[0]?.name ?? "";
        });

        setVehicleName((prev) => {
          if (prev && sortedVehicles.some((v) => v.name === prev)) return prev;
          return sortedVehicles[0]?.name ?? "";
        });

        setFromId((prev) => {
          if (prev == null) return null;
          return sortedLocations.some((l) => l.id === prev) ? prev : null;
        });

        setArrivals((prev) =>
          prev.map((a) => ({
            ...a,
            locationId:
              a.locationId != null && sortedLocations.some((l) => l.id === a.locationId)
                ? a.locationId
                : null,
          }))
        );
      } catch (e) {
        console.error("[reloadMasters]", e);
        setLoadErr(e instanceof Error ? e.message : "マスタ読込失敗");
      } finally {
        mastersLoadingRef.current = false;
        setMastersLoading(false);
      }
    },
    []
  );

  useEffect(() => {
    reloadMasters(true);
  }, [reloadMasters]);

  useEffect(() => {
    const onFocus = () => reloadMasters(true);
    const onPageShow = () => reloadMasters(true);
    const onVisibilityChange = () => {
      if (document.visibilityState === "visible") reloadMasters(true);
    };
    const onStorage = (e: StorageEvent) => {
      if (e.key === MASTER_UPDATED_KEY) reloadMasters(true);
    };

    window.addEventListener("focus", onFocus);
    window.addEventListener("pageshow", onPageShow);
    document.addEventListener("visibilitychange", onVisibilityChange);
    window.addEventListener("storage", onStorage);

    return () => {
      window.removeEventListener("focus", onFocus);
      window.removeEventListener("pageshow", onPageShow);
      document.removeEventListener("visibilitychange", onVisibilityChange);
      window.removeEventListener("storage", onStorage);
    };
  }, [reloadMasters]);

  useEffect(() => {
    const timer = setInterval(() => {
      const updatedAt = localStorage.getItem(MASTER_UPDATED_KEY) || "";
      if (updatedAt && updatedAt !== lastSeenMasterUpdateRef.current) {
        lastSeenMasterUpdateRef.current = updatedAt;
        reloadMasters(true);
        return;
      }
      reloadMasters(false);
    }, 5000);

    return () => clearInterval(timer);
  }, [reloadMasters]);

  const locMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const l of locations) m.set(l.id, l.name);
    return m;
  }, [locations]);

  const idToName = useCallback(
    (id: number | null) => (id == null ? "" : locMap.get(id) ?? String(id)),
    [locMap]
  );
  const visibleArrivals = arrivals.slice(0, arrivalCount);

  const routeChain = useMemo(() => {
    const names: string[] = [];
    if (fromId != null) names.push(idToName(fromId));
    for (let i = 0; i < arrivalCount; i++) {
      const n = idToName(arrivals[i].locationId);
      if (n) names.push(n);
    }
    return names.join("→");
  }, [fromId, arrivals, arrivalCount, locMap]);

  const computedAmountYen = useMemo(() => {
    if (mode === "bus") return 2000;
    if (fromId == null) return null;

    let cur = fromId;
    let sum = 0;

    for (let i = 0; i < arrivalCount; i++) {
      const next = arrivals[i].locationId;
      if (next == null) return null;

      const fare = getFareAmount(cur, next, fares);
      if (fare == null) return null;

      sum += fare;
      cur = next;
    }

    return sum;
  }, [mode, fromId, arrivals, arrivalCount, fares]);

  const segmentDistances = useMemo(() => {
    const s1 = calcSeg(departOdo, arrivals[0]?.odo ?? null);
    const s2 = calcSeg(arrivals[0]?.odo ?? null, arrivals[1]?.odo ?? null);
    const s3 = calcSeg(arrivals[1]?.odo ?? null, arrivals[2]?.odo ?? null);
    const s4 = calcSeg(arrivals[2]?.odo ?? null, arrivals[3]?.odo ?? null);
    const s5 = calcSeg(arrivals[3]?.odo ?? null, arrivals[4]?.odo ?? null);
    const s6 = calcSeg(arrivals[4]?.odo ?? null, arrivals[5]?.odo ?? null);
    const s7 = calcSeg(arrivals[5]?.odo ?? null, arrivals[6]?.odo ?? null);
    const s8 = calcSeg(arrivals[6]?.odo ?? null, arrivals[7]?.odo ?? null);
    return [s1, s2, s3, s4, s5, s6, s7, s8] as const;
  }, [departOdo, arrivals]);

  const totalDistanceKm = useMemo(() => sumSegs([...segmentDistances]), [segmentDistances]);

  const distanceInvalid = useMemo(() => {
    for (let i = 0; i < arrivalCount; i++) {
      const prev = i === 0 ? departOdo : arrivals[i - 1]?.odo ?? null;
      const cur = arrivals[i]?.odo ?? null;
      if (prev != null && cur != null && cur < prev) return true;
    }
    if (typeof totalDistanceKm === "number" && totalDistanceKm >= DIFF_LIMIT_KM) return true;
    return false;
  }, [arrivalCount, arrivals, departOdo, totalDistanceKm]);



  function updateArrival(index: number, patch: Partial<ArrivalInput>) {
    setArrivals((prev) => {
      const next = [...prev];
      next[index] = { ...next[index], ...patch };
      return next;
    });
  }

  function addArrival() {
    setArrivalCount((c) => Math.min(MAX_ARRIVALS, c + 1));
  }

  function removeLastArrival() {
    setArrivals((prev) => {
      const next = [...prev];
      const idx = Math.max(0, arrivalCount - 1);
      next[idx] = emptyArrival();
      return next;
    });
    setArrivalCount((c) => Math.max(1, c - 1));
  }

  const missingLabels = useMemo(() => {
    const miss: string[] = [];

    if (!driverName) miss.push("運転者");
    if (!vehicleName) miss.push("車両");

    if (mode === "route") {
      if (fromId == null) miss.push("出発地");
      for (let i = 0; i < arrivalCount; i++) {
        if (arrivals[i].locationId == null) miss.push(`到着${i + 1}（場所）`);
      }
      if (computedAmountYen == null) miss.push("金額");
    }

    if (departOdo == null) miss.push("ODO(出発)");

    for (let i = 0; i < arrivalCount; i++) {
      if (arrivals[i].odo == null) miss.push(`ODO(到着${i + 1})`);
    }

    if (distanceInvalid) miss.push("走行距離");

    return miss;
  }, [
    driverName,
    vehicleName,
    mode,
    fromId,
    arrivalCount,
    arrivals,
    computedAmountYen,
    departOdo,
    distanceInvalid,
  ]);

  const canSave = useMemo(
    () => missingLabels.length === 0 && !isSaving,
    [missingLabels, isSaving]
  );

  async function onSave() {
    if (isSaving) return;
    setStatus("");

    if (missingLabels.length) {
      setStatus("備考以外に未入力があるため保存できません");
      return;
    }

    setIsSaving(true);
    let shouldRollbackUploadedPhotos = false;
    let uploadedPhotoPathsForRollback: string[] = [];

    try {
      const capturedMode = mode;
      const capturedDriverName = driverName;
      const capturedVehicleName = vehicleName;
      const capturedFromId = fromId;
      const capturedDepartOdo = departOdo as number;
      const capturedDepartPhotoFile = departPhotoFile;
      const capturedVisibleArrivals = visibleArrivals.map((arrival) => ({ ...arrival }));
      const hasSelectedPhotos =
        Boolean(capturedDepartPhotoFile) ||
        capturedVisibleArrivals.some((arrival) => Boolean(arrival.photoFile));

      const uploadedPhotoRefs = hasSelectedPhotos
        ? await uploadSelectedPhotoReferences({
            departFile: capturedDepartPhotoFile,
            arrivals: capturedVisibleArrivals,
          }).catch((error) => {
            console.error("[onSave] photo upload failed", error);
            throw new Error(toPhotoUploadUserMessage(error));
          })
        : {
            depart: emptyPhotoReference(),
            arrivals: capturedVisibleArrivals.map(() => emptyPhotoReference()),
          };
      uploadedPhotoPathsForRollback = collectUploadedPhotoPaths(uploadedPhotoRefs);
      shouldRollbackUploadedPhotos = uploadedPhotoPathsForRollback.length > 0;

      const visibleArrivalPayload = capturedVisibleArrivals.map((arrival, index) => ({
        location_id: capturedMode === "bus" ? null : arrival.locationId,
        odometer_km: (arrival.odo ?? null) as number,
        photo_path: uploadedPhotoRefs.arrivals[index]?.photo_path ?? null,
        photo_url: uploadedPhotoRefs.arrivals[index]?.photo_url ?? null,
      }));
      const payloadForRoute: PickupOrderSaveRequest = {
        mode: capturedMode,
        driver_name: capturedDriverName,
        vehicle_name: capturedVehicleName,
        from_id: capturedMode === "bus" ? null : capturedFromId,
        depart_odometer_km: capturedDepartOdo,
        depart_photo_path: uploadedPhotoRefs.depart.photo_path,
        depart_photo_url: uploadedPhotoRefs.depart.photo_url,
        arrivals: visibleArrivalPayload,
      };

      const saved = await savePickupOrder(payloadForRoute);
      shouldRollbackUploadedPhotos = false;

      if (saved.delivery?.state === "sent") {
        setStatus("保存して送信しました");
      } else if (saved.delivery?.state === "pending") {
        setStatus("保存しました。送信中です。管理ページで確認してください");
      } else if (saved.delivery?.state === "failed") {
        setStatus("保存しました。送信は失敗したため管理ページから再送してください");
      } else {
        setStatus("保存しました");
      }

      setFromId(null);
      setArrivalCount(1);
      setArrivals(Array.from({ length: MAX_ARRIVALS }, () => emptyArrival()));
      setDepartOdo(null);
      setDepartPhotoFile(null);
      setNote("");
    } catch (e: unknown) {
      let rollbackIncompleteMessage: string | null = null;

      if (shouldRollbackUploadedPhotos) {
        try {
          const rollbackResult = await deleteUploadedPhotosForRollback(uploadedPhotoPathsForRollback);
          if (rollbackResult.failed_paths.length > 0) {
            rollbackIncompleteMessage =
              "保存は失敗し、写真ロールバックが未完了です。管理者へ連絡してください。";
            console.error("[onSave] rollback uploaded photos incomplete", {
              rollbackResult,
            });
          }
        } catch (rollbackError) {
          console.error("[onSave] rollback uploaded photos failed", {
            rollbackError,
            uploadedPhotoPathsForRollback,
          });
          rollbackIncompleteMessage =
            "保存は失敗し、写真ロールバック結果を確認できませんでした。管理者へ連絡してください。";
        }
      }

      if (rollbackIncompleteMessage) {
        setStatus(rollbackIncompleteMessage);
        return;
      }

      setStatus(e instanceof Error ? e.message : "保存でエラー");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="min-h-screen w-full overflow-x-hidden bg-[radial-gradient(circle_at_top,rgba(24,80,180,0.18),transparent_28%),linear-gradient(180deg,#020817_0%,#030712_100%)] px-3 pt-8 pb-4 text-white sm:px-6 sm:pt-10 sm:pb-8">
      <div className="mx-auto w-full max-w-4xl">
        <div className="mb-5 flex flex-col gap-3 sm:mb-7 sm:flex-row sm:items-start sm:justify-between">
          <div className="min-w-0 flex-1">
            <h1 className="break-keep text-left text-[30px] font-extrabold leading-[1.08] tracking-[-0.05em] sm:text-[38px]">
              ピックアップ手当
            </h1>
            <p className="mt-2 max-w-xl text-left text-[14px] leading-7 text-white/55 sm:text-lg">
              通常ルートは料金表参照 / バスは一律2,000円
            </p>
          </div>

          <div className="flex justify-start sm:justify-end">
            <Link
              href="/admin"
              className="inline-flex min-h-[52px] items-center justify-center rounded-[18px] border border-white/10 bg-white/5 px-5 py-2 text-base font-bold transition hover:bg-white/10"
            >
              管理ページへ
            </Link>
          </div>
        </div>

        <div className="w-full overflow-hidden rounded-[24px] border border-white/10 bg-[rgba(2,6,23,0.80)] p-4 shadow-[0_16px_50px_rgba(0,0,0,0.30)] backdrop-blur-[12px] sm:rounded-[28px] sm:p-6">
          <div className="mb-4 grid w-full grid-cols-[84px_1fr] items-start gap-x-3 gap-y-2 sm:grid-cols-[110px_1fr]">
            <div className="pt-3 text-xl text-white/65 sm:text-2xl">運転者</div>
            <div className="space-y-2">
              <select
                value={driverName}
                onChange={(e) => setDriverName(e.target.value)}
                className="min-h-[58px] w-full rounded-[18px] border border-white/10 bg-black/20 px-4 text-xl text-white outline-none sm:min-h-[64px] sm:rounded-[24px] sm:px-6 sm:text-2xl"
              >
                <option value="">選択</option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>
              <div className="flex justify-end">
                <span className="text-lg text-white/35 sm:text-xl">{drivers.length}人</span>
              </div>
            </div>
          </div>

          <div className="mb-4 grid w-full grid-cols-[84px_1fr] items-start gap-x-3 gap-y-2 sm:grid-cols-[110px_1fr]">
            <div className="pt-3 text-xl text-white/65 sm:text-2xl">車両</div>
            <div className="space-y-2">
              <select
                value={vehicleName}
                onChange={(e) => setVehicleName(e.target.value)}
                className="min-h-[58px] w-full rounded-[18px] border border-white/10 bg-black/20 px-4 text-xl text-white outline-none sm:min-h-[64px] sm:rounded-[24px] sm:px-6 sm:text-2xl"
              >
                <option value="">選択</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.name}>
                    {v.name}
                  </option>
                ))}
              </select>
              <div className="flex justify-end">
                <span className="text-lg text-white/35 sm:text-xl">{vehicles.length}台</span>
              </div>
            </div>
          </div>

          <div className="mb-5 grid grid-cols-2 gap-3 sm:mb-6 sm:gap-4">
            <button
              type="button"
              onClick={() => setMode("route")}
              className={`min-h-[70px] rounded-[20px] border text-xl font-bold transition sm:min-h-[78px] sm:rounded-[24px] sm:text-2xl ${
                mode === "route"
                  ? "border-blue-400/35 bg-[#20357b] text-white"
                  : "border-white/10 bg-white/5 text-white hover:bg-white/10"
              }`}
            >
              通常ルート
            </button>
            <button
              type="button"
              onClick={() => setMode("bus")}
              className={`min-h-[70px] rounded-[20px] border text-xl font-bold transition sm:min-h-[78px] sm:rounded-[24px] sm:text-2xl ${
                mode === "bus"
                  ? "border-blue-400/35 bg-[#20357b] text-white"
                  : "border-white/10 bg-white/5 text-white hover:bg-white/10"
              }`}
            >
              バス（固定）
            </button>
          </div>

          <div className="grid w-full grid-cols-[84px_1fr] items-start gap-x-3 gap-y-4 sm:grid-cols-[110px_1fr] sm:gap-y-5">
            <div className="pt-3 text-xl text-white/65 sm:text-2xl">出発地</div>
            <select
              value={fromId ?? ""}
              onChange={(e) => setFromId(e.target.value ? Number(e.target.value) : null)}
              className="min-h-[58px] w-full rounded-[18px] border border-white/10 bg-black/20 px-4 text-xl text-white outline-none disabled:opacity-50 sm:min-h-[64px] sm:rounded-[24px] sm:px-6 sm:text-2xl"
              disabled={mode === "bus"}
            >
              <option value="">選択</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>

            <div className="pt-3 text-xl text-white/65 sm:text-2xl">到着数</div>
            <div className="flex flex-wrap items-center gap-3">
              <button
                type="button"
                onClick={addArrival}
                disabled={arrivalCount >= MAX_ARRIVALS}
                className="min-h-[56px] rounded-[18px] border border-white/10 bg-white/5 px-4 text-lg font-bold transition hover:bg-white/10 disabled:opacity-50 sm:min-h-[64px] sm:rounded-[22px] sm:px-6 sm:text-2xl"
              >
                ＋ 到着を追加
              </button>
              <button
                type="button"
                onClick={removeLastArrival}
                disabled={arrivalCount <= 1}
                className="min-h-[56px] rounded-[18px] border border-white/10 bg-white/5 px-4 text-lg font-bold transition hover:bg-white/10 disabled:opacity-50 sm:min-h-[64px] sm:rounded-[22px] sm:px-6 sm:text-2xl"
              >
                － 最後の到着を削除
              </button>
              <span className="text-lg text-white/40 sm:text-2xl">最大{MAX_ARRIVALS}個</span>
            </div>

            <div className="pt-3 text-xl text-white/65 sm:text-2xl">ルート</div>
            <div className="min-h-[58px] w-full break-all rounded-[18px] border border-white/10 bg-black/20 px-4 py-3 text-xl sm:min-h-[64px] sm:rounded-[24px] sm:px-6 sm:py-4 sm:text-2xl">
              {routeChain || "—"}
            </div>

            <div className="pt-3 text-xl text-white/65 sm:text-2xl">金額</div>
            <div className="min-h-[58px] w-full rounded-[18px] border border-white/10 bg-black/20 px-4 py-3 text-xl sm:min-h-[64px] sm:rounded-[24px] sm:px-6 sm:py-4 sm:text-2xl">
              {mode === "bus" ? (
                <span className="font-bold">2000円</span>
              ) : computedAmountYen != null ? (
                <span className="font-bold">{computedAmountYen.toLocaleString()}円</span>
              ) : (
                <span className="text-white/50">—</span>
              )}
            </div>

            <div className="pt-3 text-xl text-white/65 sm:text-2xl">報告時間</div>
            <div className="min-h-[58px] w-full rounded-[18px] border border-white/10 bg-black/20 px-4 py-3 text-xl sm:min-h-[64px] sm:rounded-[24px] sm:px-6 sm:py-4 sm:text-2xl">
              {formatReportTimeJa(now)}
            </div>

            <div className="pt-3 text-xl text-white/65 sm:text-2xl">ODO(出発)</div>
            <input
              value={departOdo == null ? "" : String(departOdo)}
              onChange={(e) => {
                const v = onlyAsciiDigitsFromAnyWidth(e.target.value);
                setDepartOdo(v === "" ? null : Number(v));
              }}
              placeholder="例: １１２６０３（全角OK）"
              className="min-h-[58px] w-full rounded-[18px] border border-white/10 bg-black/20 px-4 text-xl text-white outline-none placeholder:text-white/30 sm:min-h-[64px] sm:rounded-[24px] sm:px-6 sm:text-2xl"
            />

            <div className="pt-3 text-xl text-white/65 sm:text-2xl">写真(出発) <span className="text-sm border border-white/30 rounded px-1 ml-1 bg-white/5">任意</span></div>
            <input
               type="file"
               accept="image/*"
               onChange={(e) => setDepartPhotoFile(e.target.files?.[0] || null)}
               className="min-h-[58px] w-full rounded-[18px] border border-white/10 bg-black/20 px-4 py-3 text-lg text-white/70 outline-none sm:min-h-[64px] sm:rounded-[24px] sm:px-6 sm:py-4 sm:text-xl file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-bold file:bg-white/10 file:text-white hover:file:bg-white/20"
            />
          </div>

          <div className="mt-6 space-y-4 sm:mt-7 sm:space-y-5">
            {visibleArrivals.map((a, idx) => {
              const segText =
                typeof segmentDistances[idx] === "number" ? `${segmentDistances[idx]} km` : "—";

              return (
                <div
                  key={`arrival-${idx}`}
                  className="rounded-[22px] border border-white/10 bg-[rgba(255,255,255,0.03)] p-4 sm:rounded-[26px] sm:p-5"
                >
                  <div className="mb-3 text-2xl font-extrabold tracking-[-0.03em] sm:mb-4 sm:text-3xl">
                    到着{idx + 1}
                  </div>

                  <div className="grid w-full grid-cols-[84px_1fr] items-start gap-x-3 gap-y-4 sm:grid-cols-[110px_1fr] sm:gap-y-5">
                    <div className="pt-3 text-xl text-white/65 sm:text-2xl">場所</div>
                    <select
                      value={a.locationId ?? ""}
                      onChange={(e) =>
                        updateArrival(idx, {
                          locationId: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      className="min-h-[58px] w-full rounded-[18px] border border-white/10 bg-black/20 px-4 text-xl text-white outline-none disabled:opacity-50 sm:min-h-[64px] sm:rounded-[24px] sm:px-6 sm:text-2xl"
                      disabled={mode === "bus"}
                    >
                      <option value="">選択</option>
                      {locations.map((l) => (
                        <option key={`loc-${idx}-${l.id}`} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>

                    <div className="pt-3 text-xl text-white/65 sm:text-2xl">ODO</div>
                    <input
                      value={a.odo == null ? "" : String(a.odo)}
                      onChange={(e) => {
                        const v = onlyAsciiDigitsFromAnyWidth(e.target.value);
                        updateArrival(idx, { odo: v === "" ? null : Number(v) });
                      }}
                      placeholder={`例: １１２８５０（到着${idx + 1} / 全角OK）`}
                      className="min-h-[58px] w-full rounded-[18px] border border-white/10 bg-black/20 px-4 text-xl text-white outline-none placeholder:text-white/30 sm:min-h-[64px] sm:rounded-[24px] sm:px-6 sm:text-2xl"
                    />

                    <div className="pt-3 text-xl text-white/65 sm:text-2xl">区間距離</div>
                    <div className="min-h-[58px] w-full rounded-[18px] border border-white/10 bg-black/20 px-4 py-3 text-xl text-white sm:min-h-[64px] sm:rounded-[24px] sm:px-6 sm:py-4 sm:text-2xl">
                      <div className="font-bold">
                        {idx === 0 ? `始→到着1: ${segText}` : `到着${idx}→到着${idx + 1}: ${segText}`}
                      </div>
                    </div>

                    <div className="pt-3 text-xl text-white/65 sm:text-2xl">
                      写真(到着{idx + 1}) <span className="text-sm border border-white/30 rounded px-1 ml-1 bg-white/5">任意</span>
                    </div>
                    <input
                      type="file"
                      accept="image/*"
                      onChange={(e) =>
                        updateArrival(idx, { photoFile: e.target.files?.[0] || null })
                      }
                      className="min-h-[58px] w-full rounded-[18px] border border-white/10 bg-black/20 px-4 py-3 text-lg text-white/70 outline-none sm:min-h-[64px] sm:rounded-[24px] sm:px-6 sm:py-4 sm:text-xl file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-bold file:bg-white/10 file:text-white hover:file:bg-white/20"
                    />

                  </div>
                </div>
              );
            })}
          </div>

          <div className="mt-6 grid w-full grid-cols-[84px_1fr] items-start gap-x-3 gap-y-4 sm:mt-7 sm:grid-cols-[110px_1fr] sm:gap-y-5">
            <div className="pt-3 text-xl text-white/65 sm:text-2xl">総走行距離</div>
            <div className="min-h-[58px] w-full rounded-[18px] border border-white/10 bg-black/20 px-4 py-3 text-xl sm:min-h-[64px] sm:rounded-[24px] sm:px-6 sm:py-4 sm:text-2xl">
              <span className="font-bold">
                {typeof totalDistanceKm === "number" ? `${totalDistanceKm} km` : "—"}
              </span>
            </div>

            <div className="pt-3 text-xl text-white/65 sm:text-2xl">備考</div>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="任意"
              className="min-h-[58px] w-full rounded-[18px] border border-white/10 bg-black/20 px-4 text-xl text-white outline-none placeholder:text-white/30 sm:min-h-[64px] sm:rounded-[24px] sm:px-6 sm:text-2xl"
            />
          </div>

          {loadErr ? <div className="mt-5 text-base text-white/60 sm:text-lg">{loadErr}</div> : null}
          {status ? (
            <div className="mt-5 whitespace-pre-wrap text-base text-white/75 sm:text-xl">
              {status}
            </div>
          ) : null}

          <button
            type="button"
            onClick={onSave}
            disabled={!canSave}
            className="mt-6 min-h-[66px] w-full rounded-[20px] border border-blue-400/30 bg-[#20357b] text-xl font-extrabold text-white transition hover:bg-[#26418f] disabled:opacity-50 sm:min-h-[72px] sm:rounded-[24px] sm:text-2xl"
            title={!canSave ? "備考以外に未入力があると保存できません" : ""}
          >
            {isSaving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </main>
  );
}
