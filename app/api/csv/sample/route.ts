import { NextResponse } from 'next/server';
import fs from 'fs';
import path from 'path';

export async function GET() {
  const filePath = '/Users/sasakisora/.gemini/antigravity/playground/polar-opportunity/output/sample_real_jobs.csv';
  
  if (!fs.existsSync(filePath)) {
    return NextResponse.json({ error: 'Sample file not found' }, { status: 404 });
  }

  const fileStream = fs.createReadStream(filePath);
  
  // Create a response with the file stream and proper headers
  const res = new NextResponse(fileStream as any);
  res.headers.set('Content-Type', 'text/csv');
  res.headers.set('Content-Disposition', 'attachment; filename="sample_real_jobs.csv"');
  return res;
}
