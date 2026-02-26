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
  odoKm: number | null;
  photo: File | null;
  photoPreview: string | null;
  ocrStatus: string;
};

type UploadedArrivalPhoto = {
  path: string | null;
  url: string | null;
};

/** Excel / Power Automate 用（トップ階層キー） */
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
  "距離（始）→到着１": number | "";
  "距離（到着１→到着２）": number | "";
  "距離（到着２→到着３）": number | "";
  "距離（到着３→到着４）": number | "";
  "距離（到着４→到着５）": number | "";
  "距離（到着５→到着６）": number | "";
  "距離（到着６→到着７）": number | "";
  "距離（到着７→到着８）": number | "";

  "走行距離（km）": number | "";
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
const MAX_ARRIVALS = 8;
const DIFF_LIMIT_KM = 100;

function createEmptyArrival(): ArrivalInput {
  return {
    locationId: null,
    odoKm: null,
    photo: null,
    photoPreview: null,
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

/** 入力を「半角数字だけ」にして返す（全角OK） */
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
    const uniq = new Set(s.split("")).size;
    sc += Math.min(uniq, 6);
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

/** ========= main ========= */
export default function Page() {
  const [mode, setMode] = useState<Mode>("route");

  // master
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [fares, setFares] = useState<FareRow[]>([]);
  const [loadErr, setLoadErr] = useState("");

  // driver / route
  const [driverName, setDriverName] = useState("");
  const [fromId, setFromId] = useState<number | null>(null);

  // arrivals (1..8)
  const [arrivals, setArrivals] = useState<ArrivalInput[]>([createEmptyArrival()]);

  // note
  const [note, setNote] = useState("");

  // depart
  const [departOdo, setDepartOdo] = useState<number | null>(null);
  const [departPhoto, setDepartPhoto] = useState<File | null>(null);
  const [departPreview, setDepartPreview] = useState<string | null>(null);
  const [departOcrStatus, setDepartOcrStatus] = useState("");

  // OCR busy key
  const [ocrBusyKey, setOcrBusyKey] = useState<string | null>(null);

  // ui
  const [status, setStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);

  // current time label
  const [now, setNow] = useState<Date>(() => new Date());
  useEffect(() => {
    const t = setInterval(() => setNow(new Date()), 10_000);
    return () => clearInterval(t);
  }, []);

  /** hidden file inputs */
  const departFileRef = useRef<HTMLInputElement | null>(null);
  const arrivalFileRefs = useRef<Array<HTMLInputElement | null>>([]);

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
                ? `${prev} / fares取得に失敗（RLS/権限/テーブル名）`
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

  /** arrivals preview generate / cleanup */
  useEffect(() => {
    // no-op; each file change handles preview directly in updater
  }, [arrivals]);

  /** ========= lookup ========= */
  const locMap = useMemo(() => {
    const m = new Map<number, string>();
    for (const l of locations) m.set(l.id, l.name);
    return m;
  }, [locations]);

  const idToName = (id: number | null) => (id == null ? "" : locMap.get(id) ?? "");
  const fromName = useMemo(() => idToName(fromId), [fromId, locMap]);

  const activeArrivals = useMemo(() => {
    // 表示中arrivalsのうち、末尾空欄も含めるのではなく、配列全体をそのまま使う
    return arrivals;
  }, [arrivals]);

  const arrivalNames = useMemo(
    () => activeArrivals.map((a) => idToName(a.locationId)),
    [activeArrivals, locMap]
  );

  /** ========= route / amount ========= */
  function findFare(a: number, b: number): number | null {
    const direct = fares.find((f) => f.from_id === a && f.to_id === b);
    if (direct) return direct.amount_yen;
    const reverse = fares.find((f) => f.from_id === b && f.to_id === a);
    if (reverse) return reverse.amount_yen;
    return null;
  }

  const selectedArrivalIds = useMemo(
    () => activeArrivals.map((a) => a.locationId),
    [activeArrivals]
  );

  const routeChainNames = useMemo(() => {
    const names = [idToName(fromId), ...selectedArrivalIds.map((id) => idToName(id))].filter(
      (s) => s.trim().length > 0
    );
    return names.join("→");
  }, [fromId, selectedArrivalIds, locMap]);

  const computedAmountYen = useMemo(() => {
    if (mode === "bus") return 2000;
    if (fromId == null) return null;
    if (selectedArrivalIds.length === 0) return null;
    if (selectedArrivalIds.some((x) => x == null)) return null;

    const chain = [fromId, ...(selectedArrivalIds as number[])];
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
  }, [mode, fromId, selectedArrivalIds, fares]);

  /** ========= distances ========= */
  const segmentStartTo1 = useMemo(() => {
    const first = activeArrivals[0]?.odoKm ?? null;
    if (departOdo == null || first == null) return null;
    return first - departOdo;
  }, [departOdo, activeArrivals]);

  const betweenSegments = useMemo(() => {
    // 1->2, 2->3 ... 7->8 (max 7 values)
    const vals: Array<number | null> = [];
    for (let i = 0; i < MAX_ARRIVALS - 1; i++) {
      const a = activeArrivals[i]?.odoKm ?? null;
      const b = activeArrivals[i + 1]?.odoKm ?? null;
      if (a == null || b == null) vals.push(null);
      else vals.push(b - a);
    }
    return vals;
  }, [activeArrivals]);

  const totalDistanceKm = useMemo(() => {
    const lastOdo = activeArrivals.length
      ? activeArrivals[activeArrivals.length - 1]?.odoKm ?? null
      : null;
    if (departOdo == null || lastOdo == null) return null;
    return lastOdo - departOdo;
  }, [departOdo, activeArrivals]);

  const anyDistanceInvalid = useMemo(() => {
    const vals = [segmentStartTo1, ...betweenSegments, totalDistanceKm].filter(
      (v): v is number => v != null
    );
    return vals.some((v) => !Number.isFinite(v) || v < 0 || v >= DIFF_LIMIT_KM);
  }, [segmentStartTo1, betweenSegments, totalDistanceKm]);

  /** ========= OCR ========= */
  async function runOcr(file: File, key: string, apply: (num: number, msg: string) => void, setErr: (msg: string) => void) {
    if (ocrBusyKey) return;
    setOcrBusyKey(key);

    try {
      setErr("OCR中…（ODOの数字だけ）");
      const cropped = await cropMeterArea(file);

      const result = await Tesseract.recognize(cropped, "eng", {
        tessedit_char_whitelist: "0123456789",
      } as any);

      const raw = result?.data?.text ?? "";
      const best = pickBestDigits(String(raw));

      if (!best) {
        setErr("OCR失敗：数字が見つからない（近づけて/ブレ減らして）");
        return;
      }

      const num = Number(best);
      if (!Number.isFinite(num)) {
        setErr("OCR結果が不正（数字に変換できない）");
        return;
      }

      apply(num, `OCR成功: ${best}`);
    } catch (e: any) {
      setErr(e?.message ? String(e.message) : "OCRでエラー");
    } finally {
      setOcrBusyKey(null);
    }
  }

  // depart auto OCR
  useEffect(() => {
    if (!departPhoto) return;
    runOcr(
      departPhoto,
      "depart",
      (num, msg) => {
        setDepartOdo(num);
        setDepartOcrStatus(msg);
      },
      setDepartOcrStatus
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [departPhoto]);

  // arrivals auto OCR (run on each photo change)
  useEffect(() => {
    activeArrivals.forEach((a, idx) => {
      if (!a.photo) return;
      if (a.odoKm != null) return; // 既に入ってるなら再実行しない（軽量化）
      runOcr(
        a.photo,
        `arrival-${idx}`,
        (num, msg) => {
          setArrivals((prev) =>
            prev.map((x, i) =>
              i === idx ? { ...x, odoKm: num, ocrStatus: msg } : x
            )
          );
        },
        (msg) => {
          setArrivals((prev) =>
            prev.map((x, i) => (i === idx ? { ...x, ocrStatus: msg } : x))
          );
        }
      );
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [activeArrivals.map((a) => a.photo?.name ?? "").join("|")]);

  /** ========= storage upload ========= */
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
    const url = pub.data?.publicUrl ?? null;
    return { path, url };
  }

  async function uploadDepartAndArrivals(): Promise<{
    depart: { path: string | null; url: string | null };
    arrivals: UploadedArrivalPhoto[];
  }> {
    const depart = { path: null as string | null, url: null as string | null };
    if (departPhoto) {
      const r = await uploadOnePhoto(departPhoto, "depart");
      depart.path = r.path;
      depart.url = r.url;
    }

    const uploadedArrivals: UploadedArrivalPhoto[] = [];
    for (let i = 0; i < MAX_ARRIVALS; i++) {
      const f = activeArrivals[i]?.photo ?? null;
      if (!f) {
        uploadedArrivals.push({ path: null, url: null });
        continue;
      }
      const r = await uploadOnePhoto(f, `arrive_${i + 1}`);
      uploadedArrivals.push({ path: r.path, url: r.url });
    }
    return { depart, arrivals: uploadedArrivals };
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

    if (mode === "route") {
      if (fromId == null) miss.push("出発地");
      if (activeArrivals.length === 0) miss.push("到着1");
      activeArrivals.forEach((a, idx) => {
        const n = idx + 1;
        if (a.locationId == null) miss.push(`到着${n}(場所)`);
        if (a.odoKm == null) miss.push(`到着${n}(ODO)`);
        if (!a.photo) miss.push(`到着${n}(写真)`);
      });
      if (computedAmountYen == null) miss.push("金額（料金表に無い区間/未選択あり）");
    }

    if (departOdo == null) miss.push("距離（始）");
    if (!departPhoto) miss.push("写真(出発)");

    if (anyDistanceInvalid) miss.push(`距離（マイナス or ${DIFF_LIMIT_KM}km以上あり）`);

    return miss;
  }, [driverName, mode, fromId, activeArrivals, computedAmountYen, departOdo, departPhoto, anyDistanceInvalid]);

  const canSave = useMemo(() => !isSaving && missingLabels.length === 0, [isSaving, missingLabels]);

  /** ========= save ========= */
  async function onSave() {
    if (isSaving) return;
    setStatus("");

    if (missingLabels.length > 0) {
      setStatus(`未入力があります：\n・${missingLabels.join("\n・")}`);
      return;
    }

    setIsSaving(true);

    try {
      const nowAtSave = new Date();
      const reportAtIso = nowAtSave.toISOString();
      const reportAtExcel = formatDateTimeForExcel(nowAtSave);

      const amountToSave = mode === "bus" ? 2000 : (computedAmountYen as number);

      const uploads = await uploadDepartAndArrivals();

      const lastArrival = activeArrivals[activeArrivals.length - 1] ?? null;
      const lastArrivalId = lastArrival?.locationId ?? null;
      const lastArrivalOdo = lastArrival?.odoKm ?? null;
      const lastArrivalPhoto = uploads.arrivals[activeArrivals.length - 1] ?? { path: null, url: null };

      // DBは従来互換（最終到着を to / arrive_* に入れる）
      const payloadDb: PickupOrderInsert = {
        driver_name: driverName,
        is_bus: mode === "bus",
        from_id: mode === "bus" ? null : fromId,
        to_id: mode === "bus" ? null : lastArrivalId,
        amount_yen: amountToSave,
        report_at: reportAtIso,
        depart_odometer_km: departOdo,
        arrive_odometer_km: lastArrivalOdo,
        depart_photo_path: uploads.depart.path,
        depart_photo_url: uploads.depart.url,
        arrive_photo_path: lastArrivalPhoto.path,
        arrive_photo_url: lastArrivalPhoto.url,
      };

      const ins = await supabase.from("pickup_orders").insert(payloadDb);
      if (ins.error) {
        console.error("[insert pickup_orders]", ins.error);
        const e: any = ins.error;
        throw new Error(
          `DB insert失敗: ${e?.message ?? ""} ${e?.details ?? ""} ${e?.hint ?? ""} (${e?.code ?? ""})`.trim()
        );
      }

      const arrivalName8 = Array.from({ length: MAX_ARRIVALS }, (_, i) => idToName(activeArrivals[i]?.locationId ?? null));
      const arrivalPhotoUrl8 = Array.from({ length: MAX_ARRIVALS }, (_, i) => uploads.arrivals[i]?.url ?? "");

      const segStartTo1 = segmentStartTo1;
      const seg1to2 = betweenSegments[0] ?? null;
      const seg2to3 = betweenSegments[1] ?? null;
      const seg3to4 = betweenSegments[2] ?? null;
      const seg4to5 = betweenSegments[3] ?? null;
      const seg5to6 = betweenSegments[4] ?? null;
      const seg6to7 = betweenSegments[5] ?? null;
      const seg7to8 = betweenSegments[6] ?? null;

      const flowPayload: FlowPayload = {
        日付: reportAtExcel,
        運転者: driverName,
        出発地: mode === "bus" ? "" : fromName,

        到着１: mode === "bus" ? "" : arrivalName8[0] || "",
        到着２: mode === "bus" ? "" : arrivalName8[1] || "",
        到着３: mode === "bus" ? "" : arrivalName8[2] || "",
        到着４: mode === "bus" ? "" : arrivalName8[3] || "",
        到着５: mode === "bus" ? "" : arrivalName8[4] || "",
        到着６: mode === "bus" ? "" : arrivalName8[5] || "",
        到着７: mode === "bus" ? "" : arrivalName8[6] || "",
        到着８: mode === "bus" ? "" : arrivalName8[7] || "",

        バス: mode === "bus" ? "バス" : "通常ルート",
        "金額（円）": amountToSave,

        "距離（始）": departOdo ?? "",
        "距離（始）→到着１": segStartTo1 ?? "",
        "距離（到着１→到着２）": seg1to2 ?? "",
        "距離（到着２→到着３）": seg2to3 ?? "",
        "距離（到着３→到着４）": seg3to4 ?? "",
        "距離（到着４→到着５）": seg4to5 ?? "",
        "距離（到着５→到着６）": seg5to6 ?? "",
        "距離（到着６→到着７）": seg6to7 ?? "",
        "距離（到着７→到着８）": seg7to8 ?? "",

        "走行距離（km）": totalDistanceKm ?? "",
        備考: note?.trim() ?? "",

        出発写真URL: uploads.depart.url ?? "",
        到着写真URL到着１: arrivalPhotoUrl8[0] || "",
        到着写真URL到着２: arrivalPhotoUrl8[1] || "",
        到着写真URL到着３: arrivalPhotoUrl8[2] || "",
        到着写真URL到着４: arrivalPhotoUrl8[3] || "",
        到着写真URL到着５: arrivalPhotoUrl8[4] || "",
        到着写真URL到着６: arrivalPhotoUrl8[5] || "",
        到着写真URL到着７: arrivalPhotoUrl8[6] || "",
        到着写真URL到着８: arrivalPhotoUrl8[7] || "",
      };

      try {
        await postToFlow(flowPayload);
        setStatus("保存しました（Power Automateにも送信OK）");
      } catch (e: any) {
        console.error("[flow send]", e);
        setStatus(`保存しました（ただしPower Automate送信は失敗）: ${e?.message ?? "error"}`);
      }

      // reset
      setFromId(null);
      setArrivals([createEmptyArrival()]);
      setDepartOdo(null);
      setDepartPhoto(null);
      setDepartOcrStatus("");
      setNote("");
    } catch (e: any) {
      setStatus(e?.message ? String(e.message) : "保存でエラー");
    } finally {
      setIsSaving(false);
    }
  }

  /** ========= handlers ========= */
  function updateArrival(idx: number, patch: Partial<ArrivalInput>) {
    setArrivals((prev) => prev.map((a, i) => (i === idx ? { ...a, ...patch } : a)));
  }

  function addArrival() {
    setArrivals((prev) => {
      if (prev.length >= MAX_ARRIVALS) return prev;
      return [...prev, createEmptyArrival()];
    });
  }

  function removeLastArrival() {
    setArrivals((prev) => {
      if (prev.length <= 1) return prev;
      const last = prev[prev.length - 1];
      if (last.photoPreview) URL.revokeObjectURL(last.photoPreview);
      return prev.slice(0, -1);
    });
  }

  function onDepartFilePicked(file: File | null) {
    setDepartPhoto(file);
  }

  function onArrivalFilePicked(idx: number, file: File | null) {
    setArrivals((prev) =>
      prev.map((a, i) => {
        if (i !== idx) return a;
        if (a.photoPreview) URL.revokeObjectURL(a.photoPreview);

        if (!file) {
          return { ...a, photo: null, photoPreview: null, ocrStatus: "" };
        }

        const preview = URL.createObjectURL(file);
        return {
          ...a,
          photo: file,
          photoPreview: preview,
          ocrStatus: "",
          // 写真変わったら odo を空にして再OCR
          odoKm: null,
        };
      })
    );
  }

  useEffect(() => {
    if (mode === "bus") {
      // バスは簡易化（この画面では route用のままでも動くが、スッキリ）
      setArrivals([createEmptyArrival()]);
      setFromId(null);
    }
  }, [mode]);

  /** ========= render helpers ========= */
  const amountLabel = useMemo(() => {
    if (mode === "bus") return "2000円";
    if (computedAmountYen == null) return "—（料金表に無い区間がある/未選択あり）";
    return `${computedAmountYen}円`;
  }, [mode, computedAmountYen]);

  const distanceHint = useMemo(() => {
    if (!anyDistanceInvalid) return "";
    return `⚠ マイナスまたは${DIFF_LIMIT_KM}km以上の距離があります（保存不可）`;
  }, [anyDistanceInvalid]);

  return (
    <main className="min-h-screen bg-black text-white flex items-start justify-center px-3 py-4 sm:px-4 sm:py-8">
      <div className="w-full max-w-4xl">
        <h1 className="text-center text-2xl font-semibold mb-1">ピックアップ手当</h1>
        <p className="text-center text-xs sm:text-sm text-white/60 mb-4">
          到着1〜8（場所・写真・ODO） / Excelには区間距離を送信
        </p>

        <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 shadow-xl">
          {/* driver */}
          <div className="mb-4">
            <div className="mb-2 text-sm text-white/70">運転者</div>
            <select
              value={driverName}
              onChange={(e) => setDriverName(e.target.value)}
              className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
            >
              <option value="">選択</option>
              {DRIVER_NAMES.map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </div>

          {/* mode tabs */}
          <div className="grid grid-cols-2 gap-2 mb-5">
            <button
              type="button"
              onClick={() => setMode("route")}
              className={`rounded-2xl px-3 py-3 text-base sm:text-sm transition ${mode === "route" ? "bg-blue-900/70" : "bg-white/5 hover:bg-white/10"
                }`}
            >
              通常ルート
            </button>
            <button
              type="button"
              onClick={() => setMode("bus")}
              className={`rounded-2xl px-3 py-3 text-base sm:text-sm transition ${mode === "bus" ? "bg-blue-900/70" : "bg-white/5 hover:bg-white/10"
                }`}
            >
              バス（固定）
            </button>
          </div>

          {/* from */}
          <div className="mb-4">
            <div className="mb-2 text-sm text-white/70">出発地</div>
            <select
              value={fromId ?? ""}
              onChange={(e) => setFromId(e.target.value ? Number(e.target.value) : null)}
              disabled={mode === "bus"}
              className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm disabled:opacity-60"
            >
              <option value="">選択</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>

          {/* arrival count ops */}
          <div className="mb-4">
            <div className="mb-2 text-sm text-white/70">到着数</div>
            <div className="flex flex-wrap items-center gap-2">
              <button
                type="button"
                onClick={addArrival}
                disabled={mode === "bus" || arrivals.length >= MAX_ARRIVALS}
                className="rounded-xl px-3 py-2 text-sm bg-white/10 hover:bg-white/15 disabled:opacity-50"
              >
                ＋ 到着を追加
              </button>
              <button
                type="button"
                onClick={removeLastArrival}
                disabled={mode === "bus" || arrivals.length <= 1}
                className="rounded-xl px-3 py-2 text-sm bg-white/10 hover:bg-white/15 disabled:opacity-50"
              >
                － 最後の到着を削除
              </button>
              <span className="text-sm text-white/40">最大{MAX_ARRIVALS}個</span>
            </div>
          </div>

          {/* route */}
          <div className="mb-4">
            <div className="mb-2 text-sm text-white/70">ルート</div>
            <div className="rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm">
              {routeChainNames || "—"}
            </div>
          </div>

          {/* amount */}
          <div className="mb-4">
            <div className="mb-2 text-sm text-white/70">金額</div>
            <div className="rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm">
              {mode === "bus" ? (
                <span className="font-semibold">{amountLabel}</span>
              ) : computedAmountYen != null ? (
                <span className="font-semibold">{amountLabel}</span>
              ) : (
                <span className="text-yellow-200">{amountLabel}</span>
              )}
            </div>
          </div>

          {/* report time */}
          <div className="mb-4">
            <div className="mb-2 text-sm text-white/70">報告時間</div>
            <div className="rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm">
              {formatReportTimeJa(now)}
            </div>
          </div>

          {/* depart odo */}
          <div className="mb-4">
            <div className="mb-2 text-sm text-white/70">距離（始）</div>
            <input
              value={departOdo == null ? "" : String(departOdo)}
              onChange={(e) => {
                const v = onlyAsciiDigitsFromAnyWidth(e.target.value);
                setDepartOdo(v ? Number(v) : null);
              }}
              placeholder="出発ODO（全角OK）"
              className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
            />
            {departOcrStatus ? (
              <div className="mt-2 text-xs text-yellow-200">{departOcrStatus}</div>
            ) : null}
          </div>

          {/* depart photo */}
          <div className="mb-5">
            <div className="mb-2 text-sm text-white/70">写真(出発)</div>

            <div className="flex items-center gap-2">
              <input
                ref={departFileRef}
                type="file"
                accept="image/*"
                className="hidden"
                onChange={(e) => onDepartFilePicked(e.target.files?.[0] ?? null)}
              />
              <button
                type="button"
                onClick={() => departFileRef.current?.click()}
                className="rounded-xl px-3 py-2 text-sm bg-white/10 hover:bg-white/15"
              >
                写真を選ぶ
              </button>
              <span className="text-xs text-white/50 truncate">
                {departPhoto ? departPhoto.name : "未選択"}
              </span>
            </div>

            {departPreview ? (
              <img
                src={departPreview}
                alt="depart preview"
                className="mt-3 max-h-48 rounded-xl border border-white/10"
              />
            ) : null}
          </div>

          {/* arrivals blocks */}
          <div className="space-y-4 mb-5">
            {arrivals.map((a, idx) => {
              const n = idx + 1;
              const segLabel =
                idx === 0
                  ? `区間距離（表示用）：${segmentStartTo1 ?? "—"} ${segmentStartTo1 != null ? "km" : ""}（到着1-出発）`
                  : `区間距離（表示用）：${betweenSegments[idx - 1] ?? "—"} ${betweenSegments[idx - 1] != null ? "km" : ""
                  }（到着${n}-到着${n - 1}）`;

              return (
                <div key={idx} className="rounded-2xl border border-white/10 bg-black/20 p-4">
                  <div className="font-semibold mb-3">到着{n}</div>

                  <div className="grid grid-cols-1 gap-3">
                    <div>
                      <div className="mb-2 text-sm text-white/70">場所</div>
                      <select
                        value={a.locationId ?? ""}
                        onChange={(e) =>
                          updateArrival(idx, {
                            locationId: e.target.value ? Number(e.target.value) : null,
                          })
                        }
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
                    </div>

                    <div>
                      <div className="mb-2 text-sm text-white/70">距離（到着{n}）</div>
                      <input
                        value={a.odoKm == null ? "" : String(a.odoKm)}
                        onChange={(e) => {
                          const v = onlyAsciiDigitsFromAnyWidth(e.target.value);
                          updateArrival(idx, { odoKm: v ? Number(v) : null });
                        }}
                        placeholder={`到着${n}ODO（全角OK）`}
                        className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
                      />
                      {a.ocrStatus ? (
                        <div className="mt-2 text-xs text-yellow-200">{a.ocrStatus}</div>
                      ) : null}
                    </div>

                    <div className="text-xs text-white/60">{segLabel}</div>

                    <div>
                      <div className="mb-2 text-sm text-white/70">写真(到着{n})</div>
                      <div className="flex items-center gap-2">
                        <input
                          ref={(el) => {
                            arrivalFileRefs.current[idx] = el;
                          }}
                          type="file"
                          accept="image/*"
                          className="hidden"
                          onChange={(e) => onArrivalFilePicked(idx, e.target.files?.[0] ?? null)}
                        />
                        <button
                          type="button"
                          onClick={() => arrivalFileRefs.current[idx]?.click()}
                          className="rounded-xl px-3 py-2 text-sm bg-white/10 hover:bg-white/15"
                        >
                          写真を選ぶ
                        </button>
                        <span className="text-xs text-white/50 truncate">
                          {a.photo ? a.photo.name : "未選択"}
                        </span>
                      </div>

                      {a.photoPreview ? (
                        <img
                          src={a.photoPreview}
                          alt={`arrival${n} preview`}
                          className="mt-3 max-h-48 rounded-xl border border-white/10"
                        />
                      ) : null}
                    </div>
                  </div>
                </div>
              );
            })}
          </div>

          {/* total distance */}
          <div className="mb-4">
            <div className="mb-2 text-sm text-white/70">総走行距離（km）</div>
            <div className="rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm font-semibold">
              {totalDistanceKm == null ? "—" : `${totalDistanceKm} km`}
            </div>
            {distanceHint ? <div className="mt-2 text-xs text-yellow-200">{distanceHint}</div> : null}
          </div>

          {/* note */}
          <div className="mb-4">
            <div className="mb-2 text-sm text-white/70">備考</div>
            <input
              value={note}
              onChange={(e) => setNote(e.target.value)}
              placeholder="任意（DBには入れずExcelだけ送る）"
              className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-2 text-sm"
            />
          </div>

          {loadErr ? <div className="text-xs text-yellow-200 mb-3">{loadErr}</div> : null}

          {missingLabels.length > 0 ? (
            <div className="text-xs text-yellow-200 mb-3 whitespace-pre-wrap">
              未入力（備考以外は必須）：{"\n"}・{missingLabels.join("\n・")}
            </div>
          ) : null}

          {status ? (
            <div className="text-sm text-yellow-200 mb-3 whitespace-pre-wrap">{status}</div>
          ) : null}

          {/* sticky-ish save button on mobile feel */}
          <button
            onClick={onSave}
            disabled={!canSave}
            className="w-full rounded-xl bg-blue-900/70 hover:bg-blue-900/80 transition px-3 py-3 text-base sm:text-sm disabled:opacity-50"
            title={!canSave ? "備考以外に未入力があると保存できません" : ""}
          >
            {isSaving ? "保存中..." : "保存"}
          </button>

          <div className="mt-3 text-center text-xs text-white/40">
            写真を選ぶとODOを自動で読み取ります
          </div>

          <div className="mt-4 text-xs text-white/30 break-all">
            debug: arrivals={arrivals.length} / from={String(fromId)} / route={routeChainNames || "-"}
          </div>
        </div>
      </div>
    </main>
  );
}