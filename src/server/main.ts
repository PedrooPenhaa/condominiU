import { loadConfig } from './config.ts';
import { createDb } from './db/index.ts';
import { startHttpServer } from './http-server.ts';

const config = loadConfig();
const db = await createDb(config.databaseUrl);
const port = Number(process.env.PORT ?? 3000);
const server = startHttpServer({ db, config }, port);
console.log(`Painel da administração: ${config.publicProtocol}://admin.${config.baseDomain}${config.publicPort}`);

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    server.close();
    void db.close().finally(() => process.exit(0));
  });
}
