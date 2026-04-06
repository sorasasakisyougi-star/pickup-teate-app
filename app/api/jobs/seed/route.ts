import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

export async function POST() {
  try {
    const db = getDb();
    
    const sampleJobs = [
      {
        duplicate_key: "seed-indeed-1",
        source: "IndeedScraper",
        title: "【急募】大規模農場でのトラクターオペレーター",
        company: "株式会社 トカチファーム",
        location: "北海道 帯広市",
        source_url: "https://example.com/seed1",
        employment_status: "正社員",
        salary_min: 250000,
        has_dormitory: 1,
        welcome_inexperienced: 0,
        rule_score: 90,
        ai_score: 85,
        final_score: 175,
        judgment: "通過",
        judgment_reason: "必須条件（北海道、寮あり）を満たしています。給与も基準以上です。",
        first_seen_at: new Date().toISOString(),
        last_seen_at: new Date().toISOString(),
        is_active: 1
      },
      {
        duplicate_key: "seed-nougyou-1",
        source: "NougyouJobScraper",
        title: "未経験歓迎！トマトの収穫・選別スタッフ（寮完備）",
        company: "サッポロアグリ 株式会社",
        location: "北海道 札幌市",
        source_url: "https://example.com/seed2",
        employment_status: "アルバイト",
        salary_min: 180000,
        has_dormitory: 1,
        welcome_inexperienced: 1,
        rule_score: 80,
        ai_score: 70,
        final_score: 150,
        judgment: "通過",
        judgment_reason: "未経験歓迎で寮も完備されています。",
        first_seen_at: new Date(Date.now() - 86400000).toISOString(),
        last_seen_at: new Date().toISOString(),
        is_active: 1
      },
      {
        duplicate_key: "seed-agrinavi-1",
        source: "AgriNaviScraper",
        title: "酪農牧場での搾乳および仔牛の世話",
        company: "有限会社 ホクダイ酪農",
        location: "北海道 中標津町",
        source_url: "https://example.com/seed3",
        employment_status: "契約社員",
        salary_min: 200000,
        has_dormitory: 0,
        welcome_inexperienced: 1,
        rule_score: 40,
        ai_score: 50,
        final_score: 90,
        judgment: "保留",
        judgment_reason: "寮設備の記載が取得できませんでした。要確認です。",
        first_seen_at: new Date(Date.now() - 86400000 * 2).toISOString(),
        last_seen_at: new Date().toISOString(),
        is_active: 1
      }
    ];

    const stmt = db.prepare(`
      INSERT INTO jobs_history (
        duplicate_key, source, title, company, location, source_url,
        employment_status, salary_min, has_dormitory, welcome_inexperienced,
        rule_score, ai_score, final_score, judgment, judgment_reason,
        first_seen_at, last_seen_at, is_active
      ) VALUES (
        @duplicate_key, @source, @title, @company, @location, @source_url,
        @employment_status, @salary_min, @has_dormitory, @welcome_inexperienced,
        @rule_score, @ai_score, @final_score, @judgment, @judgment_reason,
        @first_seen_at, @last_seen_at, @is_active
      ) ON CONFLICT(duplicate_key) DO UPDATE SET
        last_seen_at=excluded.last_seen_at,
        is_active=1
    `);

    const insertMany = db.transaction((jobs: any[]) => {
      for (const job of jobs) {
        stmt.run(job);
      }
    });

    insertMany(sampleJobs);

    return NextResponse.json({ success: true, count: sampleJobs.length, message: "サンプルデータを投入しました" });
  } catch (error: any) {
    console.error("Failed to seed dummy data:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
