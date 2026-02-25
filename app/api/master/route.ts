import { NextResponse } from "next/server";
import { supabase } from "@/lib/supabaseClient";

export const dynamic = "force-dynamic";

export async function GET() {
    try {
        // ここはあなたのDBに合わせる
        // locations: id, name, kind?
        // fares: id, from_id, to_id, yen
        // drivers: もしテーブル無ければ固定配列にする

        // drivers（テーブル無いなら固定）
        let drivers: string[] = ["ディカ", "テスト"];

        // locations
        const { data: locations, error: locErr } = await supabase
            .from("locations")
            .select("id,name,kind")
            .order("id", { ascending: true });

        if (locErr) throw new Error(`locations: ${locErr.message}`);

        // fares
        const { data: fares, error: fareErr } = await supabase
            .from("fares")
            .select("id,from_id,to_id,yen")
            .order("id", { ascending: true });

        if (fareErr) throw new Error(`fares: ${fareErr.message}`);

        return NextResponse.json({
            drivers,
            locations: locations ?? [],
            fares: fares ?? [],
        });
    } catch (e: any) {
        return NextResponse.json(
            { ok: false, error: e?.message ?? String(e) },
            { status: 500 }
        );
    }
}