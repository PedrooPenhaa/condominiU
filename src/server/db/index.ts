export type Row = Record<string, any>;

export interface Client {
  query<T extends Row = Row>(sql: string, params?: unknown[]): Promise<T[]>;
  /** Roda um script com vários comandos, sem parâmetros. Usado nas migrações. */
  exec(sql: string): Promise<void>;
}

export interface Db {
  /** Abre uma transação; confirma ao terminar e desfaz em caso de erro. */
  tx<T>(fn: (client: Client) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}

/**
 * Abre uma transação limitada a um condomínio. As regras do banco impedem
 * qualquer leitura ou escrita em dados de outro condomínio.
 */
export function withTenant<T>(db: Db, tenantId: string, fn: (c: Client) => Promise<T>): Promise<T> {
  return db.tx(async (client) => {
    await client.query(
      `SELECT set_config('search_path', 'app', true), set_config('app.tenant_id', $1, true), set_config('app.is_platform', '', true)`,
      [tenantId],
    );
    return fn(client);
  });
}

/** Abre uma transação com visão da plataforma. Só para rotas do administrador, login e webhooks. */
export function withPlatform<T>(db: Db, fn: (c: Client) => Promise<T>): Promise<T> {
  return db.tx(async (client) => {
    await client.query(
      `SELECT set_config('search_path', 'app', true), set_config('app.is_platform', 'on', true), set_config('app.tenant_id', '', true)`,
    );
    return fn(client);
  });
}

export async function createDb(url: string): Promise<Db> {
  if (url.startsWith('wire://')) {
    const { createWireDb } = await import('./wire-driver.ts');
    return createWireDb(url);
  }
  const { createPgDb } = await import('./pg-driver.ts');
  return createPgDb(url);
}
