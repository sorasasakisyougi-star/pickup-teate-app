import Database from 'better-sqlite3';

const DB_PATH = '/Users/sasakisora/.gemini/antigravity/playground/polar-opportunity/data/jobs.db';

export function getDb() {
  return new Database(DB_PATH);
}
