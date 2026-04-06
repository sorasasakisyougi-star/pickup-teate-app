import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { JobListing } from '@/types/agri-jobs';

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const keyword = searchParams.get('keyword') || '';
  const judgment = searchParams.get('judgment') || 'all';
  const source = searchParams.get('source') || 'all';
  const hasDormitory = searchParams.get('has_dormitory') === 'true';
  const welcomeInexperienced = searchParams.get('welcome_inexperienced') === 'true';
  const isNew = searchParams.get('is_new') === 'true';

  try {
    const db = getDb();
    
    let query = `SELECT * FROM jobs_history WHERE is_active = 1`;
    const params: any[] = [];

    if (judgment !== 'all') {
      query += ` AND judgment = ?`;
      params.push(judgment);
    }
    
    if (source !== 'all') {
      query += ` AND source = ?`;
      params.push(source);
    }

    if (hasDormitory) {
      query += ` AND has_dormitory = 1`;
    }

    if (welcomeInexperienced) {
      query += ` AND welcome_inexperienced = 1`;
    }

    if (keyword) {
      query += ` AND (title LIKE ? OR company LIKE ? OR location LIKE ?)`;
      params.push(`%${keyword}%`, `%${keyword}%`, `%${keyword}%`);
    }

    query += ` ORDER BY final_score DESC, first_seen_at DESC`;

    const rows = db.prepare(query).all(...params) as any[];
    
    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    const jobs: JobListing[] = [];
    
    for (const row of rows) {
        let jobIsNew = false;
        if (row.first_seen_at) {
            const firstSeen = new Date(row.first_seen_at).getTime();
            jobIsNew = (now - firstSeen) < ONE_DAY_MS;
        } else if (row.first_seen_at === row.last_seen_at) {
            jobIsNew = true;
        }

        if (isNew && !jobIsNew) continue;
        
        row.is_new = jobIsNew;
        // Convert to boolean for exact match
        row.has_dormitory = Boolean(row.has_dormitory);
        row.welcome_inexperienced = Boolean(row.welcome_inexperienced);

        jobs.push(row as JobListing);
    }

    return NextResponse.json({ jobs });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to fetch jobs' }, { status: 500 });
  }
}
