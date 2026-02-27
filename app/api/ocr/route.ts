import { NextResponse } from "next/server";
import Tesseract from "tesseract.js";
import sharp from "sharp";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const revalidate = 0;

function z2hDigits(input: string): string {
    return input.replace(/[０-９]/g, (s) =>
        String.fromCharCode(s.charCodeAt(0) - 0xfee0)
    );
}

function normalizeOcrText(text: string): string {
    return z2hDigits(text)
        .replace(/[ＯｏOo]/g, "0")
        .replace(/[ＩｉIiｌl｜|]/g, "1")
        .replace(/[Ｓs]/g, "5")
        .replace(/[Ｂb]/g, "8")
        .replace(/[^\S\r\n]+/g, " ");
}

function clamp(n: number, min: number, max: number) {
    return Math.max(min, Math.min(max, n));
}

type CandidateHit = {
    value: number;
    raw: string;
    score: number;
    sourceTextIndex: number;
};

function collectCandidatesFromText(text: string, sourceTextIndex: number): CandidateHit[] {
    const hits: CandidateHit[] = [];
    const t = normalizeOcrText(text);
    const lower = t.toLowerCase();

    const add = (raw: string, baseScore: number, pos: number) => {
        const n = Number(raw);
        if (!Number.isFinite(n)) return;
        if (n < 10000 || n > 9999999) return; // ODO想定レンジ

        let score = baseScore;

        // 桁数優先（ODOは5〜7桁が多い）
        if (raw.length >= 5 && raw.length <= 7) score += 120;
        else if (raw.length === 8) score += 40;
        else score += 5;

        // よくあるODO帯
        if (n >= 50000 && n <= 500000) score += 35;
        else if (n >= 10000 && n <= 999999) score += 20;

        // 文字列後半寄り優遇
        score += Math.floor(pos / 8);

        // "odo"/"km" 近傍加点
        const s = clamp(pos - 24, 0, lower.length);
        const e = clamp(pos + raw.length + 24, 0, lower.length);
        const near = lower.slice(s, e);
        if (near.includes("odo")) score += 40;
        if (near.includes("km")) score += 12;

        hits.push({ value: n, raw, score, sourceTextIndex });
    };

    // 素直な数字塊（4〜8桁）
    for (const m of t.matchAll(/\d{4,8}/g)) {
        add(m[0], 30, m.index ?? 0);
    }

    // odo近傍
    for (const m of t.matchAll(/odo[^\d]{0,8}(\d{4,8})/gi)) {
        add(m[1], 80, m.index ?? 0);
    }

    // km近傍
    for (const m of t.matchAll(/(\d{4,8})\s*km/gi)) {
        add(m[1], 50, m.index ?? 0);
    }

    // ノイズ分断対策：数字だけ連結して窓切り
    const digits = t.replace(/[^\d]/g, "");
    for (let len = 5; len <= 7; len++) {
        for (let i = 0; i + len <= digits.length; i++) {
            add(digits.slice(i, i + len), 5, i);
        }
    }

    return hits;
}

function pickBestOdo(texts: string[]) {
    const allHits = texts.flatMap((t, i) => collectCandidatesFromText(t, i));

    if (allHits.length === 0) {
        return {
            odo: null as number | null,
            ranked: [] as Array<{ value: number; count: number; score: number }>,
            hitCount: 0,
        };
    }

    const map = new Map<number, { count: number; bestScore: number }>();
    for (const h of allHits) {
        const prev = map.get(h.value);
        if (!prev) {
            map.set(h.value, { count: 1, bestScore: h.score });
        } else {
            prev.count += 1;
            if (h.score > prev.bestScore) prev.bestScore = h.score;
        }
    }

    const ranked = [...map.entries()]
        .map(([value, info]) => ({
            value,
            count: info.count,
            score: info.bestScore + info.count * 20,
        }))
        .sort((a, b) => {
            if (b.score !== a.score) return b.score - a.score;
            if (b.count !== a.count) return b.count - a.count;
            return b.value - a.value;
        });

    return {
        odo: ranked[0]?.value ?? null,
        ranked,
        hitCount: allHits.length,
    };
}

async function runOcr(buf: Buffer, psm: number): Promise<string> {
    const result = await Tesseract.recognize(buf, "eng", {
        logger: () => { },
        tessedit_pageseg_mode: String(psm),
        tessedit_char_whitelist: "0123456789kmKMODOodo. :-/",
        preserve_interword_spaces: "1",
    } as any);

    return result?.data?.text ?? "";
}

async function safeExtract(
    input: Buffer,
    rect: { left: number; top: number; width: number; height: number }
): Promise<Buffer | null> {
    const meta = await sharp(input).rotate().metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;
    if (!W || !H) return null;

    const left = clamp(Math.floor(rect.left), 0, Math.max(0, W - 1));
    const top = clamp(Math.floor(rect.top), 0, Math.max(0, H - 1));
    const width = clamp(Math.floor(rect.width), 1, W - left);
    const height = clamp(Math.floor(rect.height), 1, H - top);

    if (width <= 0 || height <= 0) return null;

    try {
        return await sharp(input)
            .rotate()
            .extract({ left, top, width, height })
            .toBuffer();
    } catch {
        return null;
    }
}

