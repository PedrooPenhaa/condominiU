import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { decryptSecret } from '../src/server/security.ts';
import { withPlatform, withTenant } from '../src/server/db/index.ts';
import { BASE, condominiumBody, cpf, createAdmin, startHarness, type Harness } from './helpers.ts';

let h: Harness;
let admin: string;
let sindico: string;
let condoId: string;
let webhookToken: string;
let subKey: string;
const ADMIN = `admin.${BASE}`;
const HOST = `aurora.${BASE}`;
const COMPETENCE = '2027-03';
const DUE = '2027-03-10';

const webhook = (event: string, payment: any, id: string = crypto.randomUUID()) =>
  h.call('POST', ADMIN, `/webhooks/asaas/condominium/${condoId}`, { id, event, payment }, undefined, { 'asaas-access-token': webhookToken });
const chargeRow = async (number: string) => {
  const [row] = await withTenant(h.deps.db, condoId, (c) =>
    c.query(`SELECT ch.* FROM charges ch JOIN units u ON u.id = ch.unit_id WHERE u.number = $1 AND ch.competence = $2`, [number, COMPETENCE]));
  return row!;
};

before(async () => {
  h = await startHarness();
  admin = await createAdmin(h);
  const created = await h.call('POST', ADMIN, '/api/v1/platform/condominiums', condominiumBody({ feeSplitType: 'percent', feeSplitValue: 150 }), admin);
  assert.equal(created.status, 200, JSON.stringify(created.data));
  condoId = created.data.condominium.id;
  const temp = created.data.manager.temporaryPassword;
  sindico = await h.login(HOST, 'sindica@aurora.test', temp);
  await h.call('POST', HOST, '/api/v1/auth/change-password', { current: temp, next: 'nova-senha-da-sindica' }, sindico);
});
after(() => h.close());

test('cria a conta de recebimento no CNPJ do condomínio e cifra a chave', async () => {
  const result = await h.call('POST', ADMIN, `/api/v1/platform/condominiums/${condoId}/provision`, undefined, admin);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.status, 'aguardando_aprovacao');

  const call = h.fake.calls.find((x) => x.path === '/accounts')!;
  assert.equal(call.key, '$aact_parent');
  assert.equal(call.body.cpfCnpj, '11222333000181');
  assert.equal(call.body.webhooks[0].url, `http://admin.${BASE}:3000/webhooks/asaas/condominium/${condoId}`);
  webhookToken = call.body.webhooks[0].authToken;

  const [row] = await withPlatform(h.deps.db, (c) => c.query(`SELECT asaas_api_key_enc FROM condominiums WHERE id = $1`, [condoId]));
  assert.ok(!row!.asaas_api_key_enc.includes('aact'));
  subKey = decryptSecret(row!.asaas_api_key_enc, h.deps.config.encryptionKey);
  assert.ok(subKey.startsWith('$aact_sub_'));
});

test('não emite cobrança antes de a conta ser aprovada', async () => {
  const result = await h.call('POST', HOST, '/api/v1/condo/charges/generate', { competence: COMPETENCE, dueDate: DUE }, sindico);
  assert.equal(result.status, 409);
  assert.equal(result.data.error, 'condominio_inativo');
});

test('webhook com token errado é recusado', async () => {
  const result = await h.call('POST', ADMIN, `/webhooks/asaas/condominium/${condoId}`, { id: 'x', event: 'PAYMENT_RECEIVED' }, undefined, { 'asaas-access-token': 'errado' });
  assert.equal(result.status, 401);
});

test('aviso de aprovação ativa o condomínio', async () => {
  const result = await h.call('POST', ADMIN, `/webhooks/asaas/condominium/${condoId}`, { id: 'evt-aprovacao', event: 'ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED' }, undefined, { 'asaas-access-token': webhookToken });
  assert.equal(result.status, 200);
  const detail = await h.call('GET', ADMIN, `/api/v1/platform/condominiums/${condoId}`, undefined, admin);
  assert.equal(detail.data.condominium.status, 'ativo');
  assert.equal(detail.data.condominium.asaas_approval, 'aprovada');
});

test('importa unidades de prédio e aponta linhas inválidas', async () => {
  const text = [
    'Bloco;Número;Valor;Pagador;CPF;E-mail;Celular',
    `A;101;850,00;Ana Souza;${cpf(123456789)};ana@teste.test;61999990001`,
    `A;102;850,00;Bruno Lima;${cpf(223456789)};;`,
    'A;103;850,00;;;;',
    `A;104;1.200,50;Carla Dias;${cpf(323456789)};;`,
    'A;105;abc',
    'A;106;850,00;Dado Inválido;11111111111;;',
  ].join('\n');
  const result = await h.call('POST', HOST, '/api/v1/condo/units/import', { kind: 'apartamento', text }, sindico);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.created, 4);
  assert.deepEqual(result.data.errors.map((e: any) => e.line), [6, 7]);
});

