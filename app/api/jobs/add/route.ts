import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function POST(req: Request) {
  try {
    const data = await req.json();

    // Validate required fields
    if (!data.title || !data.company || !data.location) {
      return NextResponse.json(
        { success: false, error: 'タイトル、会社名、勤務地は必須です。' },
        { status: 400 }
      );
    }

    const db = getDb();

    // Generate a unique duplicate key if not provided
    const sourceParam = data.source || 'Manual_Entry';
    const urlParam = data.source_url || `manual-${Date.now()}`;
    const duplicateKey = `manual-${Buffer.from(urlParam).toString('base64').substring(0, 20)}`;

    const job = {
      duplicate_key: duplicateKey,
      source: sourceParam,
      title: data.title,
      company: data.company,
      location: data.location,
      source_url: urlParam,
      employment_status: data.employment_status || '不明',
      salary_min: Number(data.salary_min) || 0,
      has_dormitory: data.has_dormitory ? 1 : 0,
      welcome_inexperienced: data.welcome_inexperienced ? 1 : 0,
      rule_score: Number(data.rule_score) || 0,
      ai_score: Number(data.ai_score) || 0,
      final_score: Number(data.final_score) || 0,
      judgment: data.judgment || '未判定',
      judgment_reason: data.judgment_reason || '',
      first_seen_at: data.first_seen_at || new Date().toISOString(),
      last_seen_at: data.last_seen_at || new Date().toISOString(),
      is_active: 1
    };

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
        title=excluded.title,
        company=excluded.company,
        location=excluded.location,
        salary_min=excluded.salary_min,
        judgment=excluded.judgment,
        judgment_reason=excluded.judgment_reason,
        is_active=1
    `);

    stmt.run(job);

    return NextResponse.json({ success: true, message: '求人を登録しました', duplicate_key: duplicateKey });
  } catch (error: any) {
    console.error('Failed to manually insert job:', error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
