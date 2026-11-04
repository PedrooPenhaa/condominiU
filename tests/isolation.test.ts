import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { withPlatform, withTenant } from '../src/server/db/index.ts';
import { BASE, condominiumBody, createAdmin, startHarness, type Harness } from './helpers.ts';

let h: Harness;
let admin: string;
let a: any;
let b: any;

before(async () => {
  h = await startHarness();
  admin = await createAdmin(h);
  const one = await h.call('POST', `admin.${BASE}`, '/api/v1/platform/condominiums', condominiumBody(), admin);
  assert.equal(one.status, 200, JSON.stringify(one.data));
  a = one.data;
  const two = await h.call('POST', `admin.${BASE}`, '/api/v1/platform/condominiums', condominiumBody({
    name: 'Mansões do Lago', slug: 'lago', kind: 'casas', hasConcierge: false, cnpj: '11.444.777/0001-61', managerEmail: 'sindico@lago.test',
  }), admin);
  assert.equal(two.status, 200, JSON.stringify(two.data));
  b = two.data;
  await withTenant(h.deps.db, a.condominium.id, (c) =>
    c.query(`INSERT INTO units (condominium_id, block, number, fee_cents) VALUES ($1, 'A', '101', 50000)`, [a.condominium.id]));
  await withTenant(h.deps.db, b.condominium.id, (c) =>
    c.query(`INSERT INTO units (condominium_id, kind, number, fee_cents) VALUES ($1, 'casa', '7', 90000)`, [b.condominium.id]));
});
after(() => h.close());

test('o banco só mostra unidades do condomínio da sessão', async () => {
  const rows = await withTenant(h.deps.db, a.condominium.id, (c) => c.query(`SELECT number FROM units`));
  assert.deepEqual(rows.map((r) => r.number), ['101']);
});

test('o banco recusa gravar dados em outro condomínio', async () => {
  await assert.rejects(
    withTenant(h.deps.db, a.condominium.id, (c) =>
      c.query(`INSERT INTO units (condominium_id, number, fee_cents) VALUES ($1, '999', 1)`, [b.condominium.id])),
    /row-level security/,
  );
});

test('sem definir condomínio, nenhuma linha aparece', async () => {
  const rows = await h.deps.db.tx(async (c) => {
    await c.query(`SELECT set_config('search_path', 'app', true)`);
    return c.query(`SELECT id FROM units`);
  });
  assert.equal(rows.length, 0);
});

test('um condomínio não enxerga usuários nem a tabela de outro condomínio', async () => {
  const users = await withTenant(h.deps.db, a.condominium.id, (c) => c.query(`SELECT id FROM users`));
  assert.equal(users.length, 0);
  const condos = await withTenant(h.deps.db, a.condominium.id, (c) => c.query(`SELECT slug FROM condominiums`));
  assert.deepEqual(condos.map((r) => r.slug), ['aurora']);
});

test('o usuário do sistema não é dono das tabelas nem ignora as regras', async () => {
  const [row] = await withPlatform(h.deps.db, (c) =>
    c.query(`SELECT rolbypassrls, rolsuper FROM pg_roles WHERE rolname = current_user`));
  assert.deepEqual(row, { rolbypassrls: false, rolsuper: false });
});

test('síndico de um condomínio não acessa o subdomínio de outro', async () => {
  const password = a.manager.temporaryPassword;
  const blocked = await h.call('POST', `lago.${BASE}`, '/api/v1/auth/login', { email: 'sindica@aurora.test', password, client: 'mobile' });
  assert.equal(blocked.status, 403);

  const token = await h.login(`aurora.${BASE}`, 'sindica@aurora.test', password);
  await h.call('POST', `aurora.${BASE}`, '/api/v1/auth/change-password', { current: password, next: 'nova-senha-da-sindica' }, token);
  const own = await h.call('GET', `aurora.${BASE}`, '/api/v1/condo/units', undefined, token);
  assert.equal(own.status, 200);
  assert.equal(own.data.length, 1);
  const other = await h.call('GET', `lago.${BASE}`, '/api/v1/condo/units', undefined, token);
  assert.equal(other.status, 403);
  const viaHeader = await h.call('GET', `api.${BASE}`, '/api/v1/condo/units', undefined, token, { 'x-condominium-slug': 'lago' });
  assert.equal(viaHeader.status, 403);
});

test('síndico não acessa o painel da administração', async () => {
  const token = await h.login(`aurora.${BASE}`, 'sindica@aurora.test', 'nova-senha-da-sindica');
  const result = await h.call('GET', `admin.${BASE}`, '/api/v1/platform/dashboard', undefined, token);
  assert.equal(result.status, 403);
});

test('senha temporária precisa ser trocada antes de usar o sistema', async () => {
  const token = await h.login(`lago.${BASE}`, 'sindico@lago.test', b.manager.temporaryPassword);
  const result = await h.call('GET', `lago.${BASE}`, '/api/v1/condo/units', undefined, token);
  assert.equal(result.status, 403);
  assert.equal(result.data.error, 'trocar_senha');
});

test('endereços reservados e CNPJ repetido são recusados', async () => {
  const reserved = await h.call('POST', `admin.${BASE}`, '/api/v1/platform/condominiums', condominiumBody({ slug: 'admin', cnpj: '45.997.418/0001-53', managerEmail: 'x@x.test' }), admin);
  assert.equal(reserved.status, 422);
  const repeated = await h.call('POST', `admin.${BASE}`, '/api/v1/platform/condominiums', condominiumBody({ slug: 'outro', managerEmail: 'y@y.test' }), admin);
  assert.equal(repeated.status, 409);
});

test('a resposta nunca expõe a chave da subconta', async () => {
  const detail = await h.call('GET', `admin.${BASE}`, `/api/v1/platform/condominiums/${a.condominium.id}`, undefined, admin);
  assert.equal(JSON.stringify(detail.data).includes('asaas_api_key_enc'), false);
});

test('login bloqueia após 5 tentativas erradas', async () => {
  for (let i = 0; i < 5; i++) {
    const r = await h.call('POST', `admin.${BASE}`, '/api/v1/auth/login', { email: 'admin@gestora.test', password: 'errada' });
    assert.equal(r.status, 401);
  }
  const blocked = await h.call('POST', `admin.${BASE}`, '/api/v1/auth/login', { email: 'admin@gestora.test', password: 'senha-do-admin-123' });
  assert.equal(blocked.status, 429);
});