async function buildVariants(input: Buffer): Promise<Array<{ label: string; buf: Buffer }>> {
    const base = sharp(input).rotate();
    const meta = await base.metadata();
    const W = meta.width ?? 0;
    const H = meta.height ?? 0;

    const variants: Array<{ label: string; buf: Buffer }> = [];

    // ===== 全体画像 =====
    variants.push({
        label: "full_gray_norm_1400",
        buf: await base.clone().resize({ width: 1400 }).grayscale().normalise().sharpen().toBuffer(),
    });

    variants.push({
        label: "full_thresh_160_1800",
        buf: await base.clone().resize({ width: 1800 }).grayscale().normalise().threshold(160).sharpen().toBuffer(),
    });

    variants.push({
        label: "full_thresh_190_1800",
        buf: await base.clone().resize({ width: 1800 }).grayscale().normalise().threshold(190).sharpen().toBuffer(),
    });

    variants.push({
        label: "full_invert_thresh_160_1800",
        buf: await base
            .clone()
            .resize({ width: 1800 })
            .grayscale()
            .normalise()
            .negate()
            .threshold(160)
            .sharpen()
            .toBuffer(),
    });

    if (W && H) {
        // ===== 下半分 =====
        const bottom = await safeExtract(input, {
            left: 0,
            top: H * 0.45,
            width: W,
            height: H * 0.55,
        });

        if (bottom) {
            variants.push({
                label: "bottom_bw_2400",
                buf: await sharp(bottom).resize({ width: 2400 }).grayscale().normalise().sharpen().toBuffer(),
            });
            variants.push({
                label: "bottom_thresh_170_2600",
                buf: await sharp(bottom).resize({ width: 2600 }).grayscale().normalise().threshold(170).sharpen().toBuffer(),
            });
            variants.push({
                label: "bottom_invert_thresh_150_2600",
                buf: await sharp(bottom)
                    .resize({ width: 2600 })
                    .grayscale()
                    .normalise()
                    .negate()
                    .threshold(150)
                    .sharpen()
                    .toBuffer(),
            });
        }

        // ===== 中央下（液晶パネル全体）=====
        const panel = await safeExtract(input, {
            left: W * 0.18,
            top: H * 0.34,
            width: W * 0.64,
            height: H * 0.52,
        });

        if (panel) {
            variants.push({
                label: "panel_bw_2600",
                buf: await sharp(panel).resize({ width: 2600 }).grayscale().normalise().sharpen().toBuffer(),
            });
            variants.push({
                label: "panel_thresh_165_2800",
                buf: await sharp(panel).resize({ width: 2800 }).grayscale().normalise().threshold(165).sharpen().toBuffer(),
            });
            variants.push({
                label: "panel_invert_thresh_165_2800",
                buf: await sharp(panel)
                    .resize({ width: 2800 })
                    .grayscale()
                    .normalise()
                    .negate()
                    .threshold(165)
                    .sharpen()
                    .toBuffer(),
            });
        }

        // ===== ODO細帯① =====
        const odoBand1 = await safeExtract(input, {
            left: W * 0.25,
            top: H * 0.60,
            width: W * 0.50,
            height: H * 0.14,
        });

        if (odoBand1) {
            variants.push({
                label: "odo_band1_bw_3200",
                buf: await sharp(odoBand1).resize({ width: 3200 }).grayscale().normalise().sharpen().toBuffer(),
            });
            variants.push({
                label: "odo_band1_thresh_140_3400",
                buf: await sharp(odoBand1).resize({ width: 3400 }).grayscale().normalise().threshold(140).sharpen().toBuffer(),
            });
            variants.push({
                label: "odo_band1_thresh_190_3400",
                buf: await sharp(odoBand1).resize({ width: 3400 }).grayscale().normalise().threshold(190).sharpen().toBuffer(),
            });
            variants.push({
                label: "odo_band1_invert_160_3400",
                buf: await sharp(odoBand1)
                    .resize({ width: 3400 })
                    .grayscale()
                    .normalise()
                    .negate()
                    .threshold(160)
                    .sharpen()
                    .toBuffer(),
            });
        }

        // ===== ODO細帯②（少し下）=====
        const odoBand2 = await safeExtract(input, {
            left: W * 0.22,
            top: H * 0.64,
            width: W * 0.56,
            height: H * 0.12,
        });

        if (odoBand2) {
            variants.push({
                label: "odo_band2_bw_3400",
                buf: await sharp(odoBand2).resize({ width: 3400 }).grayscale().normalise().sharpen().toBuffer(),
            });
            variants.push({
                label: "odo_band2_thresh_155_3600",
                buf: await sharp(odoBand2).resize({ width: 3600 }).grayscale().normalise().threshold(155).sharpen().toBuffer(),
            });
            variants.push({
                label: "odo_band2_invert_155_3600",
                buf: await sharp(odoBand2)
                    .resize({ width: 3600 })
                    .grayscale()
                    .normalise()
                    .negate()
                    .threshold(155)
                    .sharpen()
                    .toBuffer(),
            });
        }
    }

    return variants;
}

