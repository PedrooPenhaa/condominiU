import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { handle } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { createDb, withPlatform, type Db } from '../src/server/db/index.ts';
import type { Deps } from '../src/server/deps.ts';
import { hashPassword } from '../src/server/security.ts';
import { migrate } from '../scripts/migrate.ts';
import { startFakeAsaas, type FakeAsaas } from '../scripts/fake-asaas.ts';

export const BASE = 'condo.test';
const PG_HOST = process.env.TEST_PG_HOST ?? '127.0.0.1';
const PG_PORT = process.env.TEST_PG_PORT ?? '55432';
const PG_OWNER = process.env.TEST_PG_OWNER ?? 'claude';

export interface Harness {
  deps: Deps;
  owner: Db;
  fake: FakeAsaas;
  call(method: string, host: string, path: string, body?: unknown, token?: string, headers?: Record<string, string>): Promise<{ status: number; data: any; headers: Headers }>;
  login(host: string, email: string, password: string): Promise<string>;
  close(): Promise<void>;
}

export async function startHarness(): Promise<Harness> {
  const name = `t_${randomBytes(5).toString('hex')}`;
  const psql = (sql: string, db = 'postgres') =>
    execFileSync('psql', ['-h', PG_HOST, '-p', PG_PORT, '-U', PG_OWNER, '-d', db, '-v', 'ON_ERROR_STOP=1', '-c', sql], { stdio: 'pipe' });
  psql(`CREATE DATABASE ${name}`);
  const ownerUrl = `wire://${PG_OWNER}@${PG_HOST}:${PG_PORT}/${name}`;
  await migrate(ownerUrl);
  psql(`ALTER ROLE condo_app LOGIN`, name);

  const fake = await startFakeAsaas();
  const config = loadConfig({
    NODE_ENV: 'test',
    BASE_DOMAIN: BASE,
    DATABASE_URL: `wire://condo_app@${PG_HOST}:${PG_PORT}/${name}`,
    ENCRYPTION_KEY: randomBytes(32).toString('base64'),
    JOBS_SECRET: 'segredo-das-rotinas',
    ASAAS_BASE_URL: fake.url,
    ASAAS_API_KEY: '$aact_parent',
    ASAAS_WALLET_ID: 'wallet_parent',
    ASAAS_WEBHOOK_TOKEN: 'token-da-plataforma-com-mais-de-32-caracteres',
  } as NodeJS.ProcessEnv);
  const db = await createDb(config.databaseUrl);
  const owner = await createDb(ownerUrl);
  const deps: Deps = { db, config };

  const call: Harness['call'] = async (method, host, path, body, token, headers = {}) => {
    const response = await handle(
      new Request(`http://${host}${path}`, {
        method,
        headers: {
          host,
          ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
          ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...headers,
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
      deps,
    );
    // Request remove o cabeçalho host em alguns ambientes; a URL carrega o mesmo valor
    return { status: response.status, data: await response.json(), headers: response.headers };
  };
  const login: Harness['login'] = async (host, email, password) => {
    const result = await call('POST', host, '/api/v1/auth/login', { email, password, client: 'mobile' });
    if (result.status !== 200) throw new Error(`Falha no login: ${JSON.stringify(result.data)}`);
    return result.data.token;
  };
  return {
    deps, owner, fake, call, login,
    close: async () => {
      await db.close();
      await owner.close();
      await fake.close();
      await new Promise((r) => setTimeout(r, 30));
      psql(`DROP DATABASE ${name} WITH (FORCE)`);
    },
  };
}

export async function createAdmin(h: Harness, email = 'admin@gestora.test', password = 'senha-do-admin-123') {
  const hash = await hashPassword(password);
  await withPlatform(h.deps.db, (c) =>
    c.query(`INSERT INTO users (email, name, password_hash, is_platform_admin, must_change_password) VALUES ($1, 'Admin', $2, true, false)`, [email, hash]),
  );
  return h.login(`admin.${BASE}`, email, password);
}

export const condominiumBody = (overrides: Record<string, unknown> = {}) => ({
  name: 'Residencial Aurora',
  slug: 'aurora',
  kind: 'predio',
  hasConcierge: true,
  legalNature: 'condominio_edilicio',
  cnpj: '11.222.333/0001-81',
  email: 'contato@aurora.test',
  mobilePhone: '61999990000',
  address: 'SQN 210',
  addressNumber: '10',
  province: 'Asa Norte',
  postalCode: '70862-000',
  monthlyIncomeCents: 5000000,
  feeMonthlyCents: 19700,
  feeSplitType: 'none',
  feeSplitValue: 0,
  billingDueDay: 10,
  managerName: 'Síndica Teste',
  managerEmail: 'sindica@aurora.test',
  ...overrides,
});

/** Calcula um CPF válido, para testes, a partir de 9 dígitos. */
export function cpf(base: number) {
  const digits = String(base).padStart(9, '0').split('').map(Number);
  for (const size of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += digits[i]! * (size + 1 - i);
    const rest = (sum * 10) % 11;
    digits.push(rest === 10 ? 0 : rest);
  }
  return digits.join('');
}
