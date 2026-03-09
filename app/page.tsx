"use client";

import Link from "next/link";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

/** ========= types ========= */
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
  photoFile: File | null;
  photoPreview: string | null;
  photoUploadedUrl: string | null;
  ocrDone: boolean;
};

type FlowPayload = {
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
  "距離（始）〜到着１": number | "";
  "距離（到着１〜到着２）": number | "";
  "距離（到着２〜到着３）": number | "";
  "距離（距離３〜到着４）": number | "";
  "距離（到着４〜到着５）": number | "";
  "距離（到着５〜到着６）": number | "";
  "距離（到着６〜到着７）": number | "";
  "距離（到着７〜到着８）": number | "";

  "総走行距離（km）": number | "";

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

type GoogleOcrResponse = {
  ok: boolean;
  rawText?: string;
  normalizedText?: string;
  candidates?: string[];
  bestCandidate?: string | null;
  error?: string;
};

/** ========= constants ========= */
const BUCKET = "order-photos";
const DIFF_LIMIT_KM = 100;
const MAX_ARRIVALS = 8;

/** ========= utils ========= */
function pad2(n: number) {
  return String(n).padStart(2, "0");
}

function formatReportTimeJa(date: Date) {
  const y = date.getFullYear() % 100;
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const hh = date.getHours();
  const mm = pad2(date.getMinutes());
  return `${y}年${m}月${d}日${hh}時${mm}分（自動）`;
}

function formatDateTimeForExcel(date: Date) {
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const hh = pad2(date.getHours());
  const mm = pad2(date.getMinutes());
  return `${y}/${m}/${d} ${hh}:${mm}`;
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

function emptyArrival(): ArrivalInput {
  return {
    locationId: null,
    odo: null,
    photoFile: null,
    photoPreview: null,
    photoUploadedUrl: null,
    ocrDone: false,
  };
}

function pickBestCandidateFromList(cands: string[]) {
  const clean = (cands ?? [])
    .map((s) => String(s).replace(/[^\d]/g, ""))
    .filter(Boolean);

  if (!clean.length) return null;

  const preferred = clean.filter((s) => s.length >= 5 && s.length <= 7);
  const pool = preferred.length ? preferred : clean;

  const score = (s: string) => {
    const n = s.length;
    let sc = 0;
    if (n === 6) sc += 100;
    else if (n === 5 || n === 7) sc += 80;
    else if (n === 4 || n === 8) sc += 40;
    else sc += 1;

    if (s.startsWith("0")) sc -= 5;
    sc += Math.min(new Set(s.split("")).size, 6);
    return sc;
  };

  return pool.sort((a, b) => score(b) - score(a))[0];
}

async function readJsonOrThrow(res: Response) {
  const text = await res.text();

  if (!res.ok) {
    throw new Error(text || `HTTP ${res.status}`);
  }

  if (!text) return [];
  return JSON.parse(text);
}

async function fetchDrivers(): Promise<DriverRow[]> {
  const res = await fetch("/api/admin/drivers", { cache: "no-store" });
  const data = await readJsonOrThrow(res);
  return Array.isArray(data) ? data : [];
}

async function fetchVehicles(): Promise<VehicleRow[]> {
  const res = await fetch("/api/admin/vehicles", { cache: "no-store" });
  const data = await readJsonOrThrow(res);
  return Array.isArray(data) ? data : [];
}

async function fetchLocations(): Promise<LocationRow[]> {
  const res = await fetch("/api/admin/locations", { cache: "no-store" });
  const data = await readJsonOrThrow(res);
  return Array.isArray(data) ? data : [];
}

async function fetchFares(): Promise<FareRow[]> {
  const res = await fetch("/api/admin/fares", { cache: "no-store" });
  const data = await readJsonOrThrow(res);
  return Array.isArray(data) ? data : [];
}

function getFareAmount(fromId: number | null, toId: number | null, fares: FareRow[]) {
  if (!fromId || !toId) return null;

  const direct = fares.find((x) => x.from_id === fromId && x.to_id === toId);
  if (direct) return direct.amount_yen;

  const reverse = fares.find((x) => x.from_id === toId && x.to_id === fromId);
  if (reverse) return reverse.amount_yen;

  return null;
}

/** OCR保護エリア（触らない） */
async function cropMeterArea(file: File): Promise<Blob> {
  const img = document.createElement("img");
  img.src = URL.createObjectURL(file);

  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () =>
      reject(new Error("画像読み込みに失敗（HEIC等はJPEG/PNGにしてね）"));
  });

  const W = img.naturalWidth;
  const H = img.naturalHeight;

  const left = Math.floor(W * 0.18);
  const top = Math.floor(H * 0.48);
  const width = Math.floor(W * 0.64);
  const height = Math.floor(H * 0.34);

  const canvas = document.createElement("canvas");
  canvas.width = 1600;
  canvas.height = Math.floor((1600 * height) / width);

  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("canvasが使えません");

  ctx.filter = "grayscale(1) contrast(1.45) brightness(1.1)";
  ctx.drawImage(img, left, top, width, height, 0, 0, canvas.width, canvas.height);

  URL.revokeObjectURL(img.src);

  const blob: Blob = await new Promise((resolve) =>
    canvas.toBlob((b) => resolve(b as Blob), "image/jpeg", 0.95)
  );

  return blob;
}

