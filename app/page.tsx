"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { supabase } from "@/lib/supabaseClient";

type Mode = "route" | "bus";

type LocationRow = {
  id: number;
  name: string;
  kind?: string | null;
};

type FareRow = {
  from_id: number;
  to_id: number;
  amount_yen: number;
};

type ArrivalInput = {
  locationId: number | null;
  odoText: string; // 入力値（全角混在OK）
  odoNum: number | null; // 正規化後
  photoFile: File | null;
  photoPreviewUrl: string | null;
  photoUploadedUrl: string | null;
};

type MasterResponse = {
  locations: LocationRow[];
  route_rates?: FareRow[];
  fares?: FareRow[];
};

const DRIVER_NAMES = [
  "拓哉", "ロヒップ", "カビブ", "ナルディ", "フェブリ", "アジ", "ダニ", "ハン",
  "アンガ", "コウォ", "ワヒュ", "ソレ", "照太", "エルヴァンド", "ヨガ", "ヘンキ",
  "ラフリ", "大空", "優稀", "ワルヨ", "アンディ", "ディカ", "ディッキー", "ダニー",
  "アシ", "フェブリ", "ユフェリ"
];

const MAX_ARRIVALS = 8;

function z2hDigits(input: string): string {
  return input.replace(/[０-９]/g, (s) =>
    String.fromCharCode(s.charCodeAt(0) - 0xfee0)
  );
}

function normalizeNumberText(input: string): string {
  return z2hDigits(input).replace(/[^\d]/g, "");
}

function parseNullableInt(input: string): number | null {
  const n = normalizeNumberText(input);
  if (!n) return null;
  const v = Number(n);
  return Number.isFinite(v) ? v : null;
}

function formatReportAtForExcel(date: Date): string {
  // Excelに文字列で渡す（例: 2026/2/27 08:15）
  const y = date.getFullYear();
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const hh = String(date.getHours()).padStart(2, "0");
  const mm = String(date.getMinutes()).padStart(2, "0");
  return `${y}/${m}/${d} ${hh}:${mm}`;
}

function formatReportAtDisplay(date: Date): string {
  // 画面表示用（例: 26年2月27日8時15分（自動））
  const yy = String(date.getFullYear()).slice(-2);
  const m = date.getMonth() + 1;
  const d = date.getDate();
  const h = date.getHours();
  const min = String(date.getMinutes()).padStart(2, "0");
  return `${yy}年${m}月${d}日${h}時${min}分（自動）`;
}

function asExcelCell(value: unknown): string | number {
  if (value === null || value === undefined) return "";
  if (typeof value === "number" && Number.isFinite(value)) return value;
  const s = String(value).trim();
  return s === "" ? "" : s;
}

function calcSegmentDistance(fromOdo: number | null, toOdo: number | null): number | "" {
  if (typeof fromOdo !== "number" || typeof toOdo !== "number") return "";
  if (!Number.isFinite(fromOdo) || !Number.isFinite(toOdo)) return "";
  const diff = toOdo - fromOdo;
  return diff >= 0 ? diff : "";
}

function sumSegmentDistances(values: Array<number | "">): number | null {
  const nums = values.filter((v): v is number => typeof v === "number" && Number.isFinite(v));
  if (nums.length === 0) return null;
  return nums.reduce((a, b) => a + b, 0);
}

function emptyArrival(): ArrivalInput {
  return {
    locationId: null,
    odoText: "",
    odoNum: null,
    photoFile: null,
    photoPreviewUrl: null,
    photoUploadedUrl: null,
  };
}

