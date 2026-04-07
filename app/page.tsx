"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";
import { uploadPhotoAsync } from "./components/PhotoUploadService";

type DriverRow = { id: number; name: string };
type VehicleRow = { id: number; name: string };
type LocationRow = { id: number; name: string; kind?: string | null };
type FareRow = { from_id: number; to_id: number; amount_yen: number };

type Mode = "route" | "bus";

type PickupOrderInsert = {
  driver_name: string;
  vehicle_name: string | null;
  is_bus: boolean;
  from_id: number | null;
  to_id: number | null;
  amount_yen: number;
  report_at: string;
  depart_odometer_km: number | null;
  arrive_odometer_km: number | null;
  depart_photo_path: string | null;
  depart_photo_url: string | null;
  arrive_photo_path: string | null;
  arrive_photo_url: string | null;
};

type ArrivalInput = {
  locationId: number | null;
  odo: number | null;
  photoFile?: File | null;
};

type FlowPayload = {
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
  "金額（円）": number | "";

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
  "想定距離（km）": number | "";
  "超過距離（km）": number | "";
  距離警告: string;
  区間警告詳細: string;

  備考: string;

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

const DIFF_LIMIT_KM = 100;
const MAX_ARRIVALS = 8;
const MASTER_UPDATED_KEY = "pickup_masters_updated_at";

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

function formatDateTimeForExcel(date: Date) {
  const { year, month, day, hour, minute } = getJstParts(date);
  return `${Number(year)}/${Number(month)}/${Number(day)} ${hour}:${minute}`;
}

function buildExcelPathForJst(date: Date) {
  const { year, month } = getJstParts(date);
  const monthNumber = Number(month);

  return `/General/雇用/送迎/${year}年送迎記録表/送迎${monthNumber}月自動反映.xlsx`;
}

function onlyAsciiDigitsFromAnyWidth(s: string) {
  return (s ?? "")
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/[^\d]/g, "");
}

function asCell(v: unknown): string | number | "" {
  if (v == null) return "";
  if (typeof v === "number") return Number.isFinite(v) ? v : "";
  const s = String(v).trim();
  return s === "" ? "" : s;
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
  if (!text) return [];
  return JSON.parse(text);
}

function normalizeItems<T>(data: unknown): T[] {
  if (!data) return [];
  if (Array.isArray(data)) return data as T[];
  const obj = data as Record<string, unknown>;
  if (Array.isArray(obj.items)) return obj.items as T[];
  if (Array.isArray(obj.data)) return obj.data as T[];
  return [];
}

