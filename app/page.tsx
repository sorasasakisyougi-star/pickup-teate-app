"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Tesseract from "tesseract.js";
import { supabase } from "@/lib/supabaseClient";

/** ========= types ========= */
type LocationRow = { id: number; name: string; kind?: string | null };
type FareRow = { from_id: number; to_id: number; amount_yen: number };
type Mode = "route" | "bus";

type PickupOrderInsert = {
  driver_name: string;
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
  ocrStatus: string;
};

type FlowPayload = {
  日付: string;
  運転者: string;
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

/** ========= constants ========= */
const DEFAULT_DRIVER_NAMES = [
  "拓哉",
  "ロヒップ",
  "カビブ",
  "ナルディ",
  "フェブリ",
  "アジ",
  "ダニ",
  "ハン",
  "アンガ",
  "コウォ",
  "ワヒュ",
  "ソレ",
  "照太",
  "エルヴァンド",
  "ヨガ",
  "ヘンキ",
  "ラフリ",
  "大空",
  "優稀",
  "ワルヨ",
  "アンディ",
  "ディカ",
  "ディッキー",
] as const;

const DRIVER_STORAGE_KEY = "pickup_driver_names_v1";

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
function toHalfWidthDigits(s: string) {
  return (s ?? "").replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}
function onlyAsciiDigitsFromAnyWidth(s: string) {
  const half = toHalfWidthDigits(s);
  return half.replace(/[^\d]/g, "");
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
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
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
    ocrStatus: "",
  };
}
function uniqStrings(arr: string[]) {
  return [...new Set(arr.map((s) => s.trim()).filter(Boolean))];
}
function pickBestDigits(text: string) {
  const cands = (text.replace(/\s/g, "").match(/\d{3,9}/g) ?? []).map(String);
  if (!cands.length) return null;
  const score = (s: string) => {
    let sc = 0;
    const n = s.length;
    if (n === 6) sc += 12;
    else if (n === 5 || n === 7) sc += 10;
    else if (n === 4 || n === 8) sc += 6;
    else sc += 2;
    if (s.startsWith("0")) sc -= 1;
    sc += Math.min(new Set(s.split("")).size, 6);
    return sc;
  };
  return cands.sort((a, b) => score(b) - score(a))[0];
}

/** OCR保護エリア */
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

