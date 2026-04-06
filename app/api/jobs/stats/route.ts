import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';

export async function GET() {
  try {
    const db = getDb();
    const rows = db.prepare(`SELECT judgment, first_seen_at, last_seen_at FROM jobs_history WHERE is_active = 1`).all() as any[];
    
    let total = 0;
    let passed = 0;
    let held = 0;
    let excluded = 0;
    let new_jobs = 0;

    const ONE_DAY_MS = 24 * 60 * 60 * 1000;
    const now = Date.now();

    for (const row of rows) {
      total++;
      if (row.judgment === '通過') passed++;
      else if (row.judgment === '保留') held++;
      else if (row.judgment === '除外') excluded++;

      if (row.first_seen_at) {
        if (now - new Date(row.first_seen_at).getTime() < ONE_DAY_MS) {
            new_jobs++;
        }
      } else if (row.first_seen_at === row.last_seen_at) {
          new_jobs++;
      }
    }

    return NextResponse.json({ total, passed, held, excluded, new_jobs });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to fetch stats' }, { status: 500 });
  }
}
