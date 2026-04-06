import { NextResponse } from "next/server";
import { getDb } from "@/lib/db";

// Simple CSV Parser for Node.js
function parseCSV(text: string): string[][] {
  const rows: string[][] = [];
  let currentRow: string[] = [];
  let currentValue = '';
  let insideQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];
    
    if (char === '"') {
      if (insideQuotes && text[i + 1] === '"') {
        currentValue += '"'; // Escaped quote
        i++;
      } else {
        insideQuotes = !insideQuotes;
      }
    } else if (char === ',' && !insideQuotes) {
      currentRow.push(currentValue);
      currentValue = '';
    } else if ((char === '\n' || char === '\r') && !insideQuotes) {
      if (char === '\r' && text[i + 1] === '\n') i++; // Handle \r\n
      currentRow.push(currentValue);
      rows.push(currentRow);
      currentRow = [];
      currentValue = '';
    } else {
      currentValue += char;
    }
  }
  
  // Push the last remaining value and row if they exist
  if (currentValue || currentRow.length > 0) {
    currentRow.push(currentValue);
    rows.push(currentRow);
  }
  
  return rows.filter(row => row.length > 1 || row[0] !== ''); // Filter out empty rows
}

export async function POST(req: Request) {
  try {
    const content = await req.text();
    if (!content) {
      return NextResponse.json({ success: false, error: "No CSV content provided" }, { status: 400 });
    }

    const rows = parseCSV(content);
    if (rows.length < 2) {
      return NextResponse.json({ success: false, error: "CSV does not contain any data rows" }, { status: 400 });
    }

    const header = rows[0].map(h => h.trim());
    const dataRows = rows.slice(1);
    
    const db = getDb();
    const stmt = db.prepare(`
      INSERT INTO jobs_history (
        duplicate_key, source, title, company, location, source_url,
        employment_status, salary_min, has_dormitory, welcome_inexperienced,
        rule_score, ai_score, final_score, judgment, judgment_reason, ai_tags,
        first_seen_at, last_seen_at, is_active
      ) VALUES (
        @duplicate_key, @source, @title, @company, @location, @source_url,
        @employment_status, @salary_min, @has_dormitory, @welcome_inexperienced,
        @rule_score, @ai_score, @final_score, @judgment, @judgment_reason, @ai_tags,
        @first_seen_at, @last_seen_at, @is_active
      ) ON CONFLICT(duplicate_key) DO UPDATE SET
        last_seen_at=excluded.last_seen_at,
        is_active=1
    `);

    let successCount = 0;
    let skippedCount = 0;
    let errors: string[] = [];

    const insertMany = db.transaction((parsedJobs: any[]) => {
      for (const job of parsedJobs) {
        try {
          stmt.run(job);
          successCount++;
        } catch (e: any) {
          skippedCount++;
          errors.push(`Row failed: ${e.message}`);
        }
      }
    });

    const parsedJobs = [];
    
    for (let i = 0; i < dataRows.length; i++) {
        const row = dataRows[i];
        
        // Helper to get value by column name safely
        const getVal = (colName: string): string => {
            const idx = header.indexOf(colName);
            return idx !== -1 && idx < row.length ? row[idx].trim() : "";
        };

        const title = getVal("title");
        if (!title) {
            skippedCount++;
            errors.push(`Row ${i+1}: Missing title. Skipped.`);
            continue;
        }

        const sourceParam = getVal("source_site") || "CSV_Import";
        let urlParam = getVal("source_url");
        if (!urlParam) urlParam = "";
        
        let dupKey = "";
        const genericUrls = ["https://jp.indeed.com/", "https://jp.indeed.com", ""];
        if (genericUrls.includes(urlParam.trim())) {
            const combinedStr = `${title}|${getVal("company_name")}|${getVal("location")}`;
            dupKey = `csv-hash-${Buffer.from(combinedStr).toString('hex').substring(0, 40)}`;
        } else {
            dupKey = `csv-url-${Buffer.from(urlParam).toString('base64').substring(0, 40)}`;
        }
        
        parsedJobs.push({
            duplicate_key: dupKey,
            source: sourceParam,
            title: title,
            company: getVal("company_name") || "不明な企業",
            location: getVal("location") || "不明な地域",
            source_url: urlParam,
            employment_status: getVal("employment_status") || "不明",
            salary_min: parseInt(getVal("salary")) || 0,
            has_dormitory: getVal("has_dormitory") === "1" || getVal("has_dormitory").toLowerCase() === "true" ? 1 : 0,
            welcome_inexperienced: getVal("welcome_inexperienced") === "1" || getVal("welcome_inexperienced").toLowerCase() === "true" ? 1 : 0,
            rule_score: parseInt(getVal("rule_score")) || 0,
            ai_score: parseInt(getVal("ai_score")) || 0,
            final_score: parseInt(getVal("final_score")) || 0,
            judgment: getVal("judgment") || "未判定",
            judgment_reason: getVal("summary") || "",
            ai_tags: null,
            first_seen_at: getVal("fetched_at") || new Date().toISOString(),
            last_seen_at: getVal("fetched_at") || new Date().toISOString(),
            is_active: 1
        });
    }

    insertMany(parsedJobs);

    return NextResponse.json({ 
        success: true, 
        total: dataRows.length, 
        success_count: successCount, 
        skipped_count: skippedCount, 
        reasons: errors.slice(0, 10) // Only send first 10 errors to avoid huge payloads
    });
  } catch (error: any) {
    console.error("Failed to import CSV:", error);
    return NextResponse.json({ success: false, error: error.message }, { status: 500 });
  }
}