export default function Page() {
  const [mode, setMode] = useState<Mode>("route");

  // master
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [fares, setFares] = useState<FareRow[]>([]);
  const [loadErr, setLoadErr] = useState("");

  // driver (editable in-app)
  const [driverNames, setDriverNames] = useState<string[]>([]);
  const [driverName, setDriverName] = useState<string>("");
  const [newDriverName, setNewDriverName] = useState("");

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
  const [departOcrStatus, setDepartOcrStatus] = useState("");

  // note / ui
  const [note, setNote] = useState("");
  const [status, setStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [ocrBusyKey, setOcrBusyKey] = useState<string | null>(null);

  // time
  const [now, setNow] = useState<Date>(() => new Date());

  // file input refs (写真を選ぶボタン用)
  const departFileRef = useRef<HTMLInputElement | null>(null);
  const arrivalFileRefs = useRef<Array<HTMLInputElement | null>>([]);

  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  /** 運転者リスト読み込み（localStorage） */
  useEffect(() => {
    try {
      const raw = localStorage.getItem(DRIVER_STORAGE_KEY);
      if (!raw) {
        const initial = [...DEFAULT_DRIVER_NAMES];
        setDriverNames(initial);
        setDriverName(initial[0] ?? "");
        return;
      }
      const parsed = JSON.parse(raw);
      if (!Array.isArray(parsed)) throw new Error("invalid driver list");
      const clean = uniqStrings(parsed.map(String));
      const merged = clean.length ? clean : [...DEFAULT_DRIVER_NAMES];
      setDriverNames(merged);
      setDriverName((prev) => (prev && merged.includes(prev) ? prev : merged[0] ?? ""));
    } catch {
      const fallback = [...DEFAULT_DRIVER_NAMES];
      setDriverNames(fallback);
      setDriverName(fallback[0] ?? "");
    }
  }, []);

  /** 運転者リスト保存 */
  useEffect(() => {
    if (!driverNames.length) return;
    try {
      localStorage.setItem(DRIVER_STORAGE_KEY, JSON.stringify(driverNames));
    } catch {
      // 容量/プライベートモード等は無視
    }
  }, [driverNames]);

  function addDriver() {
    const name = newDriverName.trim();
    if (!name) return;
    setDriverNames((prev) => {
      const next = uniqStrings([...prev, name]);
      return next;
    });
    setDriverName(name);
    setNewDriverName("");
  }

  function removeDriver(name: string) {
    setDriverNames((prev) => {
      const next = prev.filter((x) => x !== name);
      if (next.length === 0) return [...DEFAULT_DRIVER_NAMES];
      return next;
    });
    setDriverName((prev) => (prev === name ? "" : prev));
  }

  /** masters */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoadErr("");
      try {
        const locRes = await supabase.from("locations").select("id,name,kind").order("name", { ascending: true });
        if (locRes.error) {
          if (!cancelled) {
            setLocations([]);
            setLoadErr("locations取得に失敗（RLS/権限/テーブル名を確認）");
            console.error("[locations fetch]", locRes.error);
          }
        } else if (!cancelled) {
          setLocations((locRes.data ?? []) as LocationRow[]);
        }

        const fareRes = await supabase.from("route_fares").select("from_id,to_id,amount_yen");
        if (fareRes.error) {
          if (!cancelled) {
            setFares([]);
            setLoadErr((prev) =>
              prev ? prev + " / fares取得に失敗（RLS/権限/テーブル名）" : "fares取得に失敗（RLS/権限/テーブル名を確認）"
            );
            console.error("[fares fetch]", fareRes.error);
          }
        } else if (!cancelled) {
          setFares((fareRes.data ?? []) as FareRow[]);
        }
      } catch (e) {
        if (!cancelled) {
          setLocations([]);
          setFares([]);
          setLoadErr("データ取得で例外が発生（console参照）");
          console.error(e);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, []);

  /** lookup */
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

  /** fare */
  function findFare(a: number, b: number): number | null {
    const direct = fares.find((f) => f.from_id === a && f.to_id === b);
    if (direct) return direct.amount_yen;
    const reverse = fares.find((f) => f.from_id === b && f.to_id === a);
    if (reverse) return reverse.amount_yen;
    return null;
  }

  const computedAmountYen = useMemo(() => {
    if (mode === "bus") return 2000;
    if (fromId == null) return null;

    let cur = fromId;
    let sum = 0;
    for (let i = 0; i < arrivalCount; i++) {
      const next = arrivals[i].locationId;
      if (next == null) return null;
      if (next === cur) return null;
      const fare = findFare(cur, next);
      if (fare == null) return null;
      sum += fare;
      cur = next;
    }
    return sum;
  }, [mode, fromId, arrivals, arrivalCount, fares]);

  /** distance */
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

  const distanceHint = useMemo(() => {
    for (let i = 0; i < arrivalCount; i++) {
      const prev = i === 0 ? departOdo : arrivals[i - 1]?.odo ?? null;
      const cur = arrivals[i]?.odo ?? null;
      if (prev != null && cur != null && cur < prev) {
        return `⚠ 到着${i + 1}ODOが前より小さい（手入力で修正推奨）`;
      }
    }
    if (typeof totalDistanceKm === "number" && totalDistanceKm >= DIFF_LIMIT_KM) {
      return `⚠ 総走行距離が${DIFF_LIMIT_KM}km以上（保存不可）`;
    }
    return "";
  }, [arrivalCount, arrivals, departOdo, totalDistanceKm]);

  /** preview */
  useEffect(() => {
    if (!departPhoto) {
      setDepartPreview(null);
      return;
    }
    const url = URL.createObjectURL(departPhoto);
    setDepartPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [departPhoto]);

  /** arrivals helpers */
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

  /** OCR */
  async function runOcr(file: File, target: "depart" | number) {
    const key = target === "depart" ? "depart" : `arrive-${target}`;
    if (ocrBusyKey) return;

    setOcrBusyKey(key);
    if (target === "depart") setDepartOcrStatus("OCR中…（ODOの数字だけ）");
    else updateArrival(target, { ocrStatus: "OCR中…（ODOの数字だけ）" });

    try {
      const cropped = await cropMeterArea(file);
      const result = await Tesseract.recognize(cropped, "eng", {
        tessedit_char_whitelist: "0123456789",
      } as any);

      const raw = result?.data?.text ?? "";
      const best = pickBestDigits(String(raw));

      if (!best) {
        const msg = "OCR失敗：数字が見つからない（近づけて/ブレ減らして）";
        if (target === "depart") setDepartOcrStatus(msg);
        else updateArrival(target, { ocrStatus: msg });
        return;
      }

      const num = Number(best);
      if (!Number.isFinite(num)) {
        const msg = "OCR結果が不正（数字に変換できない）";
        if (target === "depart") setDepartOcrStatus(msg);
        else updateArrival(target, { ocrStatus: msg });
        return;
      }

      if (target === "depart") {
        setDepartOdo(num);
        setDepartOcrStatus(`OCR成功: ${best}`);
      } else {
        updateArrival(target, { odo: num, ocrStatus: `OCR成功: ${best}` });
      }
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : "OCRでエラー";
      if (target === "depart") setDepartOcrStatus(msg);
      else updateArrival(target, { ocrStatus: msg });
    } finally {
      setOcrBusyKey(null);
    }
  }

  useEffect(() => {
    if (!departPhoto) return;
    runOcr(departPhoto, "depart");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departPhoto]);

  useEffect(() => {
    for (let i = 0; i < arrivalCount; i++) {
      const a = arrivals[i];
      if (a.photoFile && !a.ocrStatus) {
        runOcr(a.photoFile, i);
        break;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [arrivals, arrivalCount]);

  /** storage */
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

  /** flow */
  async function postToFlow(payload: FlowPayload) {
    const res = await fetch("/api/powerautomate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });

    const text = await res.text();
    let j: any = null;
    try { j = text ? JSON.parse(text) : null; } catch { }

    if (!res.ok) {
      throw new Error(`Power Automate送信失敗: ${res.status} ${j ? JSON.stringify(j) : text}`);
    }
    if (j && j.ok === false) {
      throw new Error(j.error || JSON.stringify(j));
    }
  }

  /** validation */
  const missingLabels = useMemo(() => {
    const miss: string[] = [];
    if (!driverName) miss.push("運転者");

    if (mode === "route") {
      if (fromId == null) miss.push("出発地");
      for (let i = 0; i < arrivalCount; i++) {
        if (arrivals[i].locationId == null) miss.push(`到着${i + 1}（場所）`);
      }
      if (computedAmountYen == null) miss.push("金額（料金表に無い区間がある/同地点連続）");
    }

    if (departOdo == null) miss.push("ODO(出発)");
    if (!departPhoto) miss.push("写真(出発)");

    for (let i = 0; i < arrivalCount; i++) {
      if (arrivals[i].odo == null) miss.push(`ODO(到着${i + 1})`);
      if (!arrivals[i].photoFile) miss.push(`写真(到着${i + 1})`);
    }

    if (distanceInvalid) miss.push("走行距離（マイナス区間/100km以上）");
    return miss;
  }, [driverName, mode, fromId, arrivalCount, arrivals, computedAmountYen, departOdo, departPhoto, distanceInvalid]);

  const canSave = useMemo(() => missingLabels.length === 0 && !isSaving, [missingLabels, isSaving]);

  /** save */
  async function onSave() {
    if (isSaving) return;
    setStatus("");

    if (missingLabels.length) {
      setStatus(`未入力があります：\n・${missingLabels.join("\n・")}`);
      return;
    }

    setIsSaving(true);

    try {
      const nowAtSave = new Date();
      const reportAtIso = nowAtSave.toISOString();
      const reportAtExcel = formatDateTimeForExcel(nowAtSave);
      const amountToSave = mode === "bus" ? 2000 : (computedAmountYen as number);

      // 出発写真
      let depart_photo_path: string | null = null;
      let depart_photo_url: string | null = null;
      if (departPhoto) {
        const r = await uploadOnePhoto(departPhoto, "depart");
        depart_photo_path = r.path;
        depart_photo_url = r.url;
      }

      // 到着1〜8写真
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

      // DB（最終到着で保存）
      const finalArrival = arrivals[arrivalCount - 1];
      const payloadDb: PickupOrderInsert = {
        driver_name: driverName,
        is_bus: mode === "bus",
        from_id: mode === "bus" ? null : fromId,
        to_id: mode === "bus" ? null : (finalArrival?.locationId ?? null),
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
        throw new Error(`DB insert失敗: ${e?.message ?? ""} ${e?.details ?? ""} ${e?.hint ?? ""} (${e?.code ?? ""})`.trim());
      }

      const arrivalNames = Array.from({ length: MAX_ARRIVALS }, (_, i) =>
        i < arrivalCount ? idToName(arrivals[i].locationId) : ""
      );

      const [s1, s2, s3, s4, s5, s6, s7, s8] = segmentDistances;

      const flowPayload: FlowPayload = {
        日付: reportAtExcel,
        運転者: driverName,
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

      console.log("=== FLOW PAYLOAD ===");
      console.log(JSON.stringify(flowPayload, null, 2));

      try {
        await postToFlow(flowPayload);
        setStatus("保存しました（Power Automateにも送信OK）");
      } catch (e: any) {
        setStatus(`保存しました（ただしPower Automate送信は失敗）: ${e?.message ?? "error"}`);
      }

      // reset
      setFromId(null);
      setArrivalCount(1);
      setArrivals(Array.from({ length: MAX_ARRIVALS }, () => emptyArrival()));
      setDepartPhoto(null);
      setDepartOdo(null);
      setDepartOcrStatus("");
      setNote("");
    } catch (e: any) {
      setStatus(e?.message ?? "保存でエラー");
    } finally {
      setIsSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-black text-white flex items-start justify-center px-4 py-10">
      <div className="w-full max-w-4xl">
        <h1 className="text-center text-2xl font-semibold mb-1">ピックアップ手当</h1>
        <p className="text-center text-sm text-white/60 mb-6">
          通常ルートは料金表参照 / バスは一律2,000円
        </p>

        <div className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl">
          {/* 運転者 */}
          <div className="grid grid-cols-[90px_1fr] gap-3 items-start mb-4">
            <div className="text-sm text-white/70 mt-2">運転者</div>
            <div className="space-y-3">
              <select
                value={driverName}
                onChange={(e) => setDriverName(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
              >
                <option value="">選択</option>
                {driverNames.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>

              <div className="rounded-xl border border-white/10 bg-black/20 p-3">
                <div className="mb-2 text-xs text-white/60">運転者を追加 / 削除（この端末に保存）</div>
                <div className="flex gap-2">
                  <input
                    value={newDriverName}
                    onChange={(e) => setNewDriverName(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        addDriver();
                      }
                    }}
                    placeholder="新しい運転者名"
                    className="flex-1 rounded-lg border border-white/10 bg-black/40 px-3 py-2 text-sm"
                  />
                  <button
                    type="button"
                    onClick={addDriver}
                    className="rounded-lg px-3 py-2 text-sm bg-white/10 hover:bg-white/15"
                  >
                    追加
                  </button>
                </div>

                <div className="mt-3 flex flex-wrap gap-2">
                  {driverNames.map((n) => (
                    <button
                      key={`chip-${n}`}
                      type="button"
                      onClick={() => removeDriver(n)}
                      className={`rounded-full border px-3 py-1 text-xs ${driverName === n
                        ? "border-blue-400/40 bg-blue-900/40 text-white"
                        : "border-white/10 bg-white/5 text-white/80"
                        }`}
                      title={`削除: ${n}`}
                    >
                      {n} <span className="ml-1 text-white/50">×</span>
                    </button>
                  ))}
                </div>
              </div>
            </div>
          </div>

          {/* モード */}
          <div className="grid grid-cols-2 gap-2 mb-6">
            <button
              type="button"
              onClick={() => setMode("route")}
              className={`rounded-xl px-3 py-2 text-sm transition ${mode === "route" ? "bg-blue-900/70" : "bg-white/5 hover:bg-white/10"
                }`}
            >
              通常ルート
            </button>
            <button
              type="button"
              onClick={() => setMode("bus")}
              className={`rounded-xl px-3 py-2 text-sm transition ${mode === "bus" ? "bg-blue-900/70" : "bg-white/5 hover:bg-white/10"
                }`}
            >
              バス（固定）
            </button>
          </div>

          <div className="grid grid-cols-[90px_1fr] items-start gap-3 mb-4">
            <div className="text-sm text-white/70 mt-2">出発地</div>
            <select
              value={fromId ?? ""}
              onChange={(e) => setFromId(e.target.value ? Number(e.target.value) : null)}
              className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
              disabled={mode === "bus"}
            >
              <option value="">選択</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>

            <div className="text-sm text-white/70 mt-2">到着数</div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={addArrival}
                disabled={arrivalCount >= MAX_ARRIVALS}
                className="rounded-lg px-3 py-2 text-xs bg-white/10 hover:bg-white/15 disabled:opacity-50"
              >
                ＋ 到着を追加
              </button>
              <button
                type="button"
                onClick={removeLastArrival}
                disabled={arrivalCount <= 1}
                className="rounded-lg px-3 py-2 text-xs bg-white/10 hover:bg-white/15 disabled:opacity-50"
              >
                － 最後の到着を削除
              </button>
              <span className="text-xs text-white/50">最大{MAX_ARRIVALS}個</span>
            </div>

            <div className="text-sm text-white/70 mt-2">ルート</div>
            <div className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm">
              {routeChain || "—"}
            </div>

            <div className="text-sm text-white/70 mt-2">金額</div>
            <div className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm">
              {mode === "bus" ? (
                <span className="font-semibold">2000円</span>
              ) : computedAmountYen != null ? (
                <span className="font-semibold">{computedAmountYen.toLocaleString()}円</span>
              ) : (
                <span className="text-yellow-200">—（料金表に無い区間がある/未選択あり）</span>
              )}
            </div>

            <div className="text-sm text-white/70 mt-2">報告時間</div>
            <div className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm">
              {formatReportTimeJa(now)}
            </div>

            <div className="text-sm text-white/70 mt-2">ODO(出発)</div>
            <div>
              <input
                value={departOdo == null ? "" : String(departOdo)}
                onChange={(e) => {
                  const v = onlyAsciiDigitsFromAnyWidth(e.target.value);
                  setDepartOdo(v === "" ? null : Number(v));
                }}
                placeholder="例: １１２６０３（全角OK）"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
              />
              {departOcrStatus ? <div className="mt-2 text-xs text-yellow-200">{departOcrStatus}</div> : null}
            </div>

            <div className="text-sm text-white/70 mt-2">写真(出発)</div>
            <div>
              <input
                ref={departFileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => {
                  const f = e.target.files?.[0] ?? null;
                  setDepartPhoto(f);
                  setDepartOcrStatus("");
                  e.currentTarget.value = "";
                }}
              />
              <div className="flex items-center gap-3">
                <button
                  type="button"
                  onClick={() => departFileRef.current?.click()}
                  className="rounded-lg px-3 py-2 text-sm bg-white/10 hover:bg-white/15"
                >
                  写真を選ぶ
                </button>
                <span className="text-sm text-white/70">
                  {departPhoto ? departPhoto.name : "未選択"}
                </span>
              </div>
              {departPreview ? (
                <div className="mt-3">
                  <img src={departPreview} alt="depart preview" className="max-h-40 rounded-lg border border-white/10" />
                </div>
              ) : null}
            </div>
          </div>

          {/* 到着1〜8 */}
          <div className="space-y-4 mt-6">
            {visibleArrivals.map((a, idx) => {
              const segText =
                typeof segmentDistances[idx] === "number" ? `${segmentDistances[idx]} km` : "—";

              return (
                <div key={`arrival-${idx}`} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="mb-3 text-base font-semibold">到着{idx + 1}</div>

                  <div className="grid grid-cols-[90px_1fr] items-start gap-3">
                    <div className="text-sm text-white/70 mt-2">場所</div>
                    <select
                      value={a.locationId ?? ""}
                      onChange={(e) =>
                        updateArrival(idx, { locationId: e.target.value ? Number(e.target.value) : null })
                      }
                      className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
                      disabled={mode === "bus"}
                    >
                      <option value="">選択</option>
                      {locations.map((l) => (
                        <option key={`loc-${idx}-${l.id}`} value={l.id}>
                          {l.name}
                        </option>
                      ))}
                    </select>

                    <div className="text-sm text-white/70 mt-2">ODO</div>
                    <div>
                      <input
                        value={a.odo == null ? "" : String(a.odo)}
                        onChange={(e) => {
                          const v = onlyAsciiDigitsFromAnyWidth(e.target.value);
                          updateArrival(idx, { odo: v === "" ? null : Number(v) });
                        }}
                        placeholder={`例: １１２８５０（到着${idx + 1} / 全角OK）`}
                        className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
                      />
                      {a.ocrStatus ? <div className="mt-2 text-xs text-yellow-200">{a.ocrStatus}</div> : null}
                    </div>

                    <div className="text-sm text-white/70 mt-2">区間距離</div>
                    <div className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm">
                      {idx === 0 ? `始→到着1: ${segText}` : `到着${idx}→到着${idx + 1}: ${segText}`}
                    </div>

                    <div className="text-sm text-white/70 mt-2">写真</div>
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
                              ocrStatus: "",
                            });
                            e.currentTarget.value = "";
                            return;
                          }

                          const preview = URL.createObjectURL(f);
                          updateArrival(idx, {
                            photoFile: f,
                            photoPreview: preview,
                            photoUploadedUrl: null,
                            ocrStatus: "",
                          });

                          e.currentTarget.value = "";
                        }}
                      />
                      <div className="flex items-center gap-3">
                        <button
                          type="button"
                          onClick={() => arrivalFileRefs.current[idx]?.click()}
                          className="rounded-lg px-3 py-2 text-sm bg-white/10 hover:bg-white/15"
                        >
                          写真を選ぶ
                        </button>
                        <span className="text-sm text-white/70">
                          {a.photoFile ? a.photoFile.name : "未選択"}
                        </span>
                      </div>
                      {a.photoPreview ? (
                        <div className="mt-3">
                          <img
                            src={a.photoPreview}
                            alt={`arrival-${idx + 1}-preview`}
                            className="max-h-40 rounded-lg border border-white/10"
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
          <div className="grid grid-cols-[90px_1fr] items-start gap-3 mt-6">
            <div className="text-sm text-white/70 mt-2">総走行距離</div>
            <div className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm">
              <div className="flex items-center gap-3">
                <span className="font-semibold">
                  {typeof totalDistanceKm === "number" ? `${totalDistanceKm} km` : "—"}
                </span>
                {distanceHint ? <span className="text-xs text-yellow-200">{distanceHint}</span> : null}
              </div>
            </div>

            <div className="text-sm text-white/70 mt-2">備考</div>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="任意"
              className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
            />
          </div>

          {loadErr ? <div className="text-xs text-yellow-200 mt-4">{loadErr}</div> : null}
          {missingLabels.length ? (
            <div className="text-xs text-yellow-200 mt-4 whitespace-pre-wrap">
              未入力（備考以外は必須）：{"\n"}・{missingLabels.join("\n・")}
            </div>
          ) : null}
          {status ? <div className="text-sm text-yellow-200 mt-4 whitespace-pre-wrap">{status}</div> : null}

          <button
            type="button"
            onClick={onSave}
            disabled={!canSave}
            className="mt-5 w-full rounded-xl bg-blue-900/70 hover:bg-blue-900/80 transition px-3 py-3 text-sm disabled:opacity-50"
            title={!canSave ? "備考以外に未入力があると保存できません" : ""}
          >
            {isSaving ? "保存中..." : "保存"}
          </button>
        </div>
      </div>
    </main>
  );
}