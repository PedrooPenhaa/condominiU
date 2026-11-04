import { handle } from '../src/server/app.ts';
import { loadConfig } from '../src/server/config.ts';
import { createDb, withPlatform } from '../src/server/db/index.ts';
import { startHttpServer } from '../src/server/http-server.ts';
import { hashPassword } from '../src/server/security.ts';
import { startFakeAsaas } from './fake-asaas.ts';
import { migrate } from './migrate.ts';

/**
 * Demonstração local: banco vazio, simulador no lugar do Asaas e dados fictícios.
 * Requer DEMO_ADMIN_URL e DEMO_APP_URL. Abra http://admin.localhost:3000
 */
const adminUrl = process.env.DEMO_ADMIN_URL;
const appUrl = process.env.DEMO_APP_URL;
if (!adminUrl || !appUrl) throw new Error('Defina DEMO_ADMIN_URL e DEMO_APP_URL');

const fake = await startFakeAsaas(Number(process.env.FAKE_ASAAS_PORT ?? 4010));
await migrate(adminUrl);
const owner = await createDb(adminUrl);
await owner.tx((c) => c.exec(`ALTER ROLE condo_app LOGIN`));
await owner.close();

const config = loadConfig({
  NODE_ENV: 'development',
  BASE_DOMAIN: 'localhost',
  BRAND_NAME: 'Gestora Exemplo',
  PORT: process.env.PORT ?? '3000',
  DATABASE_URL: appUrl,
  ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
  JOBS_SECRET: 'demo',
  ASAAS_BASE_URL: fake.url,
  ASAAS_API_KEY: '$aact_demo',
  ASAAS_WALLET_ID: 'wallet_demo',
  ASAAS_WEBHOOK_TOKEN: 'token-de-demonstracao-com-mais-de-32-caracteres',
} as NodeJS.ProcessEnv);
const db = await createDb(appUrl);
const deps = { db, config };
const ADMIN_EMAIL = 'admin@exemplo.test';
const ADMIN_PASSWORD = 'demonstracao-123';
const PASSWORD = 'demonstracao-123';