test('gera a cobrança do mês na conta do condomínio, com split para a plataforma', async () => {
  const result = await h.call('POST', HOST, '/api/v1/condo/charges/generate', { competence: COMPETENCE, dueDate: DUE }, sindico);
  assert.equal(result.status, 200, JSON.stringify(result.data));
  assert.equal(result.data.created, 3);
  assert.deepEqual(result.data.withoutPayer, ['A 103']);

  const payments = h.fake.calls.filter((x) => x.method === 'POST' && x.path === '/payments');
  assert.equal(payments.length, 3);
  for (const call of payments) {
    assert.equal(call.key, subKey, 'a cobrança precisa sair da chave do condomínio');
    assert.deepEqual(call.body.split, [{ walletId: 'wallet_parent', percentualValue: 1.5 }]);
    assert.equal(call.body.billingType, 'UNDEFINED');
  }
  const bigger = payments.find((x) => x.body.value === 1200.5);
  assert.ok(bigger, 'valor em reais convertido sem erro de arredondamento');
});

test('gerar de novo não duplica cobranças', async () => {
  const before = h.fake.calls.filter((x) => x.path === '/payments' && x.method === 'POST').length;
  const result = await h.call('POST', HOST, '/api/v1/condo/charges/generate', { competence: COMPETENCE, dueDate: DUE }, sindico);
  assert.equal(result.data.created, 0);
  assert.equal(result.data.alreadyExisting, 3);
  assert.equal(h.fake.calls.filter((x) => x.path === '/payments' && x.method === 'POST').length, before);
});

test('pagamento confirmado marca como paga e calcula o repasse sobre o líquido', async () => {
  const charge = await chargeRow('101');
  const payment = { id: charge.asaas_payment_id, value: 850, netValue: 847.85, status: 'RECEIVED', externalReference: charge.id, paymentDate: '2027-03-05' };
  assert.equal((await webhook('PAYMENT_RECEIVED', payment)).status, 200);
  const updated = await chargeRow('101');
  assert.equal(updated.status, 'paga');
  assert.equal(updated.net_cents, 84785);
  assert.equal(updated.split_cents, 1272);
  assert.ok(updated.paid_at);
});

test('evento repetido e fora de ordem não desfaz o pagamento', async () => {
  const charge = await chargeRow('101');
  const payment = { id: charge.asaas_payment_id, value: 850, status: 'OVERDUE', externalReference: charge.id };
  const first = await webhook('PAYMENT_OVERDUE', payment, 'evt-fora-de-ordem');
  assert.equal(first.data.duplicate, false);
  const again = await webhook('PAYMENT_OVERDUE', payment, 'evt-fora-de-ordem');
  assert.equal(again.data.duplicate, true);
  assert.equal((await chargeRow('101')).status, 'paga');
});

test('estorno reverte o pagamento e zera o repasse', async () => {
  const charge = await chargeRow('101');
  await webhook('PAYMENT_REFUNDED', { id: charge.asaas_payment_id, value: 850, status: 'REFUNDED', externalReference: charge.id });
  const updated = await chargeRow('101');
  assert.equal(updated.status, 'estornada');
  assert.equal(updated.split_cents, 0);
  assert.equal(updated.paid_at, null);
});

test('vencimento aparece no resumo do mês', async () => {
  const charge = await chargeRow('102');
  await webhook('PAYMENT_OVERDUE', { id: charge.asaas_payment_id, value: 850, status: 'OVERDUE', externalReference: charge.id });
  const summary = await h.call('GET', HOST, `/api/v1/condo/summary?competence=${COMPETENCE}`, undefined, sindico);
  assert.equal(summary.status, 200);
  assert.equal(summary.data.overdue_count, 1);
  assert.equal(summary.data.overdue_cents, 85000);
  assert.equal(summary.data.tiles.length, 4);
  assert.equal(summary.data.tiles.find((t: any) => t.number === '103').charge_status, null);
});

