import { readdirSync, readFileSync } from 'node:fs';
import { createDb } from '../src/server/db/index.ts';

/** Aplica as migrações pendentes, em ordem. Use a conexão do dono do banco. */
export async function migrate(url: string, dir = 'db/migrations') {
  const db = await createDb(url);
  try {
    await db.tx((c) => c.exec(`CREATE TABLE IF NOT EXISTS public.schema_migrations (name text PRIMARY KEY, applied_at timestamptz DEFAULT now())`));
    const applied = new Set(
      (await db.tx((c) => c.query(`SELECT name FROM public.schema_migrations`))).map((r) => r.name),
    );
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
      if (applied.has(file)) continue;
      await db.tx(async (c) => {
        await c.exec(readFileSync(`${dir}/${file}`, 'utf8'));
        await c.query(`INSERT INTO public.schema_migrations (name) VALUES ($1)`, [file]);
      });
      console.log(`Aplicada: ${file}`);
    }
  } finally {
    await db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const url = process.env.DATABASE_ADMIN_URL;
  if (!url) throw new Error('Defina DATABASE_ADMIN_URL');
  await migrate(url);
}
