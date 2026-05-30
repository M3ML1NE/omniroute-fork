/**
 * Simple Postgres migration runner.
 * Reads SQL files from db/migrations/postgres/ in alphabetical order.
 * Tracks applied migrations in the `_migrations` table.
 * Placeholder until Task 22 replaces the full SQLite layer.
 */
import { Client } from "pg";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const MIGRATIONS_DIR = path.join(__dirname, "migrations", "postgres");

async function migrate(): Promise<void> {
  const url = process.env.DATABASE_URL;
  if (!url) {
    throw new Error("DATABASE_URL environment variable required");
  }

  const client = new Client({ connectionString: url });
  await client.connect();

  try {
    // Create migrations tracking table
    await client.query(`
      CREATE TABLE IF NOT EXISTS _migrations (
        id SERIAL PRIMARY KEY,
        filename TEXT NOT NULL UNIQUE,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      )
    `);

    // Get already-applied migrations
    const { rows } = await client.query<{ filename: string }>(
      "SELECT filename FROM _migrations ORDER BY filename",
    );
    const applied = new Set(rows.map((r) => r.filename));

    // Read and apply pending migrations
    const files = fs
      .readdirSync(MIGRATIONS_DIR)
      .filter((f) => f.endsWith(".sql"))
      .sort();

    for (const file of files) {
      if (applied.has(file)) {
        console.log(`  skip: ${file} (already applied)`);
        continue;
      }

      const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), "utf8").trim();
      if (sql) {
        await client.query(sql);
      }
      await client.query("INSERT INTO _migrations (filename) VALUES ($1)", [file]);
      console.log(`  applied: ${file}`);
    }

    console.log("Migrations complete.");
  } finally {
    await client.end();
  }
}

migrate().catch((err) => {
  console.error("Migration failed:", err.message);
  process.exit(1);
});