test('queda de conexão no meio da emissão não cobra duas vezes', async () => {
  const unit = await h.call('POST', HOST, '/api/v1/condo/units', {
    kind: 'apartamento', block: 'A', number: '201', feeCents: 50000, payer: { name: 'Eva Reis', cpfCnpj: cpf(423456789) },
  }, sindico);
  assert.equal(unit.status, 200, JSON.stringify(unit.data));
  h.fake.failNextPaymentAfterCreate = true;
  const first = await h.call('POST', HOST, '/api/v1/condo/charges/generate', { competence: COMPETENCE, dueDate: DUE }, sindico);
  assert.equal(first.data.failed.length, 1);
  assert.equal((await chargeRow('201')).status, 'criando');

  const retry = await h.call('POST', HOST, '/api/v1/condo/charges/generate', { competence: COMPETENCE, dueDate: DUE }, sindico);
  assert.equal(retry.data.created, 1);
  const charge = await chargeRow('201');
  assert.equal(charge.status, 'pendente');
  const matching = [...h.fake.payments.values()].filter((p) => p.externalReference === charge.id);
  assert.equal(matching.length, 1, 'só pode existir uma cobrança no Asaas');
  assert.equal(charge.asaas_payment_id, matching[0].id);
});

test('morador vê só as cobranças da própria unidade', async () => {
  const units = await h.call('GET', HOST, '/api/v1/condo/units', undefined, sindico);
  const unit102 = units.data.find((u: any) => u.number === '102');
  const added = await h.call('POST', HOST, '/api/v1/condo/members', { name: 'Bruno', email: 'bruno@teste.test', role: 'morador', unitId: unit102.id }, sindico);
  assert.equal(added.status, 200, JSON.stringify(added.data));
  const temp = added.data.temporaryPassword;
  const token = await h.login(HOST, 'bruno@teste.test', temp);
  await h.call('POST', HOST, '/api/v1/auth/change-password', { current: temp, next: 'senha-do-bruno-123' }, token);
  const mine = await h.call('GET', HOST, '/api/v1/condo/my-charges', undefined, token);
  assert.equal(mine.data.length, 1);
  assert.equal(mine.data[0].status, 'vencida');
  const denied = await h.call('GET', HOST, '/api/v1/condo/charges', undefined, token);
  assert.equal(denied.status, 403);
});

test('mensalidade cai na conta da plataforma e o aviso gera a fatura', async () => {
  const billing = await h.call('POST', ADMIN, `/api/v1/platform/condominiums/${condoId}/billing`, { billingType: 'UNDEFINED' }, admin);
  assert.equal(billing.status, 200, JSON.stringify(billing.data));
  const sub = h.fake.calls.find((x) => x.path === '/subscriptions')!;
  assert.equal(sub.key, '$aact_parent', 'a mensalidade usa a sua chave, não a do condomínio');
  assert.equal(sub.body.value, 197);
  assert.equal(sub.body.cycle, 'MONTHLY');

  const payment = { id: 'pay_mensal_1', subscription: billing.data.platform_subscription_id, value: 197, dueDate: '2027-03-10', invoiceUrl: 'https://x/i' };
  const headers = { 'asaas-access-token': h.deps.config.asaasWebhookToken };
  await h.call('POST', ADMIN, '/webhooks/asaas/platform', { id: 'p1', event: 'PAYMENT_CREATED', payment }, undefined, headers);
  await h.call('POST', ADMIN, '/webhooks/asaas/platform', { id: 'p2', event: 'PAYMENT_OVERDUE', payment }, undefined, headers);
  let dash = await h.call('GET', ADMIN, '/api/v1/platform/dashboard', undefined, admin);
  assert.equal(dash.data.mrr_cents, 19700);
  assert.equal(dash.data.overdue_cents, 19700);
  await h.call('POST', ADMIN, '/webhooks/asaas/platform', { id: 'p3', event: 'PAYMENT_RECEIVED', payment }, undefined, headers);
  dash = await h.call('GET', ADMIN, '/api/v1/platform/dashboard', undefined, admin);
  assert.equal(dash.data.overdue_cents, 0);
  assert.equal(dash.data.paid_month_cents, 19700);
});

test('condomínio suspenso continua lendo, mas não altera dados', async () => {
  await h.call('POST', ADMIN, `/api/v1/platform/condominiums/${condoId}/status`, { status: 'suspenso' }, admin);
  const read = await h.call('GET', HOST, '/api/v1/condo/units', undefined, sindico);
  assert.equal(read.status, 200);
  const write = await h.call('POST', HOST, '/api/v1/condo/charges/generate', { competence: '2027-04', dueDate: '2027-04-10' }, sindico);
  assert.equal(write.status, 402);
  await h.call('POST', ADMIN, `/api/v1/platform/condominiums/${condoId}/status`, { status: 'ativo' }, admin);
});

