import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { SourceSummary } from '@/types/agri-jobs';

export async function GET() {
  try {
    const db = getDb();
    
    const sources = db.prepare(`
      SELECT source, total_fetched as count, total_errors as error 
      FROM execution_history 
      WHERE id IN (
        SELECT MAX(id) FROM execution_history GROUP BY source
      )
    `).all() as SourceSummary[];

    return NextResponse.json({ sources });
  } catch (error) {
    console.error(error);
    return NextResponse.json({ error: 'Failed to fetch source summary' }, { status: 500 });
  }
}