async function callGoogleOcr(imageFile: File): Promise<GoogleOcrResponse> {
  const fd = new FormData();
  fd.append("image", imageFile);

  const res = await fetch("/api/ocr/google", { method: "POST", body: fd });
  const text = await res.text();

  let j: any = null;
  try {
    j = text ? JSON.parse(text) : null;
  } catch {
    j = null;
  }

  if (!res.ok) {
    return { ok: false, error: j?.error || text || `HTTP ${res.status}` };
  }

  return (j ?? { ok: false, error: "empty response" }) as GoogleOcrResponse;
}

/** ========= main ========= */
export default function Page() {
  const [mode, setMode] = useState<Mode>("route");

  // masters
  const [drivers, setDrivers] = useState<DriverRow[]>([]);
  const [vehicles, setVehicles] = useState<VehicleRow[]>([]);
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [fares, setFares] = useState<FareRow[]>([]);
  const [loadErr, setLoadErr] = useState("");

  // driver / vehicle
  const [driverName, setDriverName] = useState<string>("");
  const [vehicleName, setVehicleName] = useState<string>("");

  // route
  const [fromId, setFromId] = useState<number | null>(null);
  const [arrivalCount, setArrivalCount] = useState<number>(1);
  const [arrivals, setArrivals] = useState<ArrivalInput[]>(
    Array.from({ length: MAX_ARRIVALS }, () => emptyArrival())
  );

  // depart
  const [departOdo, setDepartOdo] = useState<number | null>(null);
  const [departPhoto, setDepartPhoto] = useState<File | null>(null);
  const [departPreview, setDepartPreview] = useState<string | null>(null);

  // ui
  const [status, setStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [ocrBusyKey, setOcrBusyKey] = useState<string | null>(null);
  const [note, setNote] = useState("");

  // time
  const [now, setNow] = useState<Date>(() => new Date());

  // file input refs
  const departFileRef = useRef<HTMLInputElement | null>(null);
  const arrivalFileRefs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  /** ========= masters load ========= */
  const reloadMasters = useCallback(async () => {
    try {
      setLoadErr("");

      const [driversData, vehiclesData, locationsData, faresData] = await Promise.all([
        fetchDrivers(),
        fetchVehicles(),
        fetchLocations(),
        fetchFares(),
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
        if (prev == null) return prev;
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
      setDrivers([]);
      setVehicles([]);
      setLocations([]);
      setFares([]);
    }
  }, []);

  useEffect(() => {
    reloadMasters();
  }, [reloadMasters]);

  useEffect(() => {
    const handleFocus = () => {
      reloadMasters();
    };

    const handlePageShow = () => {
      reloadMasters();
    };

    const handleVisibilityChange = () => {
      if (document.visibilityState === "visible") {
        reloadMasters();
      }
    };

    window.addEventListener("focus", handleFocus);
    window.addEventListener("pageshow", handlePageShow);
    document.addEventListener("visibilitychange", handleVisibilityChange);

    return () => {
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("pageshow", handlePageShow);
      document.removeEventListener("visibilitychange", handleVisibilityChange);
    };
  }, [reloadMasters]);

  /** ========= lookups ========= */
  const locMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const l of locations) m.set(l.id, l.name);
    return m;
  }, [locations]);

  const idToName = (id: number | null) => (id == null ? "" : locMap.get(id) ?? String(id));
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

  /** ========= fare ========= */
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

  /** ========= distances ========= */
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

  /** ========= preview ========= */
  useEffect(() => {
    if (!departPhoto) {
      setDepartPreview(null);
      return;
    }
    const url = URL.createObjectURL(departPhoto);
    setDepartPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [departPhoto]);

  /** ========= arrivals helpers ========= */
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
      const old = next[idx];
      if (old?.photoPreview) URL.revokeObjectURL(old.photoPreview);
      next[idx] = emptyArrival();
      return next;
    });
    setArrivalCount((c) => Math.max(1, c - 1));
  }

  /** ========= OCR ========= */
  async function runOcrGoogleStrong(file: File, target: "depart" | number) {
    const key = target === "depart" ? "depart" : `arrive-${target}`;
    if (ocrBusyKey) return;

    setOcrBusyKey(key);

    const applyOdo = (num: number) => {
      if (target === "depart") {
        setDepartOdo(num);
      } else {
        updateArrival(target, { odo: num });
      }
    };

    const markDone = () => {
      if (target === "depart") return;
      updateArrival(target, { ocrDone: true });
    };

    try {
      const croppedBlob = await cropMeterArea(file);
      const croppedFile = new File([croppedBlob], "meter-crop.jpg", { type: "image/jpeg" });

      let r = await callGoogleOcr(croppedFile);
      let cands = [r.bestCandidate ?? "", ...(r.candidates ?? [])].filter(Boolean);
      let best = pickBestCandidateFromList(cands);

      if (!best) {
        r = await callGoogleOcr(file);
        cands = [r.bestCandidate ?? "", ...(r.candidates ?? [])].filter(Boolean);
        best = pickBestCandidateFromList(cands);
      }

      if (!best) {
        markDone();
        return;
      }

      const num = Number(best);
      if (!Number.isFinite(num)) {
        markDone();
        return;
      }

      applyOdo(num);
      markDone();
    } catch {
      markDone();
    } finally {
      setOcrBusyKey(null);
    }
  }

  useEffect(() => {
    if (!departPhoto) return;
    runOcrGoogleStrong(departPhoto, "depart");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departPhoto]);

  useEffect(() => {
    for (let i = 0; i < arrivalCount; i++) {
      const a = arrivals[i];
      if (a.photoFile && !a.ocrDone) {
        runOcrGoogleStrong(a.photoFile, i);
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrivals, arrivalCount]);

  /** ========= storage ========= */
  async function uploadOnePhoto(file: File, prefix: string) {
    const ext = file.name.split(".").pop() || "jpg";
    const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const path = filename;

    const up = await supabase.storage.from(BUCKET).upload(path, file, {
      upsert: true,
      contentType: file.type || "image/jpeg",
    });
    if (up.error) {
      console.error("[storage upload]", up.error);
      throw new Error("写真アップロードに失敗（Storage/RLS/バケット設定を確認）");
    }

    const pub = supabase.storage.from(BUCKET).getPublicUrl(path);
    return { path, url: pub.data?.publicUrl ?? null };
  }

  /** ========= Power Automate ========= */
  async function postToFlow(payload: FlowPayload) {
    const res = await fetch("/api/powerautomate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let j: any = null;
    try {
      j = text ? JSON.parse(text) : null;
    } catch {
      j = null;
    }

    if (!res.ok) {
      const detail = j ? JSON.stringify(j) : text;
      throw new Error(`Power Automate送信失敗: ${res.status} ${detail}`);
    }

    if (j && j.ok === false) {
      throw new Error(j.error || JSON.stringify(j));
    }
  }

  /** ========= validation ========= */
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
    if (!departPhoto) miss.push("写真(出発)");

    for (let i = 0; i < arrivalCount; i++) {
      if (arrivals[i].odo == null) miss.push(`ODO(到着${i + 1})`);
      if (!arrivals[i].photoFile) miss.push(`写真(到着${i + 1})`);
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
    departPhoto,
    distanceInvalid,
  ]);

  const canSave = useMemo(() => missingLabels.length === 0 && !isSaving, [missingLabels, isSaving]);

  /** ========= save ========= */
  async function onSave() {
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
      const amountToSave = mode === "bus" ? 2000 : (computedAmountYen as number);

      let depart_photo_path: string | null = null;
      let depart_photo_url: string | null = null;
      if (departPhoto) {
        const r = await uploadOnePhoto(departPhoto, "depart");
        depart_photo_path = r.path;
        depart_photo_url = r.url;
      }

      const arrivalPhotoUrls: string[] = Array(MAX_ARRIVALS).fill("");
      let lastArrivalPhotoPath: string | null = null;
      let lastArrivalPhotoUrl: string | null = null;

      for (let i = 0; i < MAX_ARRIVALS; i++) {
        const a = arrivals[i];
        if (!a.photoFile) continue;
        const uploaded = await uploadOnePhoto(a.photoFile, `arrive_${i + 1}`);
        arrivalPhotoUrls[i] = uploaded.url ?? "";
        if (i === arrivalCount - 1) {
          lastArrivalPhotoPath = uploaded.path;
          lastArrivalPhotoUrl = uploaded.url ?? null;
        }
      }

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
        depart_photo_path,
        depart_photo_url,
        arrive_photo_path: lastArrivalPhotoPath,
        arrive_photo_url: lastArrivalPhotoUrl,
      };

      const ins = await supabase.from("pickup_orders").insert(payloadDb);
      if (ins.error) {
        const e: any = ins.error;
        throw new Error(
          `DB insert失敗: ${e?.message ?? ""} ${e?.details ?? ""} ${e?.hint ?? ""} (${e?.code ?? ""})`.trim()
        );
      }

      const arrivalNames = Array.from({ length: MAX_ARRIVALS }, (_, i) =>
        i < arrivalCount ? idToName(arrivals[i].locationId) : ""
      );

      const [s1, s2, s3, s4, s5, s6, s7, s8] = segmentDistances;

      const flowPayload: FlowPayload = {
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
        "距離（始）〜到着１": asCell(s1) as number | "",
        "距離（到着１〜到着２）": asCell(s2) as number | "",
        "距離（到着２〜到着３）": asCell(s3) as number | "",
        "距離（距離３〜到着４）": asCell(s4) as number | "",
        "距離（到着４〜到着５）": asCell(s5) as number | "",
        "距離（到着５〜到着６）": asCell(s6) as number | "",
        "距離（到着６〜到着７）": asCell(s7) as number | "",
        "距離（到着７〜到着８）": asCell(s8) as number | "",

        "総走行距離（km）": asCell(totalDistanceKm) as number | "",

        備考: (note ?? "").trim(),

        出発写真URL: depart_photo_url ?? "",
        到着写真URL到着１: arrivalPhotoUrls[0] ?? "",
        到着写真URL到着２: arrivalPhotoUrls[1] ?? "",
        到着写真URL到着３: arrivalPhotoUrls[2] ?? "",
        到着写真URL到着４: arrivalPhotoUrls[3] ?? "",
        到着写真URL到着５: arrivalPhotoUrls[4] ?? "",
        到着写真URL到着６: arrivalPhotoUrls[5] ?? "",
        到着写真URL到着７: arrivalPhotoUrls[6] ?? "",
        到着写真URL到着８: arrivalPhotoUrls[7] ?? "",
      };

      try {
        await postToFlow(flowPayload);
        setStatus("保存しました");
      } catch (e: any) {
        console.error("[flow send]", e);
        setStatus("保存しました（Power Automate送信は失敗）");
      }

      setFromId(null);
      setArrivalCount(1);
      setArrivals(Array.from({ length: MAX_ARRIVALS }, () => emptyArrival()));
      setDepartPhoto(null);
      setDepartOdo(null);
      setNote("");
    } catch (e: any) {
      setStatus(e?.message ?? "保存でエラー");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-[radial-gradient(circle_at_top,rgba(24,80,180,0.18),transparent_28%),linear-gradient(180deg,#020817_0%,#030712_100%)] text-white px-4 py-6 sm:px-6 sm:py-8">
      <div className="mx-auto w-full max-w-4xl">
        <div className="mb-8 flex items-start justify-between gap-4">
          <div className="min-w-0 flex-1">
<h1 className="break-keep text-center text-[42px] font-extrabold tracking-[-0.05em] leading-[1.08] sm:text-5xl">
  ピックアップ手当
</h1>
          <p className="mx-auto mt-3 max-w-xl text-center text-base leading-8 text-white/55 sm:text-xl">
  通常ルートは料金表参照 / バスは一律2,000円
</p>          </div>

          <Link
            href="/admin"
            className="shrink-0 rounded-[20px] border border-white/10 bg-white/5 px-5 py-4 text-lg font-bold text-white transition hover:bg-white/10 sm:px-6"
          >
            管理ページへ
          </Link>
        </div>

        <div className="rounded-[30px] border border-white/10 bg-[rgba(2,6,23,0.78)] p-5 shadow-[0_16px_50px_rgba(0,0,0,0.30)] backdrop-blur-[12px] sm:p-7">
          {/* 運転者 */}
          <div className="mb-5 grid grid-cols-[96px_1fr] items-start gap-4 sm:grid-cols-[120px_1fr]">
            <div className="pt-3 text-2xl text-white/65">運転者</div>
            <div className="space-y-3">
              <select
                value={driverName}
                onChange={(e) => setDriverName(e.target.value)}
                className="min-h-[64px] w-full rounded-[24px] border border-white/10 bg-black/20 px-6 text-2xl text-white outline-none"
              >
                <option value="">選択</option>
                {drivers.map((d) => (
                  <option key={d.id} value={d.name}>
                    {d.name}
                  </option>
                ))}
              </select>

              <div className="flex justify-end">
                <span className="text-xl text-white/35">{drivers.length}人</span>
              </div>
            </div>
          </div>

          {/* 車両 */}
          <div className="mb-5 grid grid-cols-[96px_1fr] items-start gap-4 sm:grid-cols-[120px_1fr]">
            <div className="pt-3 text-2xl text-white/65">車両</div>
            <div className="space-y-3">
              <select
                value={vehicleName}
                onChange={(e) => setVehicleName(e.target.value)}
                className="min-h-[64px] w-full rounded-[24px] border border-white/10 bg-black/20 px-6 text-2xl text-white outline-none"
              >
                <option value="">選択</option>
                {vehicles.map((v) => (
                  <option key={v.id} value={v.name}>
                    {v.name}
                  </option>
                ))}
              </select>

              <div className="flex justify-end">
                <span className="text-xl text-white/35">{vehicles.length}台</span>
              </div>
            </div>
          </div>

          {/* モード */}
          <div className="mb-6 grid grid-cols-2 gap-4">
            <button
              type="button"
              onClick={() => setMode("route")}
              className={`min-h-[78px] rounded-[24px] border text-2xl font-bold transition ${
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
              className={`min-h-[78px] rounded-[24px] border text-2xl font-bold transition ${
                mode === "bus"
                  ? "border-blue-400/35 bg-[#20357b] text-white"
                  : "border-white/10 bg-white/5 text-white hover:bg-white/10"
              }`}
            >
              バス（固定）
            </button>
          </div>

          {/* 上部フォーム */}
          <div className="grid grid-cols-[96px_1fr] items-start gap-x-4 gap-y-5 sm:grid-cols-[120px_1fr]">
            <div className="pt-3 text-2xl text-white/65">出発地</div>
            <select
              value={fromId ?? ""}
              onChange={(e) => setFromId(e.target.value ? Number(e.target.value) : null)}
              className="min-h-[64px] w-full rounded-[24px] border border-white/10 bg-black/20 px-6 text-2xl text-white outline-none disabled:opacity-50"
              disabled={mode === "bus"}
            >
              <option value="">選択</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>

            <div className="pt-3 text-2xl text-white/65">到着数</div>
            <div className="flex flex-wrap items-center gap-4">
              <button
                type="button"
                onClick={addArrival}
                disabled={arrivalCount >= MAX_ARRIVALS}
                className="min-h-[64px] rounded-[22px] border border-white/10 bg-white/5 px-6 text-2xl font-bold transition hover:bg-white/10 disabled:opacity-50"
              >
                ＋ 到着を追加
              </button>
              <button
                type="button"
                onClick={removeLastArrival}
                disabled={arrivalCount <= 1}
                className="min-h-[64px] rounded-[22px] border border-white/10 bg-white/5 px-6 text-2xl font-bold transition hover:bg-white/10 disabled:opacity-50"
              >
                － 最後の到着を削除
              </button>
              <span className="text-2xl text-white/40">最大{MAX_ARRIVALS}個</span>
            </div>

            <div className="pt-3 text-2xl text-white/65">ルート</div>
            <div className="min-h-[64px] w-full break-all rounded-[24px] border border-white/10 bg-black/20 px-6 py-4 text-2xl">
              {routeChain || "—"}
            </div>

            <div className="pt-3 text-2xl text-white/65">金額</div>
            <div className="min-h-[64px] w-full rounded-[24px] border border-white/10 bg-black/20 px-6 py-4 text-2xl">
              {mode === "bus" ? (
                <span className="font-bold">2000円</span>
              ) : computedAmountYen != null ? (
                <span className="font-bold">{computedAmountYen.toLocaleString()}円</span>
              ) : (
                <span className="text-white/50">—</span>
              )}
            </div>

            <div className="pt-3 text-2xl text-white/65">報告時間</div>
            <div className="min-h-[64px] w-full rounded-[24px] border border-white/10 bg-black/20 px-6 py-4 text-2xl">
              {formatReportTimeJa(now)}
            </div>

            <div className="pt-3 text-2xl text-white/65">ODO(出発)</div>
            <div>
              <input
                value={departOdo == null ? "" : String(departOdo)}
                onChange={(e) => {
                  const v = onlyAsciiDigitsFromAnyWidth(e.target.value);
                  setDepartOdo(v === "" ? null : Number(v));
                }}
                placeholder="例: １１２６０３（全角OK）"
                className="min-h-[64px] w-full rounded-[24px] border border-white/10 bg-black/20 px-6 text-2xl text-white outline-none placeholder:text-white/30"
              />
            </div>

            <div className="pt-3 text-2xl text-white/65">写真(出発)</div>
            <div>
              <input
                ref={departFileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setDepartPhoto(f);
                  e.currentTarget.value = "";
                }}
              />
              <div className="flex flex-wrap items-center gap-4">
                <button
                  type="button"
                  onClick={() => departFileRef.current?.click()}
                  className="min-h-[58px] rounded-[20px] border border-white/10 bg-white/5 px-5 text-xl font-bold transition hover:bg-white/10"
                >
                  写真を選ぶ
                </button>
                <span className="text-xl text-white/65">
                  {departPhoto ? departPhoto.name : "未選択"}
                </span>
              </div>
              {departPreview ? (
                <div className="mt-4">
                  <img
                    src={departPreview}
                    alt="depart preview"
                    className="max-h-52 rounded-[20px] border border-white/10"
                  />
                </div>
              ) : null}
            </div>
          </div>

          {/* 到着1〜8 */}
          <div className="mt-7 space-y-5">
            {visibleArrivals.map((a, idx) => {
              const segText =
                typeof segmentDistances[idx] === "number" ? `${segmentDistances[idx]} km` : "—";

              return (
                <div
                  key={`arrival-${idx}`}
                  className="rounded-[26px] border border-white/10 bg-[rgba(255,255,255,0.03)] p-5"
                >
                  <div className="mb-4 text-3xl font-extrabold tracking-[-0.03em]">
                    到着{idx + 1}
                  </div>

                  <div className="grid grid-cols-[96px_1fr] items-start gap-x-4 gap-y-5 sm:grid-cols-[120px_1fr]">
                    <div className="pt-3 text-2xl text-white/65">場所</div>
                    <select
                      value={a.locationId ?? ""}
                      onChange={(e) =>
                        updateArrival(idx, {
                          locationId: e.target.value ? Number(e.target.value) : null,
                        })
                      }
                      className="min-h-[64px] w-full rounded-[24px] border border-white/10 bg-black/20 px-6 text-2xl text-white outline-none disabled:opacity-50"
                      disabled={mode === "bus"}
                    >
                      <option value="">選択</option>
                      {locations.map((l) => (
                        <option key={`loc-${idx}-${l.id}`} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>

                    <div className="pt-3 text-2xl text-white/65">ODO</div>
                    <div>
                      <input
                        value={a.odo == null ? "" : String(a.odo)}
                        onChange={(e) => {
                          const v = onlyAsciiDigitsFromAnyWidth(e.target.value);
                          updateArrival(idx, { odo: v === "" ? null : Number(v) });
                        }}
                        placeholder={`例: １１２８５０（到着${idx + 1} / 全角OK）`}
                        className="min-h-[64px] w-full rounded-[24px] border border-white/10 bg-black/20 px-6 text-2xl text-white outline-none placeholder:text-white/30"
                      />
                    </div>

                    <div className="pt-3 text-2xl text-white/65">区間距離</div>
                    <div className="min-h-[64px] w-full rounded-[24px] border border-white/10 bg-black/20 px-6 py-4 text-2xl">
                      {idx === 0 ? `始→到着1: ${segText}` : `到着${idx}→到着${idx + 1}: ${segText}`}
                    </div>

                    <div className="pt-3 text-2xl text-white/65">写真</div>
                    <div>
                      <input
                        ref={(el) => {
                          arrivalFileRefs.current[idx] = el;
                        }}
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0] ?? null;

                          if (a.photoPreview) URL.revokeObjectURL(a.photoPreview);

                          if (!f) {
                            updateArrival(idx, {
                              photoFile: null,
                              photoPreview: null,
                              ocrDone: false,
                            });
                            e.currentTarget.value = "";
                            return;
                          }

                          const preview = URL.createObjectURL(f);
                          updateArrival(idx, {
                            photoFile: f,
                            photoPreview: preview,
                            photoUploadedUrl: null,
                            ocrDone: false,
                          });

                          e.currentTarget.value = "";
                        }}
                      />
                      <div className="flex flex-wrap items-center gap-4">
                        <button
                          type="button"
                          onClick={() => arrivalFileRefs.current[idx]?.click()}
                          className="min-h-[58px] rounded-[20px] border border-white/10 bg-white/5 px-5 text-xl font-bold transition hover:bg-white/10"
                        >
                          写真を選ぶ
                        </button>
                        <span className="text-xl text-white/65">
                          {a.photoFile ? a.photoFile.name : "未選択"}
                        </span>
                      </div>
                      {a.photoPreview ? (
                        <div className="mt-4">
                          <img
                            src={a.photoPreview}
                            alt={`arrival-${idx + 1}-preview`}
                            className="max-h-52 rounded-[20px] border border-white/10"
                          />
                        </div>
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* 下部 */}
          <div className="mt-7 grid grid-cols-[96px_1fr] items-start gap-x-4 gap-y-5 sm:grid-cols-[120px_1fr]">
            <div className="pt-3 text-2xl text-white/65">総走行距離</div>
            <div className="min-h-[64px] w-full rounded-[24px] border border-white/10 bg-black/20 px-6 py-4 text-2xl">
              <span className="font-bold">
                {typeof totalDistanceKm === "number" ? `${totalDistanceKm} km` : "—"}
              </span>
            </div>

            <div className="pt-3 text-2xl text-white/65">備考</div>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="任意"
              className="min-h-[64px] w-full rounded-[24px] border border-white/10 bg-black/20 px-6 text-2xl text-white outline-none placeholder:text-white/30"
            />
          </div>

          {loadErr ? <div className="mt-5 text-lg text-white/60">{loadErr}</div> : null}
          {status ? (
            <div className="mt-5 whitespace-pre-wrap text-xl text-white/75">{status}</div>
          ) : null}

          <button
            type="button"
            onClick={onSave}
            disabled={!canSave}
            className="mt-6 min-h-[72px] w-full rounded-[24px] border border-blue-400/30 bg-[#20357b] text-2xl font-extrabold text-white transition hover:bg-[#26418f] disabled:opacity-50"
            title={!canSave ? "備考以外に未入力があると保存できません" : ""}
          >
            {isSaving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </main>
  );
}
