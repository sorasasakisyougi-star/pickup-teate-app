"use client";

import { useEffect, useMemo, useState } from "react";
import Tesseract from "tesseract.js";
import { supabase } from "@/lib/supabaseClient";

/** ========= types ========= */
type LocationRow = { id: number; name: string; kind?: string | null };
type FareRow = { from_id: number; to_id: number; amount_yen: number };
type Mode = "route" | "bus";

type ArrivalInput = {
  locationId: number | null;
  odo: number | null;
  photo: File | null;
  preview: string | null;
  ocrStatus: string;
};

type PickupOrderInsert = {
  driver_name: string;
  is_bus: boolean;
  from_id: number | null;

  to_id: number | null; // 旧互換（最終到着）
  to1_id: number | null;
  to2_id: number | null;
  to3_id: number | null;
  to4_id: number | null;
  to5_id: number | null;

  amount_yen: number;
  report_at: string;

  depart_odometer_km: number | null;
  arrive_odometer_km: number | null; // 旧互換（最終到着）
  arrive1_odometer_km: number | null;
  arrive2_odometer_km: number | null;
  arrive3_odometer_km: number | null;
  arrive4_odometer_km: number | null;
  arrive5_odometer_km: number | null;

  depart_photo_path: string | null;
  depart_photo_url: string | null;

  arrive_photo_path: string | null; // 旧互換（最終到着）
  arrive_photo_url: string | null;  // 旧互換（最終到着）
  arrive1_photo_path: string | null;
  arrive1_photo_url: string | null;
  arrive2_photo_path: string | null;
  arrive2_photo_url: string | null;
  arrive3_photo_path: string | null;
  arrive3_photo_url: string | null;
  arrive4_photo_path: string | null;
  arrive4_photo_url: string | null;
  arrive5_photo_path: string | null;
  arrive5_photo_url: string | null;
};

/** Power Automate に送る JSON（Excel列名と一致） */
type FlowPayload = {
  日付: string;
  運転者: string;
  出発地: string;
  到着１: string;
  到着２: string;
  到着３: string;
  到着４: string;
  到着５: string;
  バス: string;
  "金額（円）": number;
  "距離（始）": number;
  "距離（到着１）": number;
  "距離（到着２）": number;
  "距離（到着３）": number;
  "距離（到着４）": number;
  "距離（到着５）": number;
  "走行距離（km）": number;
  出発写真URL: string;
  到着写真URL到着１: string;
  到着写真URL到着２: string;
  到着写真URL到着３: string;
  到着写真URL到着４: string;
  到着写真URL到着５: string;
  備考: string;
};

/** ========= constants ========= */
const DRIVER_NAMES = [
  "拓哉", "ロヒップ", "カビブ", "ナルディ", "フェブリ", "アジ", "ダニ", "ハン",
  "アンガ", "コウォ", "ワヒュ", "ソレ", "照太", "エルヴァンド", "ヨガ", "ヘンキ",
  "ラフリ", "大空", "優稀", "ワルヨ", "アンディ", "ディカ", "ディッキー",
] as const;

const BUCKET = "order-photos";
const DIFF_LIMIT_KM = 100;
const MAX_ARRIVALS = 5;

function createEmptyArrival(): ArrivalInput {
  return {
    locationId: null,
    odo: null,
    photo: null,
    preview: null,
    ocrStatus: "",
  };
}

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

/** 全角数字→半角数字 */
function toHalfWidthDigits(s: string) {
  return (s ?? "").replace(/[０-９]/g, (ch) =>
    String.fromCharCode(ch.charCodeAt(0) - 0xfee0)
  );
}

