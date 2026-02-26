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
  photoPreview: string | null;
  photoUrl?: string | null;
  photoPath?: string | null;
  ocrStatus?: string;
};

type PickupOrderInsert = {
  driver_name: string;
  is_bus: boolean;
  from_id: number | null;
  to_id: number | null;
  amount_yen: number;
  report_at: string;

  // DBに既存の基本ODOだけ保存（到着ODOは最終到着ODO）
  depart_odometer_km: number | null;
  arrive_odometer_km: number | null;

  depart_photo_path: string | null;
  depart_photo_url: string | null;
  arrive_photo_path: string | null;
  arrive_photo_url: string | null;
};

type FlowPayload = {
  日付: string;
  運転者: string;
  出発地: string;
  到着1: string;
  到着2: string;
  到着3: string;
  到着4: string;
  到着5: string;
  到着6: string;
  到着7: string;
  到着8: string;
  バス: string;
  "金額（円）": number | "";
  "距離（始）": number | "";
  "距離（始）〜到着1": number | "";
  "距離（到着1〜到着2）": number | "";
  "距離（到着2〜到着3）": number | "";
  "距離（到着3〜到着4）": number | "";
  "距離（到着4〜到着5）": number | "";
  "距離（到着5〜到着6）": number | "";
  "距離（到着6〜到着7）": number | "";
  "距離（到着7〜到着8）": number | "";
  "総走行距離（km）": number | "";
  備考: string;

  出発写真URL: string;
  到着写真URL到着1: string;
  到着写真URL到着2: string;
  到着写真URL到着3: string;
  到着写真URL到着4: string;
  到着写真URL到着5: string;
  到着写真URL到着6: string;
  到着写真URL到着7: string;
  到着写真URL到着8: string;
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
  return toHalfWidthDigits(s).replace(/[^\d]/g, "");
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

/** メーター付近トリミング */
async function cropMeterArea(file: File): Promise<Blob> {
  const img = document.createElement("img");
  img.src = URL.createObjectURL(file);

  await new Promise<void>((resolve, reject) => {
    img.onload = () => resolve();
    img.onerror = () => reject(new Error("画像読み込みに失敗（JPEG/PNG推奨）"));
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

function safeSegmentDiff(
  prev: number | null | undefined,
  next: number | null | undefined
): number | "" {
  if (prev == null || next == null) return "";
  if (!Number.isFinite(prev) || !Number.isFinite(next)) return "";
  const d = next - prev;
  if (d < 0) return "";
  return d;
}

function lastValidOdo(values: Array<number | null | undefined>): number | null {
  for (let i = values.length - 1; i >= 0; i--) {
    const v = values[i];
    if (v != null && Number.isFinite(v)) return v;
  }
  return null;
}

function makeEmptyArrival(): ArrivalInput {
  return {
    locationId: null,
    odo: null,
    photo: null,
    photoPreview: null,
    photoUrl: null,
    photoPath: null,
    ocrStatus: "",
  };
}

/** ========= main ========= */
export default function Page() {
  const [mode, setMode] = useState<Mode>("route");

  // master
  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [fares, setFares] = useState<FareRow[]>([]);
  const [loadErr, setLoadErr] = useState("");

  // basic
  const [driverName, setDriverName] = useState<string>("");
  const [fromId, setFromId] = useState<number | null>(null);
  const [arrivals, setArrivals] = useState<ArrivalInput[]>([makeEmptyArrival()]);
  const [note, setNote] = useState("");

  // depart
  const [departOdo, setDepartOdo] = useState<number | null>(null);
  const [departPhoto, setDepartPhoto] = useState<File | null>(null);
  const [departPreview, setDepartPreview] = useState<string | null>(null);
  const [departOcrStatus, setDepartOcrStatus] = useState("");

  // ui
  const [status, setStatus] = useState("");
  const [isSaving, setIsSaving] = useState(false);
  const [ocrBusyKey, setOcrBusyKey] = useState<string | null>(null);

  // time
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
            console.error(locRes.error);
          }
        } else if (!cancelled) {
          setLocations((locRes.data ?? []) as LocationRow[]);
        }

        const fareRes = await supabase.from("route_fares").select("from_id,to_id,amount_yen");
        if (fareRes.error) {
          if (!cancelled) {
            setFares([]);
            setLoadErr((prev) =>
              prev ? `${prev} / route_fares取得に失敗` : "route_fares取得に失敗"
            );
            console.error(fareRes.error);
          }
        } else if (!cancelled) {
          setFares((fareRes.data ?? []) as FareRow[]);
        }
      } catch (e) {
        if (!cancelled) {
          setLoadErr("マスタ取得で例外");
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

  const idToName = (id: number | null | undefined) => {
    if (id == null) return "";
    return locMap.get(id) ?? "";
  };

  const fromName = useMemo(() => idToName(fromId), [fromId, locMap]);

  const arrivalNames = useMemo(() => {
    const names = arrivals.map((a) => idToName(a.locationId));
    while (names.length < MAX_ARRIVALS) names.push("");
    return names.slice(0, MAX_ARRIVALS);
  }, [arrivals, locMap]);

  const routeLabel = useMemo(() => {
    const names = [fromName, ...arrivals.map((a) => idToName(a.locationId))].filter(Boolean);
    if (!names.length) return "—";
    return names.join("→");
  }, [fromName, arrivals, locMap]);

  /** ========= amount ========= */
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
    if (arrivals.length === 0) return null;
    if (arrivals.some((a) => a.locationId == null)) return null;

    const chain = [fromId, ...arrivals.map((a) => a.locationId as number)];
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
  }, [mode, fromId, arrivals, fares]);

  /** ========= distance ========= */
  const arrivalOdos = useMemo(() => {
    const xs = arrivals.map((a) => a.odo ?? null);
    while (xs.length < MAX_ARRIVALS) xs.push(null);
    return xs.slice(0, MAX_ARRIVALS);
  }, [arrivals]);

  const segmentDistances = useMemo(() => {
    const s1 = safeSegmentDiff(departOdo, arrivalOdos[0]);
    const s2 = safeSegmentDiff(arrivalOdos[0], arrivalOdos[1]);
    const s3 = safeSegmentDiff(arrivalOdos[1], arrivalOdos[2]);
    const s4 = safeSegmentDiff(arrivalOdos[2], arrivalOdos[3]);
    const s5 = safeSegmentDiff(arrivalOdos[3], arrivalOdos[4]);
    const s6 = safeSegmentDiff(arrivalOdos[4], arrivalOdos[5]);
    const s7 = safeSegmentDiff(arrivalOdos[5], arrivalOdos[6]);
    const s8 = safeSegmentDiff(arrivalOdos[6], arrivalOdos[7]);
    return [s1, s2, s3, s4, s5, s6, s7, s8] as const;
  }, [departOdo, arrivalOdos]);

  const totalKm = useMemo(() => {
    const finalOdo = lastValidOdo(arrivalOdos);
    return safeSegmentDiff(departOdo, finalOdo);
  }, [departOdo, arrivalOdos]);

  const anySegmentTooLarge = useMemo(() => {
    const vals = [...segmentDistances, totalKm];
    return vals.some((v) => typeof v === "number" && v >= DIFF_LIMIT_KM);
  }, [segmentDistances, totalKm]);

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
    setArrivals((prev) =>
      prev.map((a) => {
        if (!a.photo) {
          if (a.photoPreview) URL.revokeObjectURL(a.photoPreview);
          return { ...a, photoPreview: null };
        }
        if (a.photoPreview) return a;
        return { ...a, photoPreview: URL.createObjectURL(a.photo) };
      })
    );
  }, [arrivals.map((a) => a.photo).join("|")]); // eslint-disable-line react-hooks/exhaustive-deps

  /** ========= OCR ========= */
  async function runOcr(file: File, key: string): Promise<number | null> {
    if (ocrBusyKey) return null;
    setOcrBusyKey(key);

    try {
      const cropped = await cropMeterArea(file);
      const result = await Tesseract.recognize(cropped, "eng", {
        tessedit_char_whitelist: "0123456789",
      } as any);

      const raw = result?.data?.text ?? "";
      const best = pickBestDigits(String(raw));
      if (!best) return null;

      const n = Number(best);
      if (!Number.isFinite(n)) return null;
      return n;
    } catch (e) {
      console.error("[OCR]", e);
      return null;
    } finally {
      setOcrBusyKey(null);
    }
  }

  async function onDepartPhotoSelected(file: File | null) {
    setDepartPhoto(file);
    setDepartOcrStatus("");
    if (!file) return;
    setDepartOcrStatus("OCR中…");
    const n = await runOcr(file, "depart");
    if (n == null) {
      setDepartOcrStatus("OCR失敗（手入力してね）");
      return;
    }
    setDepartOdo(n);
    setDepartOcrStatus(`OCR成功: ${n}`);
  }

  async function onArrivalPhotoSelected(index: number, file: File | null) {
    setArrivals((prev) =>
      prev.map((a, i) => (i === index ? { ...a, photo: file, ocrStatus: "" } : a))
    );
    if (!file) return;

    setArrivals((prev) =>
      prev.map((a, i) => (i === index ? { ...a, ocrStatus: "OCR中…" } : a))
    );

    const n = await runOcr(file, `arrive-${index}`);
    if (n == null) {
      setArrivals((prev) =>
        prev.map((a, i) => (i === index ? { ...a, ocrStatus: "OCR失敗（手入力してね）" } : a))
      );
      return;
    }

    setArrivals((prev) =>
      prev.map((a, i) => (i === index ? { ...a, odo: n, ocrStatus: `OCR成功: ${n}` } : a))
    );
  }

  /** ========= storage upload ========= */
  async function uploadOnePhoto(file: File, prefix: string) {
    const ext = file.name.split(".").pop() || "jpg";
    const filename = `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}.${ext}`;
    const path = filename;

    const up = await supabase.storage.from(BUCKET).upload(path, file, {
      upsert: true,
      contentType: file.type || "image/jpeg",
    });

    if (up.error) throw new Error("写真アップロード失敗");

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
      throw new Error(`Power Automate送信失敗: ${res.status} ${j ? JSON.stringify(j) : text}`);
    }
    if (j && j.ok === false) {
      throw new Error(j.error || JSON.stringify(j));
    }
  }

  /** ========= validations ========= */
  const missingLabels = useMemo(() => {
    const miss: string[] = [];

    if (!driverName) miss.push("運転者");

    if (mode === "route") {
      if (fromId == null) miss.push("出発地");
      if (arrivals.length === 0) miss.push("到着1以上");
      arrivals.forEach((a, i) => {
        if (a.locationId == null) miss.push(`到着${i + 1}（場所）`);
        if (a.odo == null) miss.push(`到着${i + 1}ODO`);
        if (!a.photo) miss.push(`写真(到着${i + 1})`);
      });
      if (computedAmountYen == null) miss.push("金額（料金表に無い区間/同一地点連続）");
    }

    if (departOdo == null) miss.push("出発ODO");
    if (!departPhoto) miss.push("写真(出発)");

    if (anySegmentTooLarge) miss.push(`距離差分が${DIFF_LIMIT_KM}km以上あり`);

    return miss;
  }, [driverName, mode, fromId, arrivals, departOdo, departPhoto, computedAmountYen, anySegmentTooLarge]);

  const canSave = missingLabels.length === 0 && !isSaving;

  /** ========= arrivals ops ========= */
  function addArrival() {
    setArrivals((prev) => (prev.length >= MAX_ARRIVALS ? prev : [...prev, makeEmptyArrival()]));
  }

  function removeLastArrival() {
    setArrivals((prev) => (prev.length <= 1 ? prev : prev.slice(0, -1)));
  }

  function setArrivalField<K extends keyof ArrivalInput>(index: number, key: K, value: ArrivalInput[K]) {
    setArrivals((prev) => prev.map((a, i) => (i === index ? { ...a, [key]: value } : a)));
  }

  useEffect(() => {
    if (mode === "bus") {
      // バスは到着を1件だけ扱う（見た目上）
      setArrivals((prev) => (prev.length ? [prev[0]] : [makeEmptyArrival()]));
    }
  }, [mode]);

  /** ========= save ========= */
  async function onSave() {
    if (!canSave) {
      setStatus(`未入力あり：\n・${missingLabels.join("\n・")}`);
      return;
    }

    setIsSaving(true);
    setStatus("");

    try {
      const nowAtSave = new Date();
      const reportAtIso = nowAtSave.toISOString();
      const reportAtExcel = formatDateTimeForExcel(nowAtSave);
      const amountToSave = mode === "bus" ? 2000 : (computedAmountYen as number);

      // upload depart
      let depart_photo_path: string | null = null;
      let depart_photo_url: string | null = null;
      if (departPhoto) {
        const r = await uploadOnePhoto(departPhoto, "depart");
        depart_photo_path = r.path;
        depart_photo_url = r.url;
      }

      // upload arrivals
      const uploadedArrivals = [...arrivals];
      for (let i = 0; i < uploadedArrivals.length; i++) {
        if (!uploadedArrivals[i].photo) continue;
        const r = await uploadOnePhoto(uploadedArrivals[i].photo as File, `arrive_${i + 1}`);
        uploadedArrivals[i] = {
          ...uploadedArrivals[i],
          photoPath: r.path,
          photoUrl: r.url,
        };
      }

      // 最終到着（DB用）
      const finalArrival = [...uploadedArrivals].reverse().find((a) => a.locationId != null) ?? null;
      const finalArrivalOdo = lastValidOdo(uploadedArrivals.map((a) => a.odo));
      const finalArrivalPhotoPath = finalArrival?.photoPath ?? null;
      const finalArrivalPhotoUrl = finalArrival?.photoUrl ?? null;
      const finalToId = finalArrival?.locationId ?? null;

      // DB insert（基本形）
      const payloadDb: PickupOrderInsert = {
        driver_name: driverName,
        is_bus: mode === "bus",
        from_id: mode === "bus" ? null : fromId,
        to_id: mode === "bus" ? null : finalToId,
        amount_yen: amountToSave,
        report_at: reportAtIso,

        depart_odometer_km: departOdo,
        arrive_odometer_km: finalArrivalOdo,

        depart_photo_path,
        depart_photo_url,
        arrive_photo_path: finalArrivalPhotoPath,
        arrive_photo_url: finalArrivalPhotoUrl,
      };

      const ins = await supabase.from("pickup_orders").insert(payloadDb);
      if (ins.error) {
        throw new Error(`DB insert失敗: ${ins.error.message} (${ins.error.code ?? ""})`);
      }

      // payload用 配列整形（8件固定）
      const names8 = Array.from({ length: MAX_ARRIVALS }, (_, i) =>
        idToName(uploadedArrivals[i]?.locationId ?? null)
      );
      const odos8 = Array.from({ length: MAX_ARRIVALS }, (_, i) => uploadedArrivals[i]?.odo ?? null);
      const urls8 = Array.from({ length: MAX_ARRIVALS }, (_, i) => uploadedArrivals[i]?.photoUrl ?? "");

      const seg1 = safeSegmentDiff(departOdo, odos8[0]);
      const seg2 = safeSegmentDiff(odos8[0], odos8[1]);
      const seg3 = safeSegmentDiff(odos8[1], odos8[2]);
      const seg4 = safeSegmentDiff(odos8[2], odos8[3]);
      const seg5 = safeSegmentDiff(odos8[3], odos8[4]);
      const seg6 = safeSegmentDiff(odos8[4], odos8[5]);
      const seg7 = safeSegmentDiff(odos8[5], odos8[6]);
      const seg8 = safeSegmentDiff(odos8[6], odos8[7]);
      const total = safeSegmentDiff(departOdo, lastValidOdo(odos8));

      const flowPayload: FlowPayload = {
        日付: reportAtExcel,
        運転者: driverName,
        出発地: mode === "bus" ? "" : fromName,

        到着1: names8[0] || "",
        到着2: names8[1] || "",
        到着3: names8[2] || "",
        到着4: names8[3] || "",
        到着5: names8[4] || "",
        到着6: names8[5] || "",
        到着7: names8[6] || "",
        到着8: names8[7] || "",

        バス: mode === "bus" ? "バス" : "通常ルート",
        "金額（円）": amountToSave,

        "距離（始）": departOdo ?? "",
        "距離（始）〜到着1": seg1,
        "距離（到着1〜到着2）": seg2,
        "距離（到着2〜到着3）": seg3,
        "距離（到着3〜到着4）": seg4,
        "距離（到着4〜到着5）": seg5,
        "距離（到着5〜到着6）": seg6,
        "距離（到着6〜到着7）": seg7,
        "距離（到着7〜到着8）": seg8,
        "総走行距離（km）": total,

        備考: note.trim(),

        出発写真URL: depart_photo_url ?? "",
        到着写真URL到着1: urls8[0] || "",
        到着写真URL到着2: urls8[1] || "",
        到着写真URL到着3: urls8[2] || "",
        到着写真URL到着4: urls8[3] || "",
        到着写真URL到着5: urls8[4] || "",
        到着写真URL到着6: urls8[5] || "",
        到着写真URL到着7: urls8[6] || "",
        到着写真URL到着8: urls8[7] || "",
      };

      // ★デバッグ（必要なら残す）
      console.log("FLOW PAYLOAD", flowPayload);

      try {
        await postToFlow(flowPayload);
        setStatus("保存しました（Power Automate送信OK）");
      } catch (e: any) {
        console.error(e);
        setStatus(`DB保存OK / Power Automate送信失敗: ${e?.message ?? "error"}`);
      }

      // reset
      setFromId(null);
      setArrivals([makeEmptyArrival()]);
      setDepartOdo(null);
      setDepartPhoto(null);
      setDepartOcrStatus("");
      setNote("");
    } catch (e: any) {
      setStatus(e?.message ?? "保存エラー");
    } finally {
      setIsSaving(false);
    }
  }

  /** ========= ui labels ========= */
  const totalKmLabel = totalKm === "" ? "—" : `${totalKm} km`;

  return (
    <main className="min-h-screen bg-black text-white flex items-start justify-center px-4 py-6 sm:py-10">
      <div className="w-full max-w-4xl">
        <h1 className="text-center text-2xl font-semibold mb-2">ピックアップ手当</h1>
        <p className="text-center text-xs sm:text-sm text-white/60 mb-6">
          到着最大8 / ODOから区間距離を自動計算してExcel送信
        </p>

        <div className="rounded-2xl border border-white/10 bg-white/5 p-4 sm:p-6 shadow-xl">
          {/* driver */}
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

          {/* mode */}
          <div className="grid grid-cols-2 gap-2 mb-5">
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

          {/* from */}
          <div className="mb-4">
            <div className="mb-2 text-sm text-white/70">出発地</div>
            <select
              value={fromId ?? ""}
              onChange={(e) => setFromId(e.target.value ? Number(e.target.value) : null)}
              disabled={mode === "bus"}
              className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm disabled:opacity-60"
            >
              <option value="">選択</option>
              {locations.map((l) => (
                <option key={l.id} value={l.id}>
                  {l.name}
                </option>
              ))}
            </select>
          </div>

          {/* arrivals count ops */}
          <div className="mb-4">
            <div className="mb-2 text-sm text-white/70">到着数</div>
            <div className="flex flex-wrap gap-2 items-center">
              <button
                type="button"
                onClick={addArrival}
                disabled={arrivals.length >= MAX_ARRIVALS}
                className="rounded-xl px-3 py-2 text-sm bg-white/10 hover:bg-white/15 disabled:opacity-50"
              >
                ＋ 到着を追加
              </button>
              <button
                type="button"
                onClick={removeLastArrival}
                disabled={arrivals.length <= 1}
                className="rounded-xl px-3 py-2 text-sm bg-white/10 hover:bg-white/15 disabled:opacity-50"
              >
                － 最後の到着を削除
              </button>
              <span className="text-xs text-white/50">最大{MAX_ARRIVALS}個</span>
            </div>
          </div>

          {/* route / amount / time */}
          <div className="space-y-3 mb-5">
            <div>
              <div className="mb-2 text-sm text-white/70">ルート</div>
              <div className="rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm">
                {routeLabel}
              </div>
            </div>

            <div>
              <div className="mb-2 text-sm text-white/70">金額</div>
              <div className="rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm">
                {mode === "bus" ? (
                  <span className="font-semibold">2000円</span>
                ) : computedAmountYen != null ? (
                  <span className="font-semibold">{computedAmountYen}円</span>
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
          </div>

          {/* depart */}
          <div className="rounded-2xl border border-white/10 p-4 mb-5">
            <div className="font-semibold mb-3">出発</div>

            <div className="mb-3">
              <div className="mb-2 text-sm text-white/70">距離（始）</div>
              <input
                value={departOdo == null ? "" : String(departOdo)}
                onChange={(e) => {
                  const v = onlyAsciiDigitsFromAnyWidth(e.target.value);
                  setDepartOdo(v === "" ? null : Number(v));
                }}
                placeholder="出発ODO（全角OK）"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm"
              />
              {departOcrStatus ? <div className="mt-2 text-xs text-yellow-200">{departOcrStatus}</div> : null}
            </div>

            <div>
              <div className="mb-2 text-sm text-white/70">写真(出発)</div>
              <label className="inline-flex items-center justify-center rounded-xl px-4 py-2 bg-white/10 hover:bg-white/15 cursor-pointer text-sm">
                写真を選ぶ
                <input
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(e) => onDepartPhotoSelected(e.target.files?.[0] ?? null)}
                />
              </label>
              {departPreview ? (
                <div className="mt-3">
                  <img src={departPreview} alt="depart" className="max-h-40 rounded-lg border border-white/10" />
                </div>
              ) : null}
            </div>
          </div>

          {/* arrivals */}
          <div className="space-y-4 mb-5">
            {arrivals.map((a, i) => {
              const segLabel =
                i === 0
                  ? "距離（始）〜到着1"
                  : `距離（到着${i}〜到着${i + 1}）`;

              const segValue = segmentDistances[i];
              const segText = segValue === "" ? "—" : `${segValue} km`;

              return (
                <div key={i} className="rounded-2xl border border-white/10 p-4">
                  <div className="font-semibold mb-3">到着{i + 1}</div>

                  <div className="mb-3">
                    <div className="mb-2 text-sm text-white/70">場所</div>
                    <select
                      value={a.locationId ?? ""}
                      onChange={(e) =>
                        setArrivalField(i, "locationId", e.target.value ? Number(e.target.value) : null)
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

                  <div className="mb-3">
                    <div className="mb-2 text-sm text-white/70">ODO（到着{i + 1}）</div>
                    <input
                      value={a.odo == null ? "" : String(a.odo)}
                      onChange={(e) => {
                        const v = onlyAsciiDigitsFromAnyWidth(e.target.value);
                        setArrivalField(i, "odo", v === "" ? null : Number(v));
                      }}
                      placeholder={`到着${i + 1}ODO（全角OK）`}
                      className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm"
                    />
                    {a.ocrStatus ? <div className="mt-2 text-xs text-yellow-200">{a.ocrStatus}</div> : null}
                  </div>

                  <div className="mb-3">
                    <div className="mb-2 text-sm text-white/70">区間走行距離（表示用）</div>
                    <div className="rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm">
                      {segLabel}：{segText}
                    </div>
                  </div>

                  <div>
                    <div className="mb-2 text-sm text-white/70">写真(到着{i + 1})</div>
                    <label className="inline-flex items-center justify-center rounded-xl px-4 py-2 bg-white/10 hover:bg-white/15 cursor-pointer text-sm">
                      写真を選ぶ
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => onArrivalPhotoSelected(i, e.target.files?.[0] ?? null)}
                      />
                    </label>
                    {a.photoPreview ? (
                      <div className="mt-3">
                        <img
                          src={a.photoPreview}
                          alt={`arrival-${i + 1}`}
                          className="max-h-40 rounded-lg border border-white/10"
                        />
                      </div>
                    ) : null}
                  </div>
                </div>
              );
            })}
          </div>

          {/* total / note */}
          <div className="space-y-3 mb-4">
            <div>
              <div className="mb-2 text-sm text-white/70">総走行距離（km）</div>
              <div className="rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm font-semibold">
                {totalKmLabel}
              </div>
            </div>

            <div>
              <div className="mb-2 text-sm text-white/70">備考</div>
              <input
                value={note}
                onChange={(e) => setNote(e.target.value)}
                placeholder="任意"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-3 py-3 text-sm"
              />
            </div>
          </div>

          {/* errors/status */}
          {loadErr ? <div className="text-xs text-yellow-200 mb-3">{loadErr}</div> : null}

          {missingLabels.length ? (
            <div className="text-xs text-yellow-200 mb-3 whitespace-pre-wrap">
              未入力（備考以外必須）：{"\n"}・{missingLabels.join("\n・")}
            </div>
          ) : null}

          {status ? <div className="text-sm text-yellow-200 mb-3 whitespace-pre-wrap">{status}</div> : null}

          <button
            type="button"
            onClick={onSave}
            disabled={!canSave}
            className="w-full rounded-xl bg-blue-900/70 hover:bg-blue-900/80 transition px-3 py-3 text-sm disabled:opacity-50"
          >
            {isSaving ? "保存中..." : "保存"}
          </button>

          <div className="mt-4 text-xs text-white/40">
            写真を選ぶとODOを自動で読み取り（失敗時は手入力）
          </div>
        </div>
      </div>
    </main>
  );
}
