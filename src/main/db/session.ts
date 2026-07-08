import Database from 'better-sqlite3';
import { join } from 'path';
import { mkdirSync, existsSync } from 'fs';
import { app } from 'electron';

let db: ReturnType<typeof Database> | null = null;
let currentSessionId: string | null = null;

/**
 * Initializes a session-scoped SQLite database.
 * 
 * JSDoc: Security Note
 * The database file is stored in a 'sessions' directory within the app's userData folder.
 * Using userData ensures we do not violate OS-level user file access permissions when 
 * the app is installed. It also prevents cross-session leakage by isolating DB files.
 */
export function initSessionDb(sessionId: string) {
  try {
    const userDataPath = app.getPath('userData');
    const sessionsDir = join(userDataPath, 'sessions');
    
    if (!existsSync(sessionsDir)) {
      mkdirSync(sessionsDir, { recursive: true });
    }

    const dbPath = join(sessionsDir, `${sessionId}.sqlite`);
    db = new Database(dbPath);
    currentSessionId = sessionId;

    console.log(`[DB] Session DB initialized at ${dbPath}`);
    
    // Scaffold initial tables
    db.exec(`
      CREATE TABLE IF NOT EXISTS insights (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        timestamp DATETIME DEFAULT CURRENT_TIMESTAMP,
        content TEXT NOT NULL
      )
    `);

    return true;
  } catch (error) {
    console.error('[DB Error] Failed to init session DB:', error);
    return false;
  }
}

export function closeSessionDb() {
  if (db) {
    db.close();
    console.log(`[DB] Closed session DB ${currentSessionId}`);
    db = null;
    currentSessionId = null;
  }
}

export function getDb() {
  if (!db) throw new Error('Database not initialized');
  return db;
}