async function call(host: string, method: string, path: string, body?: unknown, token?: string, headers: Record<string, string> = {}) {
  const response = await handle(new Request(`http://${host}${path}`, {
    method,
    headers: { host, 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  }), deps);
  const data: any = await response.json();
  if (!response.ok) throw new Error(`${path}: ${JSON.stringify(data)}`);
  return data;
}

function cpf(base: number) {
  const digits = String(base).padStart(9, '0').split('').map(Number);
  for (const size of [9, 10]) {
    let sum = 0;
    for (let i = 0; i < size; i++) sum += digits[i]! * (size + 1 - i);
    const rest = (sum * 10) % 11;
    digits.push(rest === 10 ? 0 : rest);
  }
  return digits.join('');
}

const NAMES = ['Ana', 'Bruno', 'Carla', 'Diego', 'Elisa', 'Fábio', 'Gabriela', 'Heitor', 'Iara', 'João', 'Karina', 'Lucas', 'Marina', 'Nuno'];
const SURNAMES = ['Souza', 'Lima', 'Dias', 'Reis', 'Prado', 'Campos'];
const person = (i: number) => `${NAMES[i % NAMES.length]} ${SURNAMES[i % SURNAMES.length]}`;

async function seedCondominium(admin: string, input: any, rows: string[], paidRatio: number, competence: string) {
  const host = `${input.slug}.localhost`;
  const created = await call('admin.localhost', 'POST', '/api/v1/platform/condominiums', input, admin);
  const id = created.condominium.id;
  await call('admin.localhost', 'POST', `/api/v1/platform/condominiums/${id}/provision`, undefined, admin);
  const account = fake.calls.filter((c) => c.path === '/accounts').at(-1)!;
  const token = account.body.webhooks[0].authToken;
  const hook = (event: any) => call('admin.localhost', 'POST', `/webhooks/asaas/condominium/${id}`, event, undefined, { 'asaas-access-token': token });
  await hook({ id: `apr-${id}`, event: 'ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED' });
  const billing = await call('admin.localhost', 'POST', `/api/v1/platform/condominiums/${id}/billing`, { billingType: 'UNDEFINED' }, admin);

  const temp = created.manager.temporaryPassword;
  const manager = await call(host, 'POST', '/api/v1/auth/login', { email: input.managerEmail, password: temp, client: 'mobile' });
  await call(host, 'POST', '/api/v1/auth/change-password', { current: temp, next: PASSWORD }, manager.token);
  await call(host, 'POST', '/api/v1/condo/units/import', { kind: input.kind === 'casas' ? 'casa' : 'apartamento', text: rows.join('\n') }, manager.token);

  const today = new Date().toISOString().slice(0, 10);
  const due = `${competence}-28` >= today ? `${competence}-28` : today;
  await call(host, 'POST', '/api/v1/condo/charges/generate', { competence, dueDate: due }, manager.token);
  const charges = await call(host, 'GET', `/api/v1/condo/charges?competence=${competence}`, undefined, manager.token);
  for (const [index, charge] of charges.entries()) {
    const ratio = index / charges.length;
    const payment = { id: charge.asaas_payment_id, value: charge.value_cents / 100, netValue: charge.value_cents / 100 - 2.15, externalReference: charge.id, dueDate: charge.due_date };
    if (ratio < paidRatio) await hook({ id: `pg-${charge.id}`, event: 'PAYMENT_RECEIVED', payment });
    else if (index % 5 === 0) await hook({ id: `ov-${charge.id}`, event: 'PAYMENT_OVERDUE', payment });
  }
  const invoice = { id: `pay_fee_${id}`, subscription: billing.platform_subscription_id, value: input.feeMonthlyCents / 100, dueDate: today, invoiceUrl: 'https://sandbox.example/fatura' };
  const platformHeaders = { 'asaas-access-token': config.asaasWebhookToken };
  await call('admin.localhost', 'POST', '/webhooks/asaas/platform', { id: `fee-${id}`, event: paidRatio > 0.5 ? 'PAYMENT_RECEIVED' : 'PAYMENT_OVERDUE', payment: invoice }, undefined, platformHeaders);
  // Vencidas de verdade na demonstração: o simulador não muda datas sozinho.
  await withPlatform(db, async (c) => {
    await c.query(`UPDATE charges SET due_date = CURRENT_DATE - 5 WHERE status = 'vencida'`);
    await c.query(`UPDATE platform_invoices SET due_date = CURRENT_DATE - 5 WHERE status = 'vencida'`);
  });
  return id;
}

const hash = await hashPassword(ADMIN_PASSWORD);
await withPlatform(db, (c) =>
  c.query(`INSERT INTO users (email, name, password_hash, is_platform_admin, must_change_password) VALUES ($1, 'Pedro', $2, true, false)`, [ADMIN_EMAIL, hash]),
);
const admin = (await call('admin.localhost', 'POST', '/api/v1/auth/login', { email: ADMIN_EMAIL, password: ADMIN_PASSWORD, client: 'mobile' })).token;

const competence = new Date().toISOString().slice(0, 7);
const base = { legalNature: 'condominio_edilicio', mobilePhone: '61999990000', addressNumber: '10', postalCode: '70000-000', monthlyIncomeCents: 5000000, billingDueDay: 10 };

let n = 100000000;
const row = (block: string, number: string, fee: string, withPayer = true) => {
  n += 7919;
  return withPayer ? `${block};${number};${fee};${person(n % 97)};${cpf(n)};;` : `${block};${number};${fee};;;;`;
};
const towers = ['A', 'B'].flatMap((block) =>
  [1, 2, 3, 4, 5, 6].flatMap((floor) => [1, 2, 3, 4].map((u) => row(block, `${floor}0${u}`, '850,00', !(block === 'B' && floor === 6 && u === 4)))),
);
const houses = Array.from({ length: 22 }, (_, i) => row('', String(i + 1), '1.150,00'));
const mixed = [...[1, 2, 3].flatMap((f) => [1, 2, 3].map((u) => row('Torre', `${f}0${u}`, '720,00'))), ...Array.from({ length: 8 }, (_, i) => row('Casas', String(i + 1), '980,00'))];

await seedCondominium(admin, { ...base, name: 'Residencial Aurora', slug: 'aurora', kind: 'predio', hasConcierge: true, cnpj: '11.222.333/0001-81', email: 'contato@aurora.test', address: 'SQN 210', province: 'Asa Norte', feeMonthlyCents: 29700, feeSplitType: 'none', feeSplitValue: 0, managerName: 'Marta Prado', managerEmail: 'sindica@aurora.test' }, towers, 0.68, competence);
await seedCondominium(admin, { ...base, name: 'Mansões do Lago', slug: 'lago', kind: 'casas', hasConcierge: false, legalNature: 'associacao', cnpj: '11.444.777/0001-61', email: 'contato@lago.test', address: 'SMDB Conjunto 12', province: 'Lago Sul', feeMonthlyCents: 19700, feeSplitType: 'fixed', feeSplitValue: 200, managerName: 'Rui Campos', managerEmail: 'sindico@lago.test' }, houses, 0.82, competence);
await seedCondominium(admin, { ...base, name: 'Parque das Águas', slug: 'parque', kind: 'misto', hasConcierge: true, cnpj: '45.997.418/0001-53', email: 'contato@parque.test', address: 'Rua 25 Norte', province: 'Águas Claras', feeMonthlyCents: 24700, feeSplitType: 'percent', feeSplitValue: 100, managerName: 'Lia Reis', managerEmail: 'sindica@parque.test' }, mixed, 0.4, competence);
await call('admin.localhost', 'POST', '/api/v1/platform/condominiums', { ...base, name: 'Vivendas do Cerrado', slug: 'vivendas', kind: 'casas', hasConcierge: false, cnpj: '19.131.243/0001-97', email: 'contato@vivendas.test', address: 'Condomínio Vivendas', province: 'Jardim Botânico', feeMonthlyCents: 19700, feeSplitType: 'none', feeSplitValue: 0, managerName: 'Tom Dias', managerEmail: 'sindico@vivendas.test' }, admin);

startHttpServer(deps, Number(process.env.PORT ?? 3000));
console.log(`Pronto. Administração: http://admin.localhost:${process.env.PORT ?? 3000}  (${ADMIN_EMAIL} / ${ADMIN_PASSWORD})`);
console.log(`Condomínio: http://aurora.localhost:${process.env.PORT ?? 3000}  (sindica@aurora.test / ${PASSWORD})`);
