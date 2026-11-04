import type { IncomingMessage, ServerResponse } from 'node:http';
import { loadConfig } from './config.ts';
import { createDb } from './db/index.ts';
import type { Deps } from './deps.ts';
import { serveApi } from './node-adapter.ts';

// A mesma instância da função reaproveita a configuração e o banco entre requisições.
let ready: Promise<Deps> | undefined;

function deps() {
  ready ??= (async () => {
    const config = loadConfig();
    return { config, db: await createDb(config.databaseUrl) };
  })().catch((error) => {
    ready = undefined;
    throw error;
  });
  return ready;
}

export default async function handler(req: IncomingMessage, res: ServerResponse) {
  try {
    await serveApi(req, res, await deps());
  } catch (error) {
    console.error(error);
    res.statusCode = 503;
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    res.end(JSON.stringify({ error: 'indisponivel', message: 'O sistema está indisponível. Tente de novo em alguns minutos.' }));
  }
}