export async function POST(req: Request) {
    console.log("[OCR] ===== request start =====");

    try {
        const form = await req.formData();
        const file = form.get("file");

        if (!(file instanceof File)) {
            console.log("[OCR] file missing");
            return NextResponse.json({ ok: false, error: "file がありません" }, { status: 400 });
        }

        console.log("[OCR] file:", {
            name: file.name,
            type: file.type,
            size: file.size,
        });

        const original = Buffer.from(await file.arrayBuffer());

        const meta = await sharp(original).rotate().metadata();
        const width = meta.width ?? null;
        const height = meta.height ?? null;

        console.log("[OCR] image meta:", { width, height });

        const variants = await buildVariants(original);
        console.log("[OCR] variants count:", variants.length);
        console.log("[OCR] variants:", variants.map((v) => v.label));

        const psms = [6, 7, 8, 11, 12, 13];
        const texts: string[] = [];

        const passLogs: Array<{
            label: string;
            psm: number;
            textPreview: string;
            candidates: number[];
            error?: string;
        }> = [];

        for (const v of variants) {
            for (const psm of psms) {
                try {
                    const text = (await runOcr(v.buf, psm)).trim();
                    if (text) texts.push(text);

                    const candidates = collectCandidatesFromText(text, 0)
                        .map((c) => c.value)
                        .slice(0, 20);

                    console.log("[OCR][PASS]", {
                        label: v.label,
                        psm,
                        candidates,
                        textPreview: text.slice(0, 120),
                    });

                    passLogs.push({
                        label: v.label,
                        psm,
                        textPreview: text.slice(0, 180),
                        candidates,
                    });
                } catch (e: any) {
                    console.log("[OCR][PASS][ERROR]", {
                        label: v.label,
                        psm,
                        error: e?.message ?? "ocr failed",
                    });

                    passLogs.push({
                        label: v.label,
                        psm,
                        textPreview: "",
                        candidates: [],
                        error: e?.message ?? "ocr failed",
                    });
                }
            }
        }

        // 元画像も1回
        try {
            const raw = (await runOcr(original, 6)).trim();
            if (raw) texts.push(raw);

            const candidates = collectCandidatesFromText(raw, 0)
                .map((c) => c.value)
                .slice(0, 20);

            console.log("[OCR][PASS]", {
                label: "original_raw",
                psm: 6,
                candidates,
                textPreview: raw.slice(0, 120),
            });

            passLogs.push({
                label: "original_raw",
                psm: 6,
                textPreview: raw.slice(0, 180),
                candidates,
            });
        } catch (e: any) {
            console.log("[OCR][PASS][ERROR]", {
                label: "original_raw",
                psm: 6,
                error: e?.message ?? "ocr failed",
            });

            passLogs.push({
                label: "original_raw",
                psm: 6,
                textPreview: "",
                candidates: [],
                error: e?.message ?? "ocr failed",
            });
        }

        const picked = pickBestOdo(texts);

        console.log("[OCR] textCount:", texts.length);
        console.log("[OCR] hitCount:", picked.hitCount);
        console.log("[OCR] ranked:", picked.ranked);
        console.log("[OCR] selected odo:", picked.odo);
        console.log("[OCR] ===== request end =====");

        if (picked.odo == null) {
            return NextResponse.json(
                {
                    ok: false,
                    error: "ODO候補を抽出できませんでした",
                    odo: null,
                    value: null,
                    text: texts.join("\n---\n"),
                    textCount: texts.length,
                    debug: {
                        file: {
                            name: file.name,
                            type: file.type,
                            size: file.size,
                            width,
                            height,
                        },
                        variants: variants.map((v) => v.label),
                        passes: passLogs,
                        ranked: picked.ranked,
                    },
                },
                { status: 422 }
            );
        }

        return NextResponse.json({
            ok: true,
            odo: picked.odo,
            value: picked.odo,
            text: String(picked.odo),
            textCount: texts.length,
            debug: {
                file: {
                    name: file.name,
                    type: file.type,
                    size: file.size,
                    width,
                    height,
                },
                variants: variants.map((v) => v.label),
                passes: passLogs,
                ranked: picked.ranked,
            },
        });
    } catch (e: any) {
        console.error("[OCR] FATAL ERROR:", e);
        console.log("[OCR] ===== request end (error) =====");
        return NextResponse.json(
            {
                ok: false,
                error: e?.message ?? "OCR failed",
            },
            { status: 500 }
        );
    }
}