import { NextRequest, NextResponse } from "next/server";

export const dynamic = "force-dynamic";
export const revalidate = 0;

type VisionAnnotateResponse = {
    responses?: Array<{
        fullTextAnnotation?: { text?: string };
        textAnnotations?: Array<{ description?: string }>;
        error?: { code?: number; message?: string };
    }>;
};

type OcrPassResult = {
    label: string;
    ok: boolean;
    rawText: string;
    normalizedText: string;
    candidates: string[];
    odo: number | null;
    score: number;
    error?: string;
};

function z2hDigits(input: string): string {
    return input.replace(/[０-９]/g, (s) =>
        String.fromCharCode(s.charCodeAt(0) - 0xfee0)
    );
}

function normalizeOcrText(input: string): string {
    return z2hDigits(input)
        .replace(/[ＯＯｏoO]/g, "0")
        .replace(/[ＩIｉiｌl|]/g, "1")
        .replace(/[ＳsＳ]/g, "5")
        .replace(/[Ｂb]/g, "8");
}

function extractAllNumberRuns(text: string): string[] {
    return Array.from(text.matchAll(/\d{3,}/g)).map((m) => m[0]);
}

/**
 * ODO候補のスコアリング
 * - 5〜7桁を強く優先
 * - 末尾寄りの候補を優先（ODOは画面下部・末尾テキストに出やすい）
 * - "odo/km" 近傍は加点（簡易）
 */
function pickBestOdoCandidate(rawText: string): {
    odo: number | null;
    candidates: string[];
    normalizedText: string;
    score: number;
} {
    const normalizedText = normalizeOcrText(rawText);
    const candidates = extractAllNumberRuns(normalizedText);

    if (candidates.length === 0) {
        return { odo: null, candidates, normalizedText, score: 0 };
    }

    const lower = normalizedText.toLowerCase();

    let best: { s: string; score: number; idx: number } | null = null;

    for (const s of candidates) {
        const idx = normalizedText.lastIndexOf(s);
        let score = 0;

        // 桁数評価（ODOを想定）
        if (s.length >= 5 && s.length <= 7) score += 100;
        else if (s.length === 8) score += 40;
        else score += 10;

        // 数値レンジ評価（雑に車ODOを優先）
        const n = Number(s);
        if (Number.isFinite(n)) {
            if (n >= 10000 && n <= 999999) score += 40;
            if (n >= 100000 && n <= 400000) score += 20; // 日本の実車で多い帯を軽く優遇
        }

        // 末尾寄り評価（後ろの数字ほどODO率高め）
        score += Math.floor(idx / 10);

        // "odo" / "km"近傍を加点（簡易）
        const windowStart = Math.max(0, idx - 20);
        const windowEnd = Math.min(lower.length, idx + s.length + 20);
        const near = lower.slice(windowStart, windowEnd);
        if (near.includes("odo")) score += 30;
        if (near.includes("km")) score += 10;

        if (!best || score >= best.score) {
            best = { s, score, idx };
        }
    }

    if (!best) {
        return { odo: null, candidates, normalizedText, score: 0 };
    }

    const odo = Number(best.s);
    if (!Number.isFinite(odo)) {
        return { odo: null, candidates, normalizedText, score: 0 };
    }

    return { odo, candidates, normalizedText, score: best.score };
}

async function callGoogleVision(base64Image: string): Promise<VisionAnnotateResponse> {
    const apiKey = process.env.GOOGLE_CLOUD_VISION_API_KEY;
    if (!apiKey) {
        throw new Error("Google Vision未設定: GOOGLE_CLOUD_VISION_API_KEY がありません");
    }

    const res = await fetch(
        `https://vision.googleapis.com/v1/images:annotate?key=${apiKey}`,
        {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                requests: [
                    {
                        image: { content: base64Image },
                        features: [{ type: "TEXT_DETECTION" }],
                        imageContext: {
                            languageHints: ["ja", "en"],
                        },
                    },
                ],
            }),
        }
    );

    const data = (await res.json().catch(() => ({}))) as VisionAnnotateResponse & {
        error?: { message?: string };
    };

    if (!res.ok) {
        throw new Error(data?.error?.message ?? `Vision API HTTP ${res.status}`);
    }

    return data;
}

async function visionPass(label: string, imgBuf: Buffer): Promise<OcrPassResult> {
    try {
        const base64 = imgBuf.toString("base64");
        const vision = await callGoogleVision(base64);
        const first = vision.responses?.[0];

        if (!first) {
            return {
                label,
                ok: false,
                rawText: "",
                normalizedText: "",
                candidates: [],
                odo: null,
                score: 0,
                error: "Visionレスポンス空",
            };
        }

        if (first.error?.message) {
            return {
                label,
                ok: false,
                rawText: "",
                normalizedText: "",
                candidates: [],
                odo: null,
                score: 0,
                error: first.error.message,
            };
        }

        const rawText =
            first.fullTextAnnotation?.text ||
            first.textAnnotations?.[0]?.description ||
            "";

        const picked = pickBestOdoCandidate(rawText);

        return {
            label,
            ok: true,
            rawText,
            normalizedText: picked.normalizedText,
            candidates: picked.candidates,
            odo: picked.odo,
            score: picked.score,
        };
    } catch (e: any) {
        return {
            label,
            ok: false,
            rawText: "",
            normalizedText: "",
            candidates: [],
            odo: null,
            score: 0,
            error: e?.message ?? "unknown error",
        };
    }
}