/** 入力を半角数字だけに */
function onlyAsciiDigitsFromAnyWidth(s: string) {
  const half = toHalfWidthDigits(s);
  return half.replace(/[^\d]/g, "");
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

/** 画像の中央下を切り抜き→拡大→コントラスト */
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

/** ========= 小物UI ========= */
function FilePickButton({
  id,
  onPick,
  disabled = false,
}: {
  id: string;
  onPick: (file: File | null) => void | Promise<void>;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-2">
      <input
        id={id}
        type="file"
        accept="image/*"
        className="hidden"
        disabled={disabled}
        onChange={(e) => {
          void onPick(e.target.files?.[0] ?? null);
          e.currentTarget.value = "";
        }}
      />
      <label
        htmlFor={id}
        className={`inline-flex items-center justify-center rounded-xl border px-4 py-3 text-sm transition ${disabled
          ? "cursor-not-allowed border-white/5 bg-white/5 text-white/30"
          : "cursor-pointer border-white/10 bg-white/10 text-white hover:bg-white/15 active:scale-[0.99]"
          }`}
      >
        写真を選ぶ
      </label>
      <span className="text-xs text-white/45">選ぶと自動で読み取り</span>
    </div>
  );
}

/** ========= main ========= */
export default function Page() {
  const [mode, setMode] = useState<Mode>("route");

  // master
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [fares, setFares] = useState<FareRow[]>([]);
  const [loadErr, setLoadErr] = useState("");

  // driver
  const [driverName, setDriverName] = useState<string>("");

  // route
  const [fromId, setFromId] = useState<number | null>(null);
  const [arrivals, setArrivals] = useState<ArrivalInput[]>(
    Array.from({ length: MAX_ARRIVALS }, () => createEmptyArrival())
  );
  const [arrivalCount, setArrivalCount] = useState(1);

  // note（DBには入れない）
  const [note, setNote] = useState("");

  // 出発ODO/写真
  const [departOdo, setDepartOdo] = useState<number | null>(null);
  const [departPhoto, setDepartPhoto] = useState<File | null>(null);
  const [departPreview, setDepartPreview] = useState<string | null>(null);
  const [departOcrStatus, setDepartOcrStatus] = useState("");

  // OCR状態
  const [ocrBusyKey, setOcrBusyKey] = useState<string | null>(null);

  // ui
  const [status, setStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // 表示用の現在時刻
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  /** ========= load masters ========= */
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoadErr("");
      try {
        const locRes = await supabase
          .from("locations")
          .select("id,name,kind")
          .order("name", { ascending: true });

        if (locRes.error) {
          if (!cancelled) {
            setLocations([]);
            setLoadErr("locations取得に失敗（RLS/権限/テーブル名を確認）");
            console.error("[locations fetch]", locRes.error);
          }
        } else {
          if (!cancelled) setLocations((locRes.data ?? []) as LocationRow[]);
        }

        const fareRes = await supabase
          .from("route_fares")
          .select("from_id,to_id,amount_yen");

        if (fareRes.error) {
          if (!cancelled) {
            setFares([]);
            setLoadErr((prev) =>
              prev
                ? prev + " / fares取得に失敗（RLS/権限/テーブル名）"
                : "fares取得に失敗（RLS/権限/テーブル名を確認）"
            );
            console.error("[fares fetch]", fareRes.error);
          }
        } else {
          if (!cancelled) setFares((fareRes.data ?? []) as FareRow[]);
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

  /** ========= lookup ========= */
  const locMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const l of locations) m.set(l.id, l.name);
    return m;
  }, [locations]);

  const idToName = (id: number | null) => (id == null ? "" : locMap.get(id) ?? String(id));

  /** ========= active arrivals ========= */
  const visibleArrivals = useMemo(
    () => arrivals.slice(0, arrivalCount),
    [arrivals, arrivalCount]
  );

  const routeLabel = useMemo(() => {
    const names = [idToName(fromId), ...visibleArrivals.map((a) => idToName(a.locationId))].filter(Boolean);
    return names.length ? names.join("→") : "—";
  }, [fromId, visibleArrivals, locMap]);

  /** ========= fare ========= */
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

    const ids = visibleArrivals.map((a) => a.locationId);
    if (ids[0] == null) return null;
    if (ids.some((x) => x == null)) return null;

    const chain = [fromId, ...(ids as number[])];

    for (let i = 0; i < chain.length - 1; i++) {
      if (chain[i] === chain[i + 1]) return null;
    }

    let sum = 0;
    for (let i = 0; i < chain.length - 1; i++) {
      const fare = findFare(chain[i], chain[i + 1]);
      if (fare == null) return null;
      sum += fare;
    }
    return sum;
  }, [mode, fromId, visibleArrivals, fares]);

  /** ========= ODO / 区間距離 / 総走行 ========= */
  const segmentDiffs = useMemo(() => {
    const out: (number | null)[] = [];
    for (let i = 0; i < arrivalCount; i++) {
      const cur = arrivals[i].odo;
      const prev = i === 0 ? departOdo : arrivals[i - 1].odo;
      if (cur == null || prev == null) out.push(null);
      else out.push(cur - prev);
    }
    return out;
  }, [arrivals, arrivalCount, departOdo]);

  const lastFilledArrivalIndex = useMemo(() => {
    for (let i = arrivalCount - 1; i >= 0; i--) {
      if (arrivals[i].locationId != null) return i;
    }
    return -1;
  }, [arrivals, arrivalCount]);

  const finalArrivalOdo = useMemo(() => {
    if (lastFilledArrivalIndex < 0) return null;
    return arrivals[lastFilledArrivalIndex].odo;
  }, [arrivals, lastFilledArrivalIndex]);

  const totalDriveKm = useMemo(() => {
    if (departOdo == null || finalArrivalOdo == null) return null;
    return finalArrivalOdo - departOdo;
  }, [departOdo, finalArrivalOdo]);

  const diffTooLarge = useMemo(() => {
    if (totalDriveKm == null) return false;
    return totalDriveKm >= DIFF_LIMIT_KM || totalDriveKm < 0;
  }, [totalDriveKm]);

  /** ========= previews ========= */
  useEffect(() => {
    if (!departPhoto) {
      setDepartPreview(null);
      return;
    }
    const url = URL.createObjectURL(departPhoto);
    setDepartPreview(url);
    return () => URL.revokeObjectURL(url);
  }, [departPhoto]);

  /** ========= arrival helpers ========= */
  function setArrival(idx: number, patch: Partial<ArrivalInput>) {
    setArrivals((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  }

  function onArrivalPhotoChange(idx: number, file: File | null) {
    setArrivals((prev) =>
      prev.map((a, i) => {
        if (i !== idx) return a;
        if (a.preview?.startsWith("blob:")) URL.revokeObjectURL(a.preview);
        return {
          ...a,
          photo: file,
          preview: file ? URL.createObjectURL(file) : null,
          ocrStatus: file ? a.ocrStatus : "",
        };
      })
    );
  }

  function addArrival() {
    setArrivalCount((n) => Math.min(MAX_ARRIVALS, n + 1));
  }

  function removeArrival() {
    if (arrivalCount <= 1) return;
    setArrivals((prev) => {
      const idx = arrivalCount - 1;
      const next = [...prev];
      const target = next[idx];
      if (target.preview?.startsWith("blob:")) URL.revokeObjectURL(target.preview);
      next[idx] = createEmptyArrival();
      return next;
    });
    setArrivalCount((n) => Math.max(1, n - 1));
  }

  /** ========= OCR ========= */
  async function runOcr(file: File, which: "depart" | number) {
    const key = which === "depart" ? "depart" : `arrive-${which}`;
    if (ocrBusyKey) return;

    setOcrBusyKey(key);
    if (which === "depart") setDepartOcrStatus("OCR中…（ODOの数字だけ）");
    else setArrival(which, { ocrStatus: "OCR中…（ODOの数字だけ）" });

    try {
      const cropped = await cropMeterArea(file);
      const result = await Tesseract.recognize(cropped, "eng", {
        tessedit_char_whitelist: "0123456789",
      } as any);

      const raw = result?.data?.text ?? "";
      const best = pickBestDigits(String(raw));

      if (!best) {
        const msg = "OCR失敗：数字が見つからない（近づけて/ブレ減らして）";
        if (which === "depart") setDepartOcrStatus(msg);
        else setArrival(which, { ocrStatus: msg });
        return;
      }

      const num = Number(best);
      if (!Number.isFinite(num)) {
        const msg = "OCR結果が不正（数字に変換できない）";
        if (which === "depart") setDepartOcrStatus(msg);
        else setArrival(which, { ocrStatus: msg });
        return;
      }

      if (which === "depart") {
        setDepartOdo(num);
        setDepartOcrStatus(`OCR成功: ${best}`);
      } else {
        setArrival(which, { odo: num, ocrStatus: `OCR成功: ${best}` });
      }
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : "OCRでエラー";
      if (which === "depart") setDepartOcrStatus(msg);
      else setArrival(which, { ocrStatus: msg });
    } finally {
      setOcrBusyKey(null);
    }
  }

  /** ========= storage upload ========= */
  async function uploadOnePhoto(file: File, path: string) {
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

  async function uploadAllPhotos() {
    const reportKey = `${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;

    let depart_photo_path: string | null = null;
    let depart_photo_url: string | null = null;

    const arrivePaths: (string | null)[] = Array(MAX_ARRIVALS).fill(null);
    const arriveUrls: (string | null)[] = Array(MAX_ARRIVALS).fill(null);

    if (departPhoto) {
      const ext = departPhoto.name.split(".").pop() || "jpg";
      const r = await uploadOnePhoto(departPhoto, `${reportKey}/depart.${ext}`);
      depart_photo_path = r.path;
      depart_photo_url = r.url;
    }

    for (let i = 0; i < arrivalCount; i++) {
      const f = arrivals[i].photo;
      if (!f) continue;
      const ext = f.name.split(".").pop() || "jpg";
      const r = await uploadOnePhoto(f, `${reportKey}/arrive_${i + 1}.${ext}`);
      arrivePaths[i] = r.path;
      arriveUrls[i] = r.url;
    }

    return { depart_photo_path, depart_photo_url, arrivePaths, arriveUrls };
  }

  /** ========= Power Automate ========= */
  async function postToFlow(payload: FlowPayload) {
    const res = await fetch("/api/powerautomate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ payload }),
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
    if (mode === "route" && fromId == null) miss.push("出発地");
    if (mode === "route" && arrivals[0].locationId == null) miss.push("到着1");

    if (!departPhoto) miss.push("写真(出発)");
    if (departOdo == null) miss.push("距離（始）");

    if (mode === "route") {
      for (let i = 0; i < arrivalCount; i++) {
        const a = arrivals[i];
        const n = i + 1;
        if (a.locationId == null) miss.push(`到着${n}`);
        if (a.odo == null) miss.push(`距離（到着${n}）`);
        if (!a.photo) miss.push(`写真(到着${n})`);
      }
      if (computedAmountYen == null) {
        miss.push("金額（料金表に無い区間がある/同地点連続/未選択あり）");
      }
    }

    if (totalDriveKm == null) miss.push("走行距離（km）");
    if (diffTooLarge) miss.push(`走行距離（差分が${DIFF_LIMIT_KM}km以上/マイナス）`);

    return Array.from(new Set(miss));
  }, [driverName, mode, fromId, arrivals, arrivalCount, departPhoto, departOdo, computedAmountYen, totalDriveKm, diffTooLarge]);

  const canSave = useMemo(() => missingLabels.length === 0 && !isSaving, [missingLabels, isSaving]);

  /** ========= save ========= */
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

      const uploaded = await uploadAllPhotos();

      const toIds = arrivals.map((a) => a.locationId);
      const odos = arrivals.map((a) => a.odo);

      let lastIdx = -1;
      for (let i = arrivalCount - 1; i >= 0; i--) {
        if (arrivals[i].locationId != null) {
          lastIdx = i;
          break;
        }
      }
      const finalArrivalOdo = lastIdx >= 0 ? (odos[lastIdx] ?? null) : null;
      const totalDrive = departOdo != null && finalArrivalOdo != null ? finalArrivalOdo - departOdo : null;

      const payloadDb: PickupOrderInsert = {
        driver_name: driverName,
        is_bus: mode === "bus",
        from_id: mode === "bus" ? null : fromId,

        to_id: mode === "bus" ? null : (toIds[lastIdx] ?? null),

        to1_id: mode === "bus" ? null : (toIds[0] ?? null),
        to2_id: mode === "bus" ? null : (toIds[1] ?? null),
        to3_id: mode === "bus" ? null : (toIds[2] ?? null),
        to4_id: mode === "bus" ? null : (toIds[3] ?? null),
        to5_id: mode === "bus" ? null : (toIds[4] ?? null),

        amount_yen: amountToSave,
        report_at: reportAtIso,

        depart_odometer_km: departOdo,
        arrive_odometer_km: finalArrivalOdo,
        arrive1_odometer_km: odos[0] ?? null,
        arrive2_odometer_km: odos[1] ?? null,
        arrive3_odometer_km: odos[2] ?? null,
        arrive4_odometer_km: odos[3] ?? null,
        arrive5_odometer_km: odos[4] ?? null,

        depart_photo_path: uploaded.depart_photo_path,
        depart_photo_url: uploaded.depart_photo_url,

        arrive_photo_path: lastIdx >= 0 ? uploaded.arrivePaths[lastIdx] : null,
        arrive_photo_url: lastIdx >= 0 ? uploaded.arriveUrls[lastIdx] : null,

        arrive1_photo_path: uploaded.arrivePaths[0] ?? null,
        arrive1_photo_url: uploaded.arriveUrls[0] ?? null,
        arrive2_photo_path: uploaded.arrivePaths[1] ?? null,
        arrive2_photo_url: uploaded.arriveUrls[1] ?? null,
        arrive3_photo_path: uploaded.arrivePaths[2] ?? null,
        arrive3_photo_url: uploaded.arriveUrls[2] ?? null,
        arrive4_photo_path: uploaded.arrivePaths[3] ?? null,
        arrive4_photo_url: uploaded.arriveUrls[3] ?? null,
        arrive5_photo_path: uploaded.arrivePaths[4] ?? null,
        arrive5_photo_url: uploaded.arriveUrls[4] ?? null,
      };

      const ins = await supabase.from("pickup_orders").insert(payloadDb);
      if (ins.error) {
        console.error("[insert pickup_orders]", ins.error);
        const msg = String(ins.error.message || "");
        const detail = String((ins.error as any).details || "");
        const hint = String((ins.error as any).hint || "");
        const code = String((ins.error as any).code || "");

        if (msg.includes("Could not find") || code === "PGRST204") {
          throw new Error(
            "DB列が足りません（pickup_ordersに到着1〜5用カラム未追加）\n" +
            "→ Supabase SQL Editorで ALTER TABLE を実行してから再度保存してね。\n" +
            `detail: ${msg}`
          );
        }
        throw new Error(`DB insert失敗: ${msg} ${detail} ${hint} (${code})`.trim());
      }

      const flowPayload: FlowPayload = {
        日付: reportAtExcel,
        運転者: driverName,
        出発地: mode === "bus" ? "" : idToName(fromId),

        到着１: mode === "bus" ? "" : idToName(toIds[0] ?? null),
        到着２: mode === "bus" ? "" : idToName(toIds[1] ?? null),
        到着３: mode === "bus" ? "" : idToName(toIds[2] ?? null),
        到着４: mode === "bus" ? "" : idToName(toIds[3] ?? null),
        到着５: mode === "bus" ? "" : idToName(toIds[4] ?? null),

        バス: mode === "bus" ? "バス" : "通常ルート",
        "金額（円）": amountToSave,

        "距離（始）": departOdo ?? 0,
        "距離（到着１）": odos[0] ?? 0,
        "距離（到着２）": odos[1] ?? 0,
        "距離（到着３）": odos[2] ?? 0,
        "距離（到着４）": odos[3] ?? 0,
        "距離（到着５）": odos[4] ?? 0,
        "走行距離（km）": totalDrive ?? 0,

        出発写真URL: uploaded.depart_photo_url ?? "",
        到着写真URL到着１: uploaded.arriveUrls[0] ?? "",
        到着写真URL到着２: uploaded.arriveUrls[1] ?? "",
        到着写真URL到着３: uploaded.arriveUrls[2] ?? "",
        到着写真URL到着４: uploaded.arriveUrls[3] ?? "",
        到着写真URL到着５: uploaded.arriveUrls[4] ?? "",

        備考: note?.trim() ?? "",
      };

      try {
        await postToFlow(flowPayload);
        setStatus("保存しました（Power Automateにも送信OK）");
      } catch (e: any) {
        console.error("[flow send]", e);
        setStatus(
          `保存しました（ただしPower Automate送信は失敗）: ${e?.message ? String(e.message) : "error"
          }`
        );
      }

      // reset
      setFromId(null);
      setArrivalCount(1);
      setArrivals((prev) => {
        prev.forEach((a) => {
          if (a.preview?.startsWith("blob:")) URL.revokeObjectURL(a.preview);
        });
        return Array.from({ length: MAX_ARRIVALS }, () => createEmptyArrival());
      });

      setDepartPhoto(null);
      setDepartPreview(null);
      setDepartOdo(null);
      setDepartOcrStatus("");
      setNote("");
    } catch (e: any) {
      setStatus(e?.message ? String(e.message) : "保存でエラー");
    } finally {
      setIsSaving(false);
    }
  }

  /** ========= labels ========= */
  const totalDriveLabel = useMemo(() => {
    if (totalDriveKm == null) return "—";
    return `${totalDriveKm} km`;
  }, [totalDriveKm]);

  const totalDriveHint = useMemo(() => {
    if (totalDriveKm == null) return "";
    if (totalDriveKm < 0) return "⚠ 最終到着ODOが出発より小さい";
    if (totalDriveKm >= DIFF_LIMIT_KM) return `⚠ 差分が${DIFF_LIMIT_KM}km以上（保存不可）`;
    return "";
  }, [totalDriveKm]);

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto w-full max-w-4xl px-4 py-6 pb-28">
        <h1 className="mb-1 text-center text-2xl font-semibold">ピックアップ手当</h1>
        <p className="mb-5 text-center text-sm text-white/60">
          到着1〜5（場所・写真・ODO） / 距離欄はODO値 / 走行距離は最終到着ODO−出発ODO
        </p>

        <div className="space-y-4">
          {/* 基本 */}
          <section className="rounded-2xl border border-white/10 bg-white/5 p-4 shadow-xl">
            <div className="mb-4">
              <div className="mb-2 text-sm text-white/70">運転者</div>
              <select
                value={driverName}
                onChange={(e) => setDriverName(e.target.value)}
                className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm"
              >
                <option value="">選択</option>
                {DRIVER_NAMES.map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </div>

            <div className="mb-4 grid grid-cols-2 gap-2">
              <button
                type="button"
                onClick={() => setMode("route")}
                className={`rounded-xl px-3 py-3 text-sm transition ${mode === "route" ? "bg-blue-900/70" : "bg-white/5 hover:bg-white/10"
                  }`}
              >
                通常ルート
              </button>
              <button
                type="button"
                onClick={() => setMode("bus")}
                className={`rounded-xl px-3 py-3 text-sm transition ${mode === "bus" ? "bg-blue-900/70" : "bg-white/5 hover:bg-white/10"
                  }`}
              >
                バス（固定）
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4">
              <div>
                <div className="mb-2 text-sm text-white/70">出発地</div>
                <select
                  value={fromId ?? ""}
                  onChange={(e) => setFromId(e.target.value ? Number(e.target.value) : null)}
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm"
                  disabled={mode === "bus"}
                >
                  <option value="">選択</option>
                  {locations.map((l) => (
                    <option key={l.id} value={l.id}>
                      {l.name}
                    </option>
                  ))}
                </select>
              </div>

              <div>
                <div className="mb-2 text-sm text-white/70">到着数</div>
                <div className="flex flex-wrap items-center gap-2">
                  <button
                    type="button"
                    onClick={addArrival}
                    disabled={mode === "bus" || arrivalCount >= MAX_ARRIVALS}
                    className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-xs hover:bg-white/15 disabled:opacity-40"
                  >
                    ＋ 到着を追加
                  </button>
                  <button
                    type="button"
                    onClick={removeArrival}
                    disabled={mode === "bus" || arrivalCount <= 1}
                    className="rounded-xl border border-white/10 bg-white/10 px-3 py-2 text-xs hover:bg-white/15 disabled:opacity-40"
                  >
                    − 最後の到着を削除
                  </button>
                  <span className="text-xs text-white/40">最大{MAX_ARRIVALS}個</span>
                </div>
              </div>

              <div>
                <div className="mb-2 text-sm text-white/70">ルート</div>
                <div className="rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm">
                  {mode === "bus" ? "バス（ルート入力なし）" : routeLabel}
                </div>
              </div>

              <div>
                <div className="mb-2 text-sm text-white/70">金額</div>
                <div className="rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm">
                  {mode === "bus" ? (
                    <span className="font-semibold">2000円</span>
                  ) : computedAmountYen != null ? (
                    <span className="font-semibold">{computedAmountYen}円（到着1〜N合計）</span>
                  ) : (
                    <span className="text-yellow-200">—（料金表に無い区間がある/未選択あり）</span>
                  )}
                </div>
              </div>

              <div>
                <div className="mb-2 text-sm text-white/70">報告時間</div>
                <div className="rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm">
                  {formatReportTimeJa(now)}
                </div>
              </div>

              <div>
                <div className="mb-2 text-sm text-white/70">距離（始）</div>
                <input
                  value={departOdo == null ? "" : String(departOdo)}
                  onChange={(e) => {
                    const v = onlyAsciiDigitsFromAnyWidth(e.target.value);
                    setDepartOdo(v === "" ? null : Number(v));
                  }}
                  placeholder="出発ODO（全角OK）"
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm"
                  inputMode="numeric"
                />
                {departOcrStatus ? (
                  <div className="mt-2 text-xs text-yellow-200">{departOcrStatus}</div>
                ) : null}
              </div>

              <div>
                <div className="mb-2 text-sm text-white/70">写真（出発）</div>
                <div className="space-y-2">
                  <FilePickButton
                    id="depart-photo"
                    onPick={async (file) => {
                      setDepartPhoto(file);
                      if (file) await runOcr(file, "depart"); // 自動OCR固定
                    }}
                  />
                  {departPhoto ? (
                    <div className="text-xs text-white/50 break-all">{departPhoto.name}</div>
                  ) : null}
                  {departPreview ? (
                    <img
                      src={departPreview}
                      alt="depart preview"
                      className="max-h-40 rounded-lg border border-white/10"
                    />
                  ) : null}
                </div>
              </div>
            </div>
          </section>

          {/* 到着カード群 */}
          {mode === "route" ? (
            <section className="rounded-2xl border border-white/10 bg-white/5 p-4 shadow-xl">
              <div className="mb-3 text-base font-semibold">到着1〜{arrivalCount}</div>

              <div className="space-y-4">
                {Array.from({ length: arrivalCount }).map((_, idx) => {
                  const a = arrivals[idx];
                  const seg = segmentDiffs[idx];

                  return (
                    <div key={idx} className="rounded-2xl border border-white/10 bg-black/30 p-4">
                      <div className="mb-3 flex items-center justify-between gap-2">
                        <div className="text-sm font-semibold">到着{idx + 1}</div>
                        <div className="text-xs text-white/60">
                          区間走行距離（表示用）: {seg == null ? "—" : `${seg} km`}
                        </div>
                      </div>

                      <div className="grid grid-cols-1 gap-4">
                        <div>
                          <div className="mb-2 text-sm text-white/70">場所</div>
                          <select
                            value={a.locationId ?? ""}
                            onChange={(e) =>
                              setArrival(idx, {
                                locationId: e.target.value ? Number(e.target.value) : null,
                              })
                            }
                            className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm"
                          >
                            <option value="">選択</option>
                            {locations.map((l) => (
                              <option key={l.id} value={l.id}>
                                {l.name}
                              </option>
                            ))}
                          </select>
                        </div>

                        <div>
                          <div className="mb-2 text-sm text-white/70">距離（到着{idx + 1}）</div>
                          <input
                            value={a.odo == null ? "" : String(a.odo)}
                            onChange={(e) => {
                              const v = onlyAsciiDigitsFromAnyWidth(e.target.value);
                              setArrival(idx, { odo: v === "" ? null : Number(v) });
                            }}
                            placeholder={`到着${idx + 1}ODO（全角OK）`}
                            className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm"
                            inputMode="numeric"
                          />
                          {a.ocrStatus ? (
                            <div className="mt-2 text-xs text-yellow-200">{a.ocrStatus}</div>
                          ) : null}
                        </div>

                        <div>
                          <div className="mb-2 text-sm text-white/70">写真（到着{idx + 1}）</div>
                          <div className="space-y-2">
                            <FilePickButton
                              id={`arrival-photo-${idx}`}
                              onPick={async (f) => {
                                onArrivalPhotoChange(idx, f);
                                if (f) await runOcr(f, idx); // 自動OCR固定
                              }}
                            />
                            {a.photo ? (
                              <div className="text-xs text-white/50 break-all">{a.photo.name}</div>
                            ) : null}
                            {a.preview ? (
                              <img
                                src={a.preview}
                                alt={`arrive${idx + 1} preview`}
                                className="max-h-40 rounded-lg border border-white/10"
                              />
                            ) : null}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}

          {/* まとめ */}
          <section className="rounded-2xl border border-white/10 bg-white/5 p-4 shadow-xl">
            <div className="grid grid-cols-1 gap-4">
              <div>
                <div className="mb-2 text-sm text-white/70">走行距離（km）</div>
                <div className="rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-semibold">{totalDriveLabel}</span>
                    {totalDriveHint ? <span className="text-xs text-yellow-200">{totalDriveHint}</span> : null}
                  </div>
                </div>
              </div>

              <div>
                <div className="mb-2 text-sm text-white/70">備考</div>
                <input
                  value={note}
                  onChange={(e) => setNote(e.target.value)}
                  placeholder="任意（DBには入れずExcelだけ送る）"
                  className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm"
                />
              </div>
            </div>
          </section>
        </div>

        {loadErr ? <div className="mt-4 text-xs text-yellow-200">{loadErr}</div> : null}

        {missingLabels.length ? (
          <div className="mt-4 rounded-xl border border-yellow-500/20 bg-yellow-500/5 p-3 text-xs text-yellow-200 whitespace-pre-wrap">
            未入力（備考以外は必須）：{"\n"}・{missingLabels.join("\n・")}
          </div>
        ) : null}

        {status ? (
          <div className="mt-4 rounded-xl border border-white/10 bg-white/5 p-3 text-sm text-yellow-200 whitespace-pre-wrap">
            {status}
          </div>
        ) : null}
      </div>

      {/* 固定下部ボタン */}
      <div className="fixed bottom-0 left-0 right-0 border-t border-white/10 bg-black/85 backdrop-blur">
        <div className="mx-auto w-full max-w-4xl px-4 py-3">
          <button
            onClick={onSave}
            disabled={!canSave}
            className="w-full rounded-2xl bg-blue-900/80 px-4 py-4 text-sm font-semibold hover:bg-blue-900 disabled:opacity-50"
            title={!canSave ? "備考以外に未入力があると保存できません" : ""}
          >
            {isSaving ? "保存中..." : "保存"}
          </button>
          <div className="mt-2 text-center text-[11px] text-white/35">
            写真を選ぶとODOを自動で読み取ります
          </div>
        </div>
      </div>
    </main>
  );
}