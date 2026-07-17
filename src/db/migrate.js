import pool from './index.js'
import { fileURLToPath } from 'node:url'

export async function migrate(closePool = false) {
  const create = `
  CREATE TABLE IF NOT EXISTS journals (
    id SERIAL PRIMARY KEY,
    user_id TEXT NOT NULL,
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    content TEXT,
    summary TEXT,
    tags TEXT[],
    source TEXT
  );
  `

  try {
    await pool.query(create)
    console.log('Migration completed: journals table is ready')
  } catch (err) {
    console.error('Migration failed:', err)
    process.exit(1)
  } finally {
    if (closePool) {
      await pool.end()
    }
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  migrate(true)
}