test('rotina corrige cobrança paga cujo aviso se perdeu', async () => {
  const charge = await chargeRow('201');
  h.fake.payments.get(charge.asaas_payment_id).status = 'RECEIVED';
  h.fake.payments.get(charge.asaas_payment_id).netValue = 497.85;
  await h.owner.tx((c) => c.exec(`UPDATE app.charges SET updated_at = now() - interval '7 hours' WHERE id = '${charge.id}'`));
  const denied = await h.call('POST', ADMIN, '/internal/jobs/run', {}, undefined, { 'x-jobs-secret': 'errado' });
  assert.equal(denied.status, 401);
  const run = await h.call('POST', ADMIN, '/internal/jobs/run', {}, undefined, { 'x-jobs-secret': 'segredo-das-rotinas' });
  assert.equal(run.status, 200, JSON.stringify(run.data));
  assert.equal(run.data.chargesCorrected, 1);
  const updated = await chargeRow('201');
  assert.equal(updated.status, 'paga');
  assert.equal(updated.split_cents, 747);
});

test('cancelar remove do Asaas e não aceita cobrança já paga', async () => {
  const open = await chargeRow('104');
  const ok = await h.call('POST', HOST, `/api/v1/condo/charges/${open.id}/cancel`, {}, sindico);
  assert.equal(ok.status, 200, JSON.stringify(ok.data));
  assert.equal(h.fake.payments.get(open.asaas_payment_id).deleted, true);
  const paid = await chargeRow('201');
  const refused = await h.call('POST', HOST, `/api/v1/condo/charges/${paid.id}/cancel`, {}, sindico);
  assert.equal(refused.status, 409);
});

test('visitante: com porteiro só a portaria registra; código não reutiliza', async () => {
  const units = await h.call('GET', HOST, '/api/v1/condo/units', undefined, sindico);
  const unit102 = units.data.find((u: any) => u.number === '102');
  const morador = await h.login(HOST, 'bruno@teste.test', 'senha-do-bruno-123');
  const pass = await h.call('POST', HOST, '/api/v1/condo/visitors', { visitorName: 'Fernanda', validHours: 4 }, morador);
  assert.equal(pass.status, 200, JSON.stringify(pass.data));
  assert.equal(pass.data.unit_id, unit102.id);
  const self = await h.call('POST', HOST, '/api/v1/condo/visitors/check-in', { code: pass.data.code }, morador);
  assert.equal(self.status, 403);
  const added = await h.call('POST', HOST, '/api/v1/condo/members', { name: 'Porteiro', email: 'porteiro@teste.test', role: 'porteiro' }, sindico);
  const porteiro = await h.login(HOST, 'porteiro@teste.test', added.data.temporaryPassword);
  await h.call('POST', HOST, '/api/v1/auth/change-password', { current: added.data.temporaryPassword, next: 'senha-do-porteiro-1' }, porteiro);
  const entry = await h.call('POST', HOST, '/api/v1/condo/visitors/check-in', { code: pass.data.code }, porteiro);
  assert.equal(entry.status, 200, JSON.stringify(entry.data));
  const again = await h.call('POST', HOST, '/api/v1/condo/visitors/check-in', { code: pass.data.code }, porteiro);
  assert.equal(again.status, 409);
  const money = await h.call('GET', HOST, '/api/v1/condo/summary', undefined, porteiro);
  assert.equal(money.status, 403, 'porteiro não vê o financeiro');
});

test('envio com sessão do navegador vindo de outro site é bloqueado', async () => {
  const cookieLogin = await h.call('POST', HOST, '/api/v1/auth/login', { email: 'sindica@aurora.test', password: 'nova-senha-da-sindica' }, undefined, { origin: `http://${HOST}` });
  assert.equal(cookieLogin.status, 200, JSON.stringify(cookieLogin.data));
  const cookie = cookieLogin.headers.get('set-cookie')!.split(';')[0]!;
  assert.ok(!cookie.includes('Domain'));
  const evil = await h.call('POST', HOST, '/api/v1/condo/units', { kind: 'casa', number: '1', feeCents: 1 }, undefined, { cookie, origin: 'https://site-malicioso.test' });
  assert.equal(evil.status, 403);
  assert.equal(evil.data.error, 'origem_invalida');
  const noOrigin = await h.call('POST', HOST, '/api/v1/condo/units', { kind: 'casa', number: '1', feeCents: 1 }, undefined, { cookie });
  assert.equal(noOrigin.status, 403);
  const same = await h.call('GET', HOST, '/api/v1/condo/units', undefined, undefined, { cookie });
  assert.equal(same.status, 200);
});
