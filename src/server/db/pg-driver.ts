import pg from 'pg';
import type { Client, Db, Row } from './index.ts';

// Datas seguem como texto para não sofrerem mudança de fuso; centavos são integer.
const asText = (value: string) => value;
pg.types.setTypeParser(1082, asText); // date
pg.types.setTypeParser(1114, asText); // timestamp
pg.types.setTypeParser(1184, asText); // timestamptz

export function createPgDb(url: string): Db {
  const local = /@(localhost|127\.0\.0\.1)[:/]/.test(url);
  const pool = new pg.Pool({
    connectionString: url,
    max: Number(process.env.DB_POOL_MAX ?? 5),
    ssl: local ? undefined : { ca: process.env.DB_SSL_CA?.replace(/\\n/g, '\n'), rejectUnauthorized: process.env.DB_SSL_NO_VERIFY !== '1' },
  });

  const wrap = (conn: pg.PoolClient): Client => ({
    query: async <T extends Row>(sql: string, params: unknown[] = []) =>
      (await conn.query(sql, params.map(toParam) as any[])).rows as T[],
    exec: async (sql) => {
      await conn.query(sql);
    },
  });

  return {
    async tx(fn) {
      const conn = await pool.connect();
      try {
        await conn.query('BEGIN');
        const result = await fn(wrap(conn));
        await conn.query('COMMIT');
        return result;
      } catch (error) {
        await conn.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        conn.release();
      }
    },
    close: () => pool.end(),
  };
}

function toParam(value: unknown): unknown {
  if (value !== null && typeof value === 'object' && !(value instanceof Date)) return JSON.stringify(value);
  return value;
}
