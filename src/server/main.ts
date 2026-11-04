import { loadConfig } from './config.ts';
import { createDb } from './db/index.ts';
import { publicUrl } from './deps.ts';
import { startHttpServer } from './http-server.ts';

const config = loadConfig();
const db = await createDb(config.databaseUrl);
const port = Number(process.env.PORT ?? 3000);
const deps = { db, config };
const server = startHttpServer(deps, port);
console.log(`Painel da administração: ${publicUrl(deps, 'admin')}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    void db.close().finally(() => process.exit(0));
  });
}