export async function POST(req: NextRequest) {
    try {
        const form = await req.formData();
        const file = form.get("file");

        if (!(file instanceof File)) {
            return NextResponse.json(
                { ok: false, error: "file がありません（FormDataの 'file' を送ってください）" },
                { status: 400 }
            );
        }

        if (!file.type.startsWith("image/")) {
            return NextResponse.json(
                { ok: false, error: `画像ファイルではありません: ${file.type}` },
                { status: 400 }
            );
        }

        const src = Buffer.from(await file.arrayBuffer());

        // sharp を動的import（未導入時のエラーも返す）
        let sharp: any;
        try {
            sharp = (await import("sharp")).default;
        } catch {
            return NextResponse.json(
                {
                    ok: false,
                    error:
                        "sharp が未導入です。`npm i sharp` を実行して再起動してください（強力OCR版に必要）",
                },
                { status: 500 }
            );
        }

        const meta = await sharp(src).metadata();
        const width = meta.width ?? 0;
        const height = meta.height ?? 0;

        if (!width || !height) {
            return NextResponse.json(
                { ok: false, error: "画像サイズを取得できませんでした" },
                { status: 400 }
            );
        }

        // === OCRパスを複数作る ===
        const passes: Array<Promise<OcrPassResult>> = [];

        // 1) 元画像そのまま
        passes.push(visionPass("raw", src));

        // 2) 全体を2倍拡大 + シャープ
        const full2x = await sharp(src)
            .rotate() // EXIF回転補正
            .resize({ width: Math.min(width * 2, 2400), withoutEnlargement: false })
            .sharpen()
            .png()
            .toBuffer();
        passes.push(visionPass("full_2x_sharpen", full2x));

        // 3) 全体白黒高コントラスト
        const fullBw = await sharp(src)
            .rotate()
            .resize({ width: Math.min(width * 2, 2400), withoutEnlargement: false })
            .grayscale()
            .normalise()
            .sharpen()
            .png()
            .toBuffer();
        passes.push(visionPass("full_bw_normalize", fullBw));

        // 4) 下部帯をクロップ（ODOが下にある想定）
        const cropY = Math.floor(height * 0.50);
        const cropH = height - cropY;
        const bottomBand = await sharp(src)
            .rotate()
            .extract({
                left: 0,
                top: Math.max(0, cropY),
                width,
                height: Math.max(1, cropH),
            })
            .resize({ width: Math.min(width * 3, 2600), withoutEnlargement: false })
            .grayscale()
            .normalise()
            .sharpen()
            .png()
            .toBuffer();
        passes.push(visionPass("bottom_band_3x_bw", bottomBand));

        // 5) 中央下寄り（メーターパネル中央付近）をクロップ
        const panelLeft = Math.floor(width * 0.18);
        const panelTop = Math.floor(height * 0.35);
        const panelWidth = Math.floor(width * 0.64);
        const panelHeight = Math.floor(height * 0.55);

        const centerPanel = await sharp(src)
            .rotate()
            .extract({
                left: Math.max(0, panelLeft),
                top: Math.max(0, panelTop),
                width: Math.max(1, Math.min(panelWidth, width - panelLeft)),
                height: Math.max(1, Math.min(panelHeight, height - panelTop)),
            })
            .resize({ width: 2200, withoutEnlargement: false })
            .grayscale()
            .normalise()
            .sharpen()
            .png()
            .toBuffer();
        passes.push(visionPass("center_panel_ocr", centerPanel));

        const results = await Promise.all(passes);

        // 成功パスから、ODO候補あり＆スコア最大を採用
        const ranked = results
            .filter((r) => r.ok)
            .sort((a, b) => (b.odo != null ? 1 : 0) - (a.odo != null ? 1 : 0) || b.score - a.score);

        const best = ranked.find((r) => r.odo != null) ?? ranked[0] ?? null;

        if (!best || best.odo == null) {
            return NextResponse.json(
                {
                    ok: false,
                    error: "ODOを読み取れませんでした（強力OCRでも候補なし）",
                    debug: {
                        file: { name: file.name, type: file.type, size: file.size, width, height },
                        passes: results,
                    },
                },
                { status: 422 }
            );
        }

        return NextResponse.json({
            ok: true,
            odo: best.odo,
            value: best.odo,
            text: String(best.odo),
            debug: {
                selectedPass: best.label,
                selectedScore: best.score,
                file: { name: file.name, type: file.type, size: file.size, width, height },
                passes: results.map((r) => ({
                    label: r.label,
                    ok: r.ok,
                    odo: r.odo,
                    score: r.score,
                    candidates: r.candidates,
                    error: r.error,
                    rawTextPreview: r.rawText?.slice(0, 200) ?? "",
                })),
            },
        });
    } catch (e: any) {
        console.error("[/api/ocr] strong error:", e);
        return NextResponse.json(
            { ok: false, error: e?.message ?? "unknown error" },
            { status: 500 }
        );
    }
}