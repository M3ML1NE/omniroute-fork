import { getDbInstance } from "./core";

export interface DatabaseStats {
  totalSize: number;
  pageSize: number;
  pageCount: number;
  tables: Array<{
    name: string;
    rowCount: number;
    size: number;
  }>;
  indexes: Array<{
    name: string;
    tableName: string;
  }>;
  walSize?: number;
  cacheSize: number;
}

export async function getDatabaseStats(): Promise<DatabaseStats> {
  const db = getDbInstance();

  const tables = (await db
    .prepare(
      `SELECT table_name AS name
       FROM information_schema.tables
       WHERE table_schema = 'public'
         AND table_type = 'BASE TABLE'
       ORDER BY table_name`
    )
    .all()) as Array<{ name: string }>;

  const tableStats = await Promise.all(
    tables.map(async (table) => {
      let rowCount = 0;
      let size = 0;
      try {
        const countRow = (await db
          .prepare(`SELECT COUNT(*) AS count FROM "${table.name}"`)
          .get()) as { count: number | string } | undefined;
        rowCount = Number(countRow?.count ?? 0);
      } catch {
        rowCount = 0;
      }
      try {
        const sizeRow = (await db
          .prepare(`SELECT pg_total_relation_size($1) AS size`)
          .get(table.name)) as { size: number | string | null } | undefined;
        size = Number(sizeRow?.size ?? 0);
      } catch {
        size = 0;
      }
      return { name: table.name, rowCount, size };
    })
  );

  const indexes = (await db
    .prepare(
      `SELECT indexname AS name, tablename AS "tableName"
       FROM pg_indexes
       WHERE schemaname = 'public'
       ORDER BY indexname`
    )
    .all()) as Array<{ name: string; tableName: string }>;

  let totalSize = 0;
  try {
    const sizeRow = (await db
      .prepare(`SELECT pg_database_size(current_database()) AS size`)
      .get()) as { size: number | string | null } | undefined;
    totalSize = Number(sizeRow?.size ?? 0);
  } catch {
    totalSize = 0;
  }

  return {
    totalSize,
    pageSize: 8192,
    pageCount: Math.ceil(totalSize / 8192),
    tables: tableStats,
    indexes,
    cacheSize: 0,
  };
}