export default function Page() {
  const [loadingMaster, setLoadingMaster] = useState(true);
  const [saving, setSaving] = useState(false);
  const [errMsg, setErrMsg] = useState<string>("");
  const [okMsg, setOkMsg] = useState<string>("");

  const [locations, setLocations] = useState<LocationRow[]>([]);
  const [fareRows, setFareRows] = useState<FareRow[]>([]);

  const [driverName, setDriverName] = useState<string>("ダニー");
  const [mode, setMode] = useState<Mode>("route");

  const [fromId, setFromId] = useState<number | null>(null);

  const [arrivalCount, setArrivalCount] = useState<number>(1);
  const [arrivals, setArrivals] = useState<ArrivalInput[]>(
    Array.from({ length: MAX_ARRIVALS }, () => emptyArrival())
  );

  const [departOdoText, setDepartOdoText] = useState("");
  const [departOdoNum, setDepartOdoNum] = useState<number | null>(null);

  const [departPhotoFile, setDepartPhotoFile] = useState<File | null>(null);
  const [departPhotoPreviewUrl, setDepartPhotoPreviewUrl] = useState<string | null>(null);
  const [departPhotoUploadedUrl, setDepartPhotoUploadedUrl] = useState<string | null>(null);

  const [note, setNote] = useState("");

  const departInputRef = useRef<HTMLInputElement | null>(null);
  const arrivalInputRefs = useRef<Array<HTMLInputElement | null>>([]);

  const reportAtNow = useMemo(() => new Date(), [saving]); // 保存時に更新されやすいよう軽くトリガー
  const reportAtDisplay = formatReportAtDisplay(reportAtNow);
  const reportAtExcel = formatReportAtForExcel(reportAtNow);

  useEffect(() => {
    let alive = true;
    (async () => {
      try {
        setLoadingMaster(true);
        setErrMsg("");

        // 既存APIに合わせて調整可
        const r = await fetch("/api/master", { cache: "no-store" });
        if (!r.ok) throw new Error(`/api/master failed: ${r.status}`);

        const data: MasterResponse = await r.json();
        if (!alive) return;

        setLocations(Array.isArray(data.locations) ? data.locations : []);
        const fares = Array.isArray(data.route_rates)
          ? data.route_rates
          : Array.isArray(data.fares)
            ? data.fares
            : [];
        setFareRows(fares);
      } catch (e: any) {
        if (!alive) return;
        setErrMsg(`マスタ読込失敗: ${e?.message ?? "unknown error"}`);
      } finally {
        if (alive) setLoadingMaster(false);
      }
    })();

    return () => {
      alive = false;
    };
  }, []);

  const locationNameById = useMemo(() => {
    const m = new Map<number, string>();
    for (const l of locations) m.set(l.id, l.name);
    return m;
  }, [locations]);

  const visibleArrivals = arrivals.slice(0, arrivalCount);

  const routeNames = useMemo(() => {
    const names: string[] = [];
    if (fromId) names.push(locationNameById.get(fromId) ?? "");
    for (let i = 0; i < arrivalCount; i++) {
      const a = arrivals[i];
      if (a.locationId) names.push(locationNameById.get(a.locationId) ?? "");
    }
    return names.filter(Boolean).join("→");
  }, [fromId, arrivals, arrivalCount, locationNameById]);

  function getFareOneWay(from: number, to: number): number | null {
    if (!from || !to) return null;
    const direct = fareRows.find((f) => f.from_id === from && f.to_id === to);
    if (direct) return direct.amount_yen;
    const reverse = fareRows.find((f) => f.from_id === to && f.to_id === from);
    if (reverse) return reverse.amount_yen;
    return null;
  }

  const totalAmountYen = useMemo(() => {
    if (mode === "bus") {
      // 必要なら固定料金に変更
      return 2400;
    }
    if (!fromId) return null;

    let cur = fromId;
    let sum = 0;
    let hasAny = false;

    for (let i = 0; i < arrivalCount; i++) {
      const next = arrivals[i].locationId;
      if (!next) return null; // 未選択あり
      const fare = getFareOneWay(cur, next);
      if (fare == null) return null; // 料金表に無い区間
      sum += fare;
      hasAny = true;
      cur = next;
    }
    return hasAny ? sum : null;
  }, [mode, fromId, arrivals, arrivalCount, fareRows]);

  const segmentDistances = useMemo(() => {
    const a0 = arrivals[0]?.odoNum ?? null;
    const a1 = arrivals[1]?.odoNum ?? null;
    const a2 = arrivals[2]?.odoNum ?? null;
    const a3 = arrivals[3]?.odoNum ?? null;
    const a4 = arrivals[4]?.odoNum ?? null;
    const a5 = arrivals[5]?.odoNum ?? null;
    const a6 = arrivals[6]?.odoNum ?? null;
    const a7 = arrivals[7]?.odoNum ?? null;

    const s0 = calcSegmentDistance(departOdoNum, a0);
    const s1 = calcSegmentDistance(a0, a1);
    const s2 = calcSegmentDistance(a1, a2);
    const s3 = calcSegmentDistance(a2, a3);
    const s4 = calcSegmentDistance(a3, a4);
    const s5 = calcSegmentDistance(a4, a5);
    const s6 = calcSegmentDistance(a5, a6);
    const s7 = calcSegmentDistance(a6, a7);

    return [s0, s1, s2, s3, s4, s5, s6, s7] as const;
  }, [departOdoNum, arrivals]);

  const totalDistanceKm = useMemo(() => {
    return sumSegmentDistances([...segmentDistances]);
  }, [segmentDistances]);

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
      if (old?.photoPreviewUrl) URL.revokeObjectURL(old.photoPreviewUrl);
      next[idx] = emptyArrival();
      return next;
    });
    setArrivalCount((c) => Math.max(1, c - 1));
  }

  async function uploadPhoto(file: File, kind: "depart" | "arrive", index?: number): Promise<string> {
    const ext = file.name.split(".").pop() || "jpg";
    const ts = Date.now();
    const safeKind = kind === "depart" ? "depart" : "arrive";
    const suffix = typeof index === "number" ? `_${index + 1}` : "";
    const path = `${safeKind}/${ts}${suffix}.${ext}`;

    const { error } = await supabase.storage.from("order-photos").upload(path, file, {
      upsert: true,
      contentType: file.type || "image/jpeg",
    });
    if (error) throw new Error(`写真アップロード失敗: ${error.message}`);

    const { data } = supabase.storage.from("order-photos").getPublicUrl(path);
    return data.publicUrl;
  }

  async function tryOcrFromImage(file: File): Promise<number | null> {
    try {
      const fd = new FormData();
      fd.append("file", file);

      const r = await fetch("/api/ocr", {
        method: "POST",
        body: fd,
      });
      if (!r.ok) return null;

      const data = await r.json();
      // 期待: { odo: 123456 } or { value: "123456" } などに対応
      const raw = data?.odo ?? data?.value ?? data?.text ?? null;
      if (raw == null) return null;
      const n = parseNullableInt(String(raw));
      return n;
    } catch {
      return null;
    }
  }

  async function onSelectDepartPhoto(file: File) {
    if (departPhotoPreviewUrl) URL.revokeObjectURL(departPhotoPreviewUrl);

    const preview = URL.createObjectURL(file);
    setDepartPhotoFile(file);
    setDepartPhotoPreviewUrl(preview);

    // 手書きモード/自動入力チェックは消したので、常に軽くOCR試す
    const ocr = await tryOcrFromImage(file);
    if (ocr != null) {
      setDepartOdoNum(ocr);
      setDepartOdoText(String(ocr));
    }
  }

  async function onSelectArrivalPhoto(index: number, file: File) {
    const oldPreview = arrivals[index]?.photoPreviewUrl;
    if (oldPreview) URL.revokeObjectURL(oldPreview);

    const preview = URL.createObjectURL(file);
    updateArrival(index, {
      photoFile: file,
      photoPreviewUrl: preview,
      photoUploadedUrl: null,
    });

    const ocr = await tryOcrFromImage(file);
    if (ocr != null) {
      updateArrival(index, {
        odoNum: ocr,
        odoText: String(ocr),
      });
    }
  }

  function buildExcelPayload() {
    const fromName = fromId ? locationNameById.get(fromId) ?? "" : "";
    const modeLabel = mode === "bus" ? "バス（固定）" : "通常ルート";

    const arr = Array.from({ length: MAX_ARRIVALS }, (_, i) => {
      const a = arrivals[i];
      return {
        locationName: a.locationId ? locationNameById.get(a.locationId) ?? "" : "",
        odo: a.odoNum,
        photoUrl: a.photoUploadedUrl ?? "",
      };
    });

    const s0 = calcSegmentDistance(departOdoNum, arr[0].odo);
    const s1 = calcSegmentDistance(arr[0].odo, arr[1].odo);
    const s2 = calcSegmentDistance(arr[1].odo, arr[2].odo);
    const s3 = calcSegmentDistance(arr[2].odo, arr[3].odo);
    const s4 = calcSegmentDistance(arr[3].odo, arr[4].odo);
    const s5 = calcSegmentDistance(arr[4].odo, arr[5].odo);
    const s6 = calcSegmentDistance(arr[5].odo, arr[6].odo);
    const s7 = calcSegmentDistance(arr[6].odo, arr[7].odo);

    const totalKm = sumSegmentDistances([s0, s1, s2, s3, s4, s5, s6, s7]);

    // Excelの列名に完全一致（今の表）
    const payload = {
      日付: asExcelCell(reportAtExcel),
      運転者: asExcelCell(driverName),
      出発地: asExcelCell(fromName),

      到着1: asExcelCell(arr[0].locationName),
      到着2: asExcelCell(arr[1].locationName),
      到着3: asExcelCell(arr[2].locationName),
      到着4: asExcelCell(arr[3].locationName),
      到着5: asExcelCell(arr[4].locationName),
      到着6: asExcelCell(arr[5].locationName),
      到着7: asExcelCell(arr[6].locationName),
      到着8: asExcelCell(arr[7].locationName),

      バス: asExcelCell(mode === "bus" ? "バス" : "通常ルート"),
      "金額（円）": asExcelCell(totalAmountYen),

      "距離（始）": asExcelCell(departOdoNum),
      "距離（始）〜到着1": asExcelCell(s0),
      "距離（到着1〜到着2）": asExcelCell(s1),
      "距離（到着2〜到着3）": asExcelCell(s2),
      "距離（到着3〜到着4）": asExcelCell(s3),
      "距離（到着4〜到着5）": asExcelCell(s4),
      "距離（到着5〜到着6）": asExcelCell(s5),
      "距離（到着6〜到着7）": asExcelCell(s6),
      "距離（到着7〜到着8）": asExcelCell(s7),

      "総走行距離（km）": asExcelCell(totalKm),
      備考: asExcelCell(note),

      出発写真URL: asExcelCell(departPhotoUploadedUrl ?? ""),
      到着写真URL到着1: asExcelCell(arr[0].photoUrl),
      到着写真URL到着2: asExcelCell(arr[1].photoUrl),
      到着写真URL到着3: asExcelCell(arr[2].photoUrl),
      到着写真URL到着4: asExcelCell(arr[3].photoUrl),
      到着写真URL到着5: asExcelCell(arr[4].photoUrl),
      到着写真URL到着6: asExcelCell(arr[5].photoUrl),
      到着写真URL到着7: asExcelCell(arr[6].photoUrl),
      到着写真URL到着8: asExcelCell(arr[7].photoUrl),
    };

    console.log("=== POWER AUTOMATE PAYLOAD ===");
    console.log(payload);
    console.log(JSON.stringify(payload, null, 2));

    return payload;
  }

  async function sendToPowerAutomate() {
    const payload = buildExcelPayload();

    const r = await fetch("/api/powerautomate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });

    const data = await r.json().catch(() => ({}));
    if (!r.ok || !data?.ok) {
      throw new Error(
        `Power Automate送信失敗: status=${r.status} / ${JSON.stringify(data)}`
      );
    }
  }

  function validateRequired(): string[] {
    const errs: string[] = [];
    if (!driverName) errs.push("運転者");
    if (!fromId) errs.push("出発地");
    if (arrivalCount < 1) errs.push("到着1");
    for (let i = 0; i < arrivalCount; i++) {
      if (!arrivals[i].locationId) errs.push(`到着${i + 1}`);
    }
    if (!departOdoNum) errs.push("距離（始）");
    return errs;
  }

  async function handleSave() {
    setErrMsg("");
    setOkMsg("");

    try {
      const missing = validateRequired();
      if (missing.length > 0) {
        throw new Error(`未入力（備考以外必須）: ${missing.join(" / ")}`);
      }

      setSaving(true);

      // 写真アップロード（出発）
      let departPhotoUrl = departPhotoUploadedUrl;
      if (departPhotoFile && !departPhotoUrl) {
        departPhotoUrl = await uploadPhoto(departPhotoFile, "depart");
        setDepartPhotoUploadedUrl(departPhotoUrl);
      }

      // 写真アップロード（到着1〜8）
      const uploadedArrivalUrls: (string | null)[] = Array(MAX_ARRIVALS).fill(null);
      for (let i = 0; i < MAX_ARRIVALS; i++) {
        const a = arrivals[i];
        if (a.photoUploadedUrl) {
          uploadedArrivalUrls[i] = a.photoUploadedUrl;
          continue;
        }
        if (a.photoFile) {
          const u = await uploadPhoto(a.photoFile, "arrive", i);
          uploadedArrivalUrls[i] = u;
          updateArrival(i, { photoUploadedUrl: u });
        }
      }

      // ここで state同期前でも payload に乗るようローカル反映
      setDepartPhotoUploadedUrl(departPhotoUrl ?? null);
      setArrivals((prev) =>
        prev.map((a, i) => ({
          ...a,
          photoUploadedUrl: uploadedArrivalUrls[i] ?? a.photoUploadedUrl ?? null,
        }))
      );

      // state更新待ちせず、今の値から payload を送るため一時的に直接再構成
      // buildExcelPayload は state参照なので、アップロードURL反映版で送るため stateミラー作成
      const savedDepartPhotoUploadedUrl = departPhotoUrl ?? null;
      const savedArrivals = arrivals.map((a, i) => ({
        ...a,
        photoUploadedUrl: uploadedArrivalUrls[i] ?? a.photoUploadedUrl ?? null,
      }));

      // ---- DB保存（必要ならここに残す/調整）----
      // 既存DBスキーマ差異が大きい可能性があるので、Excel送信を優先したい場合はDB保存をコメントアウトでもOK。
      // 今回はDB保存を触らず、Power Automateを先に安定させる。
      // ------------------------------------------

      // Power Automate送信（ローカル一時上書きで確実に値を使う）
      const originalArrivals = arrivals;
      const originalDepartUrl = departPhotoUploadedUrl;

      // 一時的に state を使う build関数へ反映
      // （React state setは非同期なので、ここは直接 payload生成関数をローカル版で作る）
      {
        const fromName = fromId ? locationNameById.get(fromId) ?? "" : "";
        const arr = Array.from({ length: MAX_ARRIVALS }, (_, i) => {
          const a = savedArrivals[i];
          return {
            locationName: a.locationId ? locationNameById.get(a.locationId) ?? "" : "",
            odo: a.odoNum,
            photoUrl: a.photoUploadedUrl ?? "",
          };
        });

        const s0 = calcSegmentDistance(departOdoNum, arr[0].odo);
        const s1 = calcSegmentDistance(arr[0].odo, arr[1].odo);
        const s2 = calcSegmentDistance(arr[1].odo, arr[2].odo);
        const s3 = calcSegmentDistance(arr[2].odo, arr[3].odo);
        const s4 = calcSegmentDistance(arr[3].odo, arr[4].odo);
        const s5 = calcSegmentDistance(arr[4].odo, arr[5].odo);
        const s6 = calcSegmentDistance(arr[5].odo, arr[6].odo);
        const s7 = calcSegmentDistance(arr[6].odo, arr[7].odo);
        const totalKm = sumSegmentDistances([s0, s1, s2, s3, s4, s5, s6, s7]);

        const payload = {
          日付: asExcelCell(reportAtExcel),
          運転者: asExcelCell(driverName),
          出発地: asExcelCell(fromName),

          到着1: asExcelCell(arr[0].locationName),
          到着2: asExcelCell(arr[1].locationName),
          到着3: asExcelCell(arr[2].locationName),
          到着4: asExcelCell(arr[3].locationName),
          到着5: asExcelCell(arr[4].locationName),
          到着6: asExcelCell(arr[5].locationName),
          到着7: asExcelCell(arr[6].locationName),
          到着8: asExcelCell(arr[7].locationName),

          バス: asExcelCell(mode === "bus" ? "バス" : "通常ルート"),
          "金額（円）": asExcelCell(totalAmountYen),

          "距離（始）": asExcelCell(departOdoNum),
          "距離（始）〜到着1": asExcelCell(s0),
          "距離（到着1〜到着2）": asExcelCell(s1),
          "距離（到着2〜到着3）": asExcelCell(s2),
          "距離（到着3〜到着4）": asExcelCell(s3),
          "距離（到着4〜到着5）": asExcelCell(s4),
          "距離（到着5〜到着6）": asExcelCell(s5),
          "距離（到着6〜到着7）": asExcelCell(s6),
          "距離（到着7〜到着8）": asExcelCell(s7),

          "総走行距離（km）": asExcelCell(totalKm),
          備考: asExcelCell(note),

          出発写真URL: asExcelCell(savedDepartPhotoUploadedUrl ?? ""),
          到着写真URL到着1: asExcelCell(arr[0].photoUrl),
          到着写真URL到着2: asExcelCell(arr[1].photoUrl),
          到着写真URL到着3: asExcelCell(arr[2].photoUrl),
          到着写真URL到着4: asExcelCell(arr[3].photoUrl),
          到着写真URL到着5: asExcelCell(arr[4].photoUrl),
          到着写真URL到着6: asExcelCell(arr[5].photoUrl),
          到着写真URL到着7: asExcelCell(arr[6].photoUrl),
          到着写真URL到着8: asExcelCell(arr[7].photoUrl),
        };

        console.log("=== POWER AUTOMATE PAYLOAD (FINAL) ===");
        console.log(payload);
        console.log(JSON.stringify(payload, null, 2));

        const r = await fetch("/api/powerautomate", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        const data = await r.json().catch(() => ({}));
        if (!r.ok || !data?.ok) {
          throw new Error(`Power Automate送信失敗: status=${r.status} / ${JSON.stringify(data)}`);
        }
      }

      setOkMsg("保存しました（Excel送信OK）");
    } catch (e: any) {
      setErrMsg(e?.message ?? "保存失敗");
    } finally {
      setSaving(false);
    }
  }

  return (
    <main className="min-h-screen bg-black text-white">
      <div className="mx-auto w-full max-w-4xl px-4 py-8">
        <h1 className="text-center text-3xl font-bold">ピックアップ手当</h1>
        <p className="mt-2 text-center text-sm text-white/60">
          到着1〜8（場所・写真・ODO）/ 距離欄は区間距離 / 総走行距離は区間合計
        </p>

        {loadingMaster && (
          <div className="mt-4 rounded-xl border border-white/10 bg-white/5 px-4 py-3 text-sm text-white/80">
            マスタ読み込み中...
          </div>
        )}
        {errMsg && (
          <div className="mt-4 rounded-xl border border-red-500/30 bg-red-500/10 px-4 py-3 text-sm text-red-200">
            {errMsg}
          </div>
        )}
        {okMsg && (
          <div className="mt-4 rounded-xl border border-emerald-500/30 bg-emerald-500/10 px-4 py-3 text-sm text-emerald-200">
            {okMsg}
          </div>
        )}

        <div className="mt-6 rounded-2xl border border-white/10 bg-white/[0.03] p-4 shadow-2xl">
          {/* 運転者 */}
          <div className="mb-4">
            <label className="mb-2 block text-sm text-white/70">運転者</label>
            <select
              className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-base outline-none ring-0"
              value={driverName}
              onChange={(e) => setDriverName(e.target.value)}
            >
              {DRIVER_NAMES.map((n) => (
                <option key={n} value={n} className="bg-black">
                  {n}
                </option>
              ))}
            </select>
          </div>

          {/* モード */}
          <div className="mb-5 grid grid-cols-2 gap-2">
            <button
              type="button"
              onClick={() => setMode("route")}
              className={`rounded-2xl px-4 py-3 text-base transition ${mode === "route"
                ? "bg-blue-900/80 text-white"
                : "bg-white/5 text-white/85 hover:bg-white/10"
                }`}
            >
              通常ルート
            </button>
            <button
              type="button"
              onClick={() => setMode("bus")}
              className={`rounded-2xl px-4 py-3 text-base transition ${mode === "bus"
                ? "bg-blue-900/80 text-white"
                : "bg-white/5 text-white/85 hover:bg-white/10"
                }`}
            >
              バス（固定）
            </button>
          </div>

          <div className="grid grid-cols-1 gap-4">
            {/* 出発地 */}
            <div>
              <label className="mb-2 block text-sm text-white/70">出発地</label>
              <select
                className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-base"
                value={fromId ?? ""}
                onChange={(e) => setFromId(e.target.value ? Number(e.target.value) : null)}
              >
                <option value="" className="bg-black">選択</option>
                {locations.map((l) => (
                  <option key={l.id} value={l.id} className="bg-black">
                    {l.name}
                  </option>
                ))}
              </select>
            </div>

            {/* 到着数 */}
            <div>
              <label className="mb-2 block text-sm text-white/70">到着数</label>
              <div className="flex flex-wrap items-center gap-2">
                <button
                  type="button"
                  onClick={addArrival}
                  disabled={arrivalCount >= MAX_ARRIVALS}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm disabled:opacity-40"
                >
                  ＋ 到着を追加
                </button>
                <button
                  type="button"
                  onClick={removeLastArrival}
                  disabled={arrivalCount <= 1}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm disabled:opacity-40"
                >
                  − 最後の到着を削除
                </button>
                <span className="text-sm text-white/50">最大{MAX_ARRIVALS}個</span>
              </div>
            </div>

            {/* ルート */}
            <div>
              <label className="mb-2 block text-sm text-white/70">ルート</label>
              <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-base">
                {routeNames || "—"}
              </div>
            </div>

            {/* 金額 */}
            <div>
              <label className="mb-2 block text-sm text-white/70">金額</label>
              <div
                className={`rounded-xl border px-4 py-3 text-base ${totalAmountYen == null
                  ? "border-yellow-400/20 bg-yellow-400/5 text-yellow-200"
                  : "border-white/10 bg-black/40 text-white"
                  }`}
              >
                {totalAmountYen == null
                  ? "—（料金表に無い区間がある/未選択あり）"
                  : `${totalAmountYen.toLocaleString()} 円`}
              </div>
            </div>

            {/* 報告時間 */}
            <div>
              <label className="mb-2 block text-sm text-white/70">報告時間</label>
              <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-base">
                {reportAtDisplay}
              </div>
            </div>

            {/* 距離（始） */}
            <div>
              <label className="mb-2 block text-sm text-white/70">距離（始）</label>
              <input
                inputMode="numeric"
                placeholder="出発ODO（全角OK）"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-base"
                value={departOdoText}
                onChange={(e) => {
                  const raw = e.target.value;
                  setDepartOdoText(raw);
                  setDepartOdoNum(parseNullableInt(raw));
                }}
              />
            </div>

            {/* 写真（出発） */}
            <div>
              <label className="mb-2 block text-sm text-white/70">写真（出発）</label>
              <div className="flex flex-wrap items-center gap-3">
                <input
                  ref={departInputRef}
                  type="file"
                  accept="image/*"
                  capture="environment"
                  className="hidden"
                  onChange={async (e) => {
                    const f = e.target.files?.[0];
                    if (!f) return;
                    await onSelectDepartPhoto(f);
                    // 同じファイル再選択対応
                    e.currentTarget.value = "";
                  }}
                />
                <button
                  type="button"
                  onClick={() => departInputRef.current?.click()}
                  className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm"
                >
                  写真を選ぶ
                </button>
                {departPhotoFile && (
                  <span className="text-sm text-white/70">{departPhotoFile.name}</span>
                )}
              </div>
              {departPhotoPreviewUrl && (
                <img
                  src={departPhotoPreviewUrl}
                  alt="出発写真"
                  className="mt-3 h-36 rounded-xl border border-white/10 object-cover"
                />
              )}
            </div>

            {/* 到着1〜8 */}
            {visibleArrivals.map((a, idx) => {
              const segLabel =
                idx === 0
                  ? "区間距離（表示用）：—（到着1-出発）"
                  : `区間距離（表示用）：${typeof segmentDistances[idx] === "number" ? segmentDistances[idx] : "—"
                  } km（到着${idx + 1}-到着${idx}）`;

              return (
                <div
                  key={idx}
                  className="rounded-2xl border border-white/10 bg-black/20 p-4"
                >
                  <div className="mb-3 text-lg font-semibold">到着{idx + 1}</div>

                  <div className="grid grid-cols-1 gap-4">
                    <div>
                      <label className="mb-2 block text-sm text-white/70">場所</label>
                      <select
                        className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-base"
                        value={a.locationId ?? ""}
                        onChange={(e) =>
                          updateArrival(idx, {
                            locationId: e.target.value ? Number(e.target.value) : null,
                          })
                        }
                      >
                        <option value="" className="bg-black">選択</option>
                        {locations.map((l) => (
                          <option key={l.id} value={l.id} className="bg-black">
                            {l.name}
                          </option>
                        ))}
                      </select>
                    </div>

                    <div>
                      <label className="mb-2 block text-sm text-white/70">
                        距離（到着{idx + 1}）
                      </label>
                      <input
                        inputMode="numeric"
                        placeholder={`到着${idx + 1}ODO（全角OK）`}
                        className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-base"
                        value={a.odoText}
                        onChange={(e) => {
                          const raw = e.target.value;
                          updateArrival(idx, {
                            odoText: raw,
                            odoNum: parseNullableInt(raw),
                          });
                        }}
                      />
                    </div>

                    <div className="text-sm text-white/60">
                      {segLabel}
                    </div>

                    <div>
                      <label className="mb-2 block text-sm text-white/70">
                        写真（到着{idx + 1}）
                      </label>
                      <div className="flex flex-wrap items-center gap-3">
                        <input
                          ref={(el) => {
                            arrivalInputRefs.current[idx] = el;
                          }}
                          type="file"
                          accept="image/*"
                          capture="environment"
                          className="hidden"
                          onChange={async (e) => {
                            const f = e.target.files?.[0];
                            if (!f) return;
                            await onSelectArrivalPhoto(idx, f);
                            e.currentTarget.value = "";
                          }}
                        />
                        <button
                          type="button"
                          onClick={() => arrivalInputRefs.current[idx]?.click()}
                          className="rounded-xl border border-white/10 bg-white/5 px-4 py-2 text-sm"
                        >
                          写真を選ぶ
                        </button>
                        {a.photoFile && (
                          <span className="text-sm text-white/70">{a.photoFile.name}</span>
                        )}
                      </div>
                      {a.photoPreviewUrl && (
                        <img
                          src={a.photoPreviewUrl}
                          alt={`到着${idx + 1}写真`}
                          className="mt-3 h-36 rounded-xl border border-white/10 object-cover"
                        />
                      )}
                    </div>
                  </div>
                </div>
              );
            })}

            {/* 総走行距離 */}
            <div>
              <label className="mb-2 block text-sm text-white/70">総走行距離（km）</label>
              <div className="rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-base">
                {totalDistanceKm == null ? "—" : `${totalDistanceKm} km`}
              </div>
            </div>

            {/* 備考 */}
            <div>
              <label className="mb-2 block text-sm text-white/70">備考</label>
              <input
                placeholder="任意"
                className="w-full rounded-xl border border-white/10 bg-black/40 px-4 py-3 text-base"
                value={note}
                onChange={(e) => setNote(e.target.value)}
              />
            </div>

            {/* 保存 */}
            <div className="sticky bottom-3 z-10 pt-2">
              <button
                type="button"
                disabled={saving || loadingMaster}
                onClick={handleSave}
                className="w-full rounded-2xl bg-blue-900/80 px-5 py-4 text-lg font-semibold text-white shadow-lg disabled:opacity-50"
              >
                {saving ? "保存中..." : "保存"}
              </button>
              <div className="mt-2 text-center text-sm text-white/50">
                写真を選ぶとODOを自動で読み取りします（OCR失敗時は手入力）
              </div>
            </div>
          </div>
        </div>

        {/* debug表示（必要な時だけ true にして使って） */}
        {false && (
          <pre className="mt-6 overflow-auto rounded-xl border border-white/10 bg-white/5 p-3 text-xs text-white/70">
            {JSON.stringify(
              {
                driverName,
                mode,
                fromId,
                arrivalCount,
                arrivals,
                departOdoText,
                departOdoNum,
                totalAmountYen,
                segmentDistances,
                totalDistanceKm,
              },
              null,
              2
            )}
          </pre>
        )}
      </div>
    </main>
  );
}