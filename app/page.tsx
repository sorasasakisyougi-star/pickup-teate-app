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
  manual: boolean;
  useOcr: boolean;
  photo: File | null;
  preview: string | null;
  ocrStatus: string;
};

type PickupOrderInsert = {
  driver_name: string;
  is_bus: boolean;
  from_id: number | null;

  to1_id: number | null;
  to2_id: number | null;
  to3_id: number | null;
  to4_id: number | null;
  to5_id: number | null;

  amount_yen: number;
  report_at: string;

  depart_odometer_km: number | null;
  arrive1_odometer_km: number | null;
  arrive2_odometer_km: number | null;
  arrive3_odometer_km: number | null;
  arrive4_odometer_km: number | null;
  arrive5_odometer_km: number | null;

  depart_photo_path: string | null;
  depart_photo_url: string | null;

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

const BUCKET = "order-photos";
const DIFF_LIMIT_KM = 100;
const MAX_ARRIVALS = 5;

function createEmptyArrival(): ArrivalInput {
  return {
    locationId: null,
    odo: null,
    manual: false,
    useOcr: true,
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
function FilePickButton({
  id,
  onPick,
  disabled = false,
}: {
  id: string;
  onPick: (file: File | null) => void;
  disabled?: boolean;
}) {
  return (
    <div className="flex items-center gap-3">
      <input
        id={id}
        type="file"
        accept="image/*"
        className="hidden"
        disabled={disabled}
        onChange={(e) => onPick(e.target.files?.[0] ?? null)}
      />
      <label
        htmlFor={id}
        className={`inline-flex items-center justify-center rounded-lg px-3 py-2 text-xs border border-white/10 ${disabled
          ? "bg-white/5 text-white/30 cursor-not-allowed"
          : "bg-white/10 hover:bg-white/15 cursor-pointer"
          }`}
      >
        写真を選ぶ
      </label>
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
  const [arrivalCount, setArrivalCount] = useState(1); // 到着1は必須表示

  // note（DBに入れずPowerAutomateのみ）
  const [note, setNote] = useState("");

  // 出発ODO/写真
  const [departOdo, setDepartOdo] = useState<number | null>(null);
  const [departManual, setDepartManual] = useState(false);
  const [departUseOcr, setDepartUseOcr] = useState(true);
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

  const lastFilledArrivalIndex = useMemo(() => {
    for (let i = arrivalCount - 1; i >= 0; i--) {
      if (arrivals[i].locationId != null) return i;
    }
    return -1;
  }, [arrivals, arrivalCount]);

  const routeLabel = useMemo(() => {
    const names = [idToName(fromId), ...visibleArrivals.map((a) => idToName(a.locationId))]
      .filter(Boolean);
    return names.join("→");
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
    if (ids[0] == null) return null; // 到着1必須
    if (ids.some((x) => x == null)) return null; // 表示中の到着は全部埋まってる必要あり

    const chain = [fromId, ...(ids as number[])];

    for (let i = 0; i < chain.length - 1; i++) {
      if (chain[i] === chain[i + 1]) return null; // 同地点連続NG
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
  const arrivalOdos = useMemo(() => visibleArrivals.map((a) => a.odo), [visibleArrivals]);

  const segmentDiffs = useMemo(() => {
    // 表示用：区間走行距離
    const out: (number | null)[] = [];
    for (let i = 0; i < arrivalCount; i++) {
      const cur = arrivals[i].odo;
      const prev = i === 0 ? departOdo : arrivals[i - 1].odo;
      if (cur == null || prev == null) {
        out.push(null);
      } else {
        const d = cur - prev;
        out.push(Number.isFinite(d) ? d : null);
      }
    }
    return out;
  }, [arrivals, arrivalCount, departOdo]);

  const finalArrivalOdo = useMemo(() => {
    if (lastFilledArrivalIndex < 0) return null;
    return arrivals[lastFilledArrivalIndex].odo;
  }, [arrivals, lastFilledArrivalIndex]);

  const totalDriveKm = useMemo(() => {
    if (departOdo == null || finalArrivalOdo == null) return null;
    const d = finalArrivalOdo - departOdo;
    if (!Number.isFinite(d)) return null;
    return d;
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

  useEffect(() => {
    const urlsToRevoke: string[] = [];
    setArrivals((prev) =>
      prev.map((a) => {
        if (a.preview?.startsWith("blob:")) urlsToRevoke.push(a.preview);
        return a;
      })
    );
    return () => {
      urlsToRevoke.forEach((u) => URL.revokeObjectURL(u));
    };
  }, []);

  /** ========= arrival state helpers ========= */
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
    setArrivals((prev) => {
      const idx = arrivalCount - 1;
      if (idx <= 0) return prev; // 到着1は残す
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
        if (!departManual) setDepartOdo(num);
        setDepartOcrStatus(
          `OCR成功: ${best}${departManual ? "（手書きモードなので上書きしない）" : ""}`
        );
      } else {
        const a = arrivals[which];
        if (!a.manual) setArrival(which, { odo: num });
        setArrival(which, {
          ocrStatus: `OCR成功: ${best}${a.manual ? "（手書きモードなので上書きしない）" : ""}`,
        });
      }
    } catch (e: any) {
      const msg = e?.message ? String(e.message) : "OCRでエラー";
      if (which === "depart") setDepartOcrStatus(msg);
      else setArrival(which, { ocrStatus: msg });
    } finally {
      setOcrBusyKey(null);
    }
  }

  useEffect(() => {
    if (!departPhoto || !departUseOcr) return;
    runOcr(departPhoto, "depart");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departPhoto, departUseOcr]);

  useEffect(() => {
    visibleArrivals.forEach((a, idx) => {
      if (a.photo && a.useOcr) {
        // 自動実行は「photoが変わった時」に限定したいので preview をキーにする
      }
    });
  }, [visibleArrivals]);

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

    return {
      depart_photo_path,
      depart_photo_url,
      arrivePaths,
      arriveUrls,
    };
  }

  /** ========= Power Automate ========= */
  async function postToFlow(payload: FlowPayload) {
    const res = await fetch("/api/powerautomate", {
      method: "POST",
      headers: { "content-type": "application/json" },
      // ※ route.ts が { payload } を受ける想定
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
    if (mode === "route" && arrivals[0].locationId == null) miss.push("到着１");

    // 表示中の到着1〜Nは「場所・写真・ODO」全部必須
    if (mode === "route") {
      for (let i = 0; i < arrivalCount; i++) {
        const a = arrivals[i];
        const n = i + 1;
        if (a.locationId == null) miss.push(`到着${n}`);
        if (!a.photo) miss.push(`写真(到着${n})`);
        if (a.odo == null) miss.push(`ODO(到着${n})`);
      }
    }

    if (mode === "route") {
      // 料金表にない区間 or 同地点連続
      if (computedAmountYen == null) {
        miss.push("金額（料金表に無い区間がある/同地点連続/未選択あり）");
      }
    }

    if (!departPhoto) miss.push("写真(出発)");
    if (departOdo == null) miss.push("ODO(出発)");

    if (totalDriveKm == null) miss.push("走行距離（km）");
    if (diffTooLarge) miss.push(`走行距離（差分が${DIFF_LIMIT_KM}km以上/マイナス）`);

    // 到着の途中抜けチェック（arrivalCount内）
    for (let i = 1; i < arrivalCount; i++) {
      if (arrivals[i].locationId != null && arrivals[i - 1].locationId == null) {
        miss.push(`到着${i + 1}の前に到着${i}を入力`);
      }
    }

    return Array.from(new Set(miss));
  }, [driverName, mode, fromId, arrivals, arrivalCount, computedAmountYen, departPhoto, departOdo, totalDriveKm, diffTooLarge]);

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

      // 最後に入力された到着ODO（総走行距離用）
      let lastIdx = -1;
      for (let i = arrivalCount - 1; i >= 0; i--) {
        if (arrivals[i].locationId != null) {
          lastIdx = i;
          break;
        }
      }
      const finalArrivalOdo = lastIdx >= 0 ? (odos[lastIdx] ?? null) : null;
      const totalDrive = departOdo != null && finalArrivalOdo != null ? finalArrivalOdo - departOdo : null;

      // =========================
      // 1) DB保存（新カラム仕様）
      // =========================
      const payloadDb = {
        driver_name: driverName,
        is_bus: mode === "bus",
        from_id: mode === "bus" ? null : fromId,

        // 旧カラム互換（最後の到着を to_id にも入れておくと既存集計が壊れにくい）
        to_id: mode === "bus" ? null : (toIds[lastIdx] ?? null),

        to1_id: mode === "bus" ? null : (toIds[0] ?? null),
        to2_id: mode === "bus" ? null : (toIds[1] ?? null),
        to3_id: mode === "bus" ? null : (toIds[2] ?? null),
        to4_id: mode === "bus" ? null : (toIds[3] ?? null),
        to5_id: mode === "bus" ? null : (toIds[4] ?? null),

        amount_yen: amountToSave,
        report_at: reportAtIso,

        // 旧カラム互換（最終到着ODO）
        depart_odometer_km: departOdo,
        arrive_odometer_km: finalArrivalOdo,

        // 新カラム
        arrive1_odometer_km: odos[0] ?? null,
        arrive2_odometer_km: odos[1] ?? null,
        arrive3_odometer_km: odos[2] ?? null,
        arrive4_odometer_km: odos[3] ?? null,
        arrive5_odometer_km: odos[4] ?? null,

        // 旧カラム互換（最後の到着写真）
        depart_photo_path: uploaded.depart_photo_path,
        depart_photo_url: uploaded.depart_photo_url,
        arrive_photo_path: lastIdx >= 0 ? uploaded.arrivePaths[lastIdx] : null,
        arrive_photo_url: lastIdx >= 0 ? uploaded.arriveUrls[lastIdx] : null,

        // 新カラム
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

        // 列不足のときは分かりやすく出す
        if (msg.includes("Could not find") || code === "PGRST204") {
          throw new Error(
            "DB列が足りません（pickup_ordersに到着1〜5用カラム未追加）\n" +
            "→ Supabase SQL Editorで ALTER TABLE を実行してから再度保存してね。\n" +
            `detail: ${msg}`
          );
        }

        throw new Error(`DB insert失敗: ${msg} ${detail} ${hint} (${code})`.trim());
      }

      // =========================
      // 2) Power Automate送信（Excel列名固定）
      // =========================
      const flowPayload = {
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

        // 距離欄 = ODO
        "距離（始）": departOdo ?? 0,
        "距離（到着１）": odos[0] ?? 0,
        "距離（到着２）": odos[1] ?? 0,
        "距離（到着３）": odos[2] ?? 0,
        "距離（到着４）": odos[3] ?? 0,
        "距離（到着５）": odos[4] ?? 0,

        // 総走行距離 = 最終到着ODO - 出発ODO
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
        await postToFlow(flowPayload as any);
        setStatus("保存しました（Power Automateにも送信OK）");
      } catch (e: any) {
        console.error("[flow send]", e);
        setStatus(
          `保存しました（ただしPower Automate送信は失敗）: ${e?.message ? String(e.message) : "error"
          }`
        );
      }

      // =========================
      // 3) リセット
      // =========================
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
      setDepartManual(false);
      setDepartUseOcr(true);
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
    if (totalDriveKm < 0) return "⚠ 最終到着ODOが出発より小さい（手書きで修正推奨）";
    if (totalDriveKm >= DIFF_LIMIT_KM)
      return `⚠ 差分が${DIFF_LIMIT_KM}km以上。手書きで修正推奨（保存不可）`;
    return "";
  }, [totalDriveKm]);

  return (
    <main className="min-h-screen bg-black text-white flex items-start justify-center px-4 py-10">
      <div className="w-full max-w-4xl">
        <h1 className="text-center text-2xl font-semibold mb-1">ピックアップ手当</h1>
        <p className="text-center text-sm text-white/60 mb-6">
          到着1〜5（場所・写真・ODO） / 距離欄はODO値 / 走行距離は最終到着ODO−出発ODO
        </p>

        <div className="rounded-2xl border border-white/10 bg-white/5 p-6 shadow-xl">
          {/* driver */}
          <div className="flex items-center gap-3 mb-5">
            <div className="text-sm text-white/70 w-16">運転者</div>
            <select
              value={driverName}
              onChange={(e) => setDriverName(e.target.value)}
              className="flex-1 rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
            >
              <option value="">選択</option>
              {DRIVER_NAMES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          {/* mode */}
          <div className="grid grid-cols-2 gap-2 mb-6">
            <button
              onClick={() => setMode("route")}
              className={`rounded-xl px-3 py-2 text-sm transition ${mode === "route" ? "bg-blue-900/70" : "bg-white/5 hover:bg-white/10"
                }`}
            >
              通常ルート
            </button>
            <button
              onClick={() => setMode("bus")}
              className={`rounded-xl px-3 py-2 text-sm transition ${mode === "bus" ? "bg-blue-900/70" : "bg-white/5 hover:bg-white/10"
                }`}
            >
              バス（固定）
            </button>
          </div>

          <div className="grid grid-cols-[110px_1fr] items-start gap-3 mb-4">
            {/* from */}
            <div className="text-sm text-white/70 mt-2">出発</div>
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

            {/* arrival count controls */}
            <div className="text-sm text-white/70 mt-2">到着数</div>
            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={addArrival}
                disabled={mode === "bus" || arrivalCount >= MAX_ARRIVALS}
                className="rounded-lg px-3 py-2 text-xs bg-white/10 hover:bg-white/15 disabled:opacity-50"
              >
                ＋ 到着を追加
              </button>
              <button
                type="button"
                onClick={removeArrival}
                disabled={mode === "bus" || arrivalCount <= 1}
                className="rounded-lg px-3 py-2 text-xs bg-white/10 hover:bg-white/15 disabled:opacity-50"
              >
                － 最後の到着を削除
              </button>
              <div className="text-xs text-white/50">最大{MAX_ARRIVALS}個</div>
            </div>

            {/* route preview */}
            <div className="text-sm text-white/70 mt-2">ルート</div>
            <div className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm">
              {mode === "bus" ? "バス（ルート入力なし）" : routeLabel || "—"}
            </div>

            {/* amount */}
            <div className="text-sm text-white/70 mt-2">金額</div>
            <div className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm">
              {mode === "bus" ? (
                <span className="font-semibold">2000円</span>
              ) : computedAmountYen != null ? (
                <span className="font-semibold">{computedAmountYen}円（到着1〜N合計）</span>
              ) : (
                <span className="text-yellow-200">—（料金表に無い区間がある/未選択あり）</span>
              )}
            </div>

            {/* report time */}
            <div className="text-sm text-white/70 mt-2">報告時間</div>
            <div className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm">
              {formatReportTimeJa(now)}
            </div>

            {/* depart odo */}
            <div className="text-sm text-white/70 mt-2">距離（始）</div>
            <div>
              <input
                value={departOdo == null ? "" : String(departOdo)}
                onChange={(e) => {
                  const v = onlyAsciiDigitsFromAnyWidth(e.target.value);
                  setDepartOdo(v === "" ? null : Number(v));
                }}
                placeholder="出発ODO（全角OK）"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
              />
              <div className="mt-2 flex items-center gap-2">
                <label className="text-xs text-white/70 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={departManual}
                    onChange={(e) => setDepartManual(e.target.checked)}
                  />
                  手書きモード（OCRで上書きしない）
                </label>
                <button
                  type="button"
                  onClick={() => departPhoto && runOcr(departPhoto, "depart")}
                  disabled={!departPhoto || ocrBusyKey != null}
                  className="rounded-lg px-3 py-2 text-xs bg-white/10 hover:bg-white/15 disabled:opacity-50"
                >
                  OCRで入れ直す
                </button>
              </div>
              {departOcrStatus ? <div className="mt-2 text-xs text-yellow-200">{departOcrStatus}</div> : null}
            </div>

            {/* depart photo */}
            <div className="text-sm text-white/70 mt-2">写真(出発)</div>
            <div>
              <div className="flex items-center gap-3">
                <FilePickButton
                  id="depart-photo"
                  onPick={(file) => setDepartPhoto(file)}
                />
                <label className="text-xs text-white/70 flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={departUseOcr}
                    onChange={(e) => setDepartUseOcr(e.target.checked)}
                    disabled={departManual}
                  />
                  強力OCRで自動入力
                </label>
              </div>
              {departPreview ? (
                <div className="mt-3">
                  <img
                    src={departPreview}
                    alt="depart preview"
                    className="max-h-40 rounded-lg border border-white/10"
                  />
                </div>
              ) : null}
            </div>
          </div>

          {/* arrivals 1..N */}
          {mode === "route" ? (
            <div className="space-y-4 mb-4">
              {Array.from({ length: arrivalCount }).map((_, idx) => {
                const a = arrivals[idx];
                const seg = segmentDiffs[idx];
                const busy = ocrBusyKey === `arrive-${idx}`;

                return (
                  <div key={idx} className="rounded-xl border border-white/10 bg-black/30 p-4">
                    <div className="text-sm font-semibold mb-3">到着{idx + 1}</div>

                    <div className="grid grid-cols-[110px_1fr] items-start gap-3">
                      <div className="text-sm text-white/70 mt-2">場所</div>
                      <select
                        value={a.locationId ?? ""}
                        onChange={(e) =>
                          setArrival(idx, {
                            locationId: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                        className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
                      >
                        <option value="">選択</option>
                        {locations.map((l) => (
                          <option key={l.id} value={l.id}>
                            {l.name}
                          </option>
                        ))}
                      </select>

                      <div className="text-sm text-white/70 mt-2">距離（到着{idx + 1}）</div>
                      <div>
                        <input
                          value={a.odo == null ? "" : String(a.odo)}
                          onChange={(e) => {
                            const v = onlyAsciiDigitsFromAnyWidth(e.target.value);
                            setArrival(idx, { odo: v === "" ? null : Number(v) });
                          }}
                          placeholder={`到着${idx + 1}ODO（全角OK）`}
                          className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
                        />

                        <div className="mt-2 flex items-center gap-2">
                          <label className="text-xs text-white/70 flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={a.manual}
                              onChange={(e) => setArrival(idx, { manual: e.target.checked })}
                            />
                            手書きモード（OCRで上書きしない）
                          </label>
                          <button
                            type="button"
                            onClick={() => a.photo && runOcr(a.photo, idx)}
                            disabled={!a.photo || ocrBusyKey != null}
                            className="rounded-lg px-3 py-2 text-xs bg-white/10 hover:bg-white/15 disabled:opacity-50"
                          >
                            OCRで入れ直す
                          </button>
                        </div>
                        {a.ocrStatus ? (
                          <div className="mt-2 text-xs text-yellow-200">{a.ocrStatus}</div>
                        ) : null}

                        <div className="mt-2 text-xs text-white/60">
                          区間走行距離（表示用）:{" "}
                          <span className="text-white">
                            {seg == null ? "—" : `${seg} km`}
                          </span>{" "}
                          （{idx === 0 ? "到着1−出発" : `到着${idx + 1}−到着${idx}`})
                        </div>
                      </div>

                      <div className="text-sm text-white/70 mt-2">写真(到着{idx + 1})</div>
                      <div>
                        <div className="flex items-center gap-3">
                          <FilePickButton
                            id={`arrival-photo-${idx}`}
                            onPick={async (f) => {
                              onArrivalPhotoChange(idx, f);
                              if (f && arrivals[idx].useOcr) {
                                await runOcr(f, idx);
                              }
                            }}
                          />
                          <label className="text-xs text-white/70 flex items-center gap-2">
                            <input
                              type="checkbox"
                              checked={a.useOcr}
                              onChange={(e) => setArrival(idx, { useOcr: e.target.checked })}
                              disabled={a.manual}
                            />
                            強力OCRで自動入力
                          </label>
                        </div>

                        {a.preview ? (
                          <div className="mt-3">
                            <img
                              src={a.preview}
                              alt={`arrive${idx + 1} preview`}
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
          ) : null}

          {/* total drive */}
          <div className="grid grid-cols-[110px_1fr] items-start gap-3 mb-4">
            <div className="text-sm text-white/70 mt-2">走行距離（km）</div>
            <div className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm">
              <div className="flex items-center gap-3">
                <span className="font-semibold">{totalDriveLabel}</span>
                {totalDriveHint ? <span className="text-xs text-yellow-200">{totalDriveHint}</span> : null}
              </div>
            </div>

            {/* note */}
            <div className="text-sm text-white/70 mt-2">備考</div>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="任意（DBには入れずExcelだけ送る）"
              className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
            />
          </div>

          {loadErr ? <div className="text-xs text-yellow-200 mb-3">{loadErr}</div> : null}

          {missingLabels.length ? (
            <div className="text-xs text-yellow-200 mb-3 whitespace-pre-wrap">
              未入力（備考以外は必須）：{"\n"}・{missingLabels.join("\n・")}
            </div>
          ) : null}

          {status ? <div className="text-sm text-yellow-200 mb-3 whitespace-pre-wrap">{status}</div> : null}

          <button
            onClick={onSave}
            disabled={!canSave}
            className="w-full rounded-xl bg-blue-900/70 hover:bg-blue-900/80 transition px-3 py-3 text-sm disabled:opacity-50"
            title={!canSave ? "備考以外に未入力があると保存できません" : ""}
          >
            {isSaving ? "保存中..." : "保存"}
          </button>

          <div className="mt-4 text-xs text-white/40">
            debug: locations={locations.length} fares={fares.length} / fromId={String(fromId)} /
            arrivalCount={arrivalCount} / arrivals=
            {JSON.stringify(
              arrivals.map((a) => ({
                locationId: a.locationId,
                odo: a.odo,
                hasPhoto: !!a.photo,
              }))
            )}
          </div>
        </div>
      </div>
    </main>
  );
}