async function fetchAdminList<T>(path: string): Promise<T[]> {
  const sep = path.includes("?") ? "&" : "?";
  const res = await fetch(`${path}${sep}ts=${Date.now()}`, {
    cache: "no-store",
    headers: {
      "cache-control": "no-store, no-cache, max-age=0, must-revalidate",
      pragma: "no-cache",
    },
  });
  return normalizeItems<T>(await readJsonOrThrow(res));
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

        const [driversData, vehiclesData, locationsData, faresData] = await Promise.all([
          fetchAdminList<DriverRow>("/api/admin/drivers"),
          fetchAdminList<VehicleRow>("/api/admin/vehicles"),
          fetchAdminList<LocationRow>("/api/admin/locations"),
          fetchAdminList<FareRow>("/api/admin/fares"),
        ]);

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



  async function postToFlow(payload: FlowPayload) {
    const res = await fetch("/api/powerautomate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let j: unknown = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
      j = null;
    }

    if (!res.ok) {
      const detail = j ? JSON.stringify(j) : text;
      throw new Error(`Power Automate送信失敗: ${res.status} ${detail}`);
    }

    const jobj = j as Record<string, unknown> | null;
    if (jobj && jobj.ok === false) {
      throw new Error(String(jobj.error || JSON.stringify(jobj)));
    }
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
    if (!supabase) return;
    if (isSaving) return;
    setStatus("");

    if (missingLabels.length) {
      setStatus("備考以外に未入力があるため保存できません");
      return;
    }

    setIsSaving(true);

    try {
      const nowAtSave = new Date();
      const reportAtIso = nowAtSave.toISOString();
      const reportAtExcel = formatDateTimeForExcel(nowAtSave);
      const excelPath = buildExcelPathForJst(nowAtSave);
      const amountToSave = mode === "bus" ? 2000 : (computedAmountYen as number);
      const finalArrival = arrivals[arrivalCount - 1];
      const payloadDb: PickupOrderInsert = {
        driver_name: driverName,
        vehicle_name: vehicleName || null,
        is_bus: mode === "bus",
        from_id: mode === "bus" ? null : fromId,
        to_id: mode === "bus" ? null : finalArrival?.locationId ?? null,
        amount_yen: amountToSave,
        report_at: reportAtIso,
        depart_odometer_km: departOdo,
        arrive_odometer_km: finalArrival?.odo ?? null,
        depart_photo_path: null,
        depart_photo_url: null,
        arrive_photo_path: null,
        arrive_photo_url: null,
      };

      const ins = await supabase.from("pickup_orders").insert(payloadDb).select("id").single();
      if (ins.error) throw new Error("DB insert失敗");
      const newRecordId = ins.data?.id;

      const arrivalNames = Array.from({ length: MAX_ARRIVALS }, (_, i) =>
        i < arrivalCount ? idToName(arrivals[i].locationId) : ""
      );

      const [s1, s2, s3, s4, s5, s6, s7, s8] = segmentDistances;

      const flowPayload: FlowPayload = {
        ExcelPath: excelPath,

        日付: reportAtExcel,
        運転者: driverName,
        車両: vehicleName,
        出発地: mode === "bus" ? "" : idToName(fromId),

        到着１: (asCell(arrivalNames[0]) as string) || "",
        到着２: (asCell(arrivalNames[1]) as string) || "",
        到着３: (asCell(arrivalNames[2]) as string) || "",
        到着４: (asCell(arrivalNames[3]) as string) || "",
        到着５: (asCell(arrivalNames[4]) as string) || "",
        到着６: (asCell(arrivalNames[5]) as string) || "",
        到着７: (asCell(arrivalNames[6]) as string) || "",
        到着８: (asCell(arrivalNames[7]) as string) || "",

        バス: mode === "bus" ? "バス" : "通常ルート",
        "金額（円）": asCell(amountToSave) as number | "",

        "距離（始）": asCell(departOdo) as number | "",
        "距離（終）": asCell(finalArrival?.odo ?? null) as number | "",
        "距離（始）〜到着１": asCell(s1) as number | "",
        "距離（到着１〜到着２）": asCell(s2) as number | "",
        "距離（到着２〜到着３）": asCell(s3) as number | "",
        "距離（到着３〜到着４）": asCell(s4) as number | "",
        "距離（到着４〜到着５）": asCell(s5) as number | "",
        "距離（到着５〜到着６）": asCell(s6) as number | "",
        "距離（到着６〜到着７）": asCell(s7) as number | "",
        "距離（到着７〜到着８）": asCell(s8) as number | "",

        "総走行距離（km）": asCell(totalDistanceKm) as number | "",
        "想定距離（km）": "",
        "超過距離（km）": "",
        距離警告: "",
        区間警告詳細: "",

        備考: note.trim(),

        出発写真URL: "",
        到着写真URL到着１: "",
        到着写真URL到着２: "",
        到着写真URL到着３: "",
        到着写真URL到着４: "",
        到着写真URL到着５: "",
        到着写真URL到着６: "",
        到着写真URL到着７: "",
        到着写真URL到着８: "",
      };

      try {
        await postToFlow(flowPayload);
        setStatus("保存しました");
      } catch (e: unknown) {
        console.error("[Power Automate send error]", e, flowPayload);
        setStatus("保存しました（Power Automate送信は失敗）");
      }

      if (newRecordId) {
        const capturedDepart = departPhotoFile;
        // 写真送信先APIがセットされていれば1枚だけ送信
        if (capturedDepart && process.env.NEXT_PUBLIC_PHOTO_API_URL) {
          uploadPhotoAsync({ orderId: newRecordId, photoKind: 'depart', file: capturedDepart })
            .then(success => {
              if (!success) {
                setStatus(prev => prev + "\n⚠️ 写真が送信できませんでした（後で再送できます）");
              }
            })
            .catch(() => {});
        }
      }

      setFromId(null);
      setArrivalCount(1);
      setArrivals(Array.from({ length: MAX_ARRIVALS }, () => emptyArrival()));
      setDepartOdo(null);
      setDepartPhotoFile(null);
      setNote("");
    } catch (e: unknown) {
      setStatus(e instanceof Error ? e.message : "保存でエラー");
    } finally {
      setIsSaving(false);
    }
  }

  if (!supabase) {
    return (
      <main className="min-h-screen w-full flex flex-col items-center pt-20 px-4 bg-[radial-gradient(circle_at_top,rgba(24,80,180,0.18),transparent_28%),linear-gradient(180deg,#020817_0%,#030712_100%)]">
        <div className="w-full max-w-xl rounded-[24px] border border-red-500/30 bg-[rgba(2,6,23,0.80)] p-6 sm:p-8 shadow-[0_16px_50px_rgba(0,0,0,0.30)] backdrop-blur-[12px] text-white">
          <h1 className="text-xl font-bold text-red-400 sm:text-2xl mb-4 text-center sm:text-left">
            Supabase環境変数が未設定です
          </h1>
          <p className="mb-4 text-white/80 text-[15px] sm:text-base leading-relaxed">
            このアプリを利用するには、ルートディレクトリに <code className="bg-black/30 border border-white/10 px-1.5 py-0.5 rounded text-blue-300">.env.local</code> を作成して以下の項目を設定してください。
          </p>
          <div className="bg-black/40 rounded-[12px] p-4 font-mono text-sm text-blue-200 border border-white/10 break-all overflow-hidden relative">
            NEXT_PUBLIC_SUPABASE_URL=...<br/>
            NEXT_PUBLIC_SUPABASE_ANON_KEY=...
          </div>
        </div>
      </main>
    );
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
            {process.env.NEXT_PUBLIC_PHOTO_API_URL ? (
              <input
                 type="file"
                 accept="image/*"
                 onChange={(e) => setDepartPhotoFile(e.target.files?.[0] || null)}
                 className="min-h-[58px] w-full rounded-[18px] border border-white/10 bg-black/20 px-4 py-3 text-lg text-white/70 outline-none sm:min-h-[64px] sm:rounded-[24px] sm:px-6 sm:py-4 sm:text-xl file:mr-4 file:py-2 file:px-4 file:rounded-full file:border-0 file:text-sm file:font-bold file:bg-white/10 file:text-white hover:file:bg-white/20"
              />
            ) : (
              <div className="text-red-400 mt-2">⚠️ 写真送信先未設定</div>
            )}
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
