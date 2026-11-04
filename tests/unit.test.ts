import assert from 'node:assert/strict';
import { test } from 'node:test';
import { decryptSecret, encryptSecret, hashPassword, normalizeTaxId, verifyPassword } from '../src/server/security.ts';
import { canMove } from '../src/server/services/payment-state.ts';
import { parseHost, slugify, validSlug } from '../src/server/tenancy.ts';
import { randomBytes } from 'node:crypto';

const BASE = 'minhagestora.com.br';

test('identifica o tipo de endereço', () => {
  assert.deepEqual(parseHost('aurora.minhagestora.com.br', BASE), { kind: 'tenant', slug: 'aurora' });
  assert.deepEqual(parseHost('AURORA.MinhaGestora.com.br:3000', BASE), { kind: 'tenant', slug: 'aurora' });
  assert.deepEqual(parseHost('admin.minhagestora.com.br', BASE), { kind: 'platform' });
  assert.deepEqual(parseHost('api.minhagestora.com.br', BASE), { kind: 'api' });
  assert.deepEqual(parseHost('minhagestora.com.br', BASE), { kind: 'root' });
  assert.deepEqual(parseHost('www.minhagestora.com.br', BASE), { kind: 'root' });
  assert.deepEqual(parseHost('a.b.minhagestora.com.br', BASE), { kind: 'root' });
  assert.deepEqual(parseHost('aurora.outrodominio.com', BASE), { kind: 'root' });
  assert.deepEqual(parseHost('evilminhagestora.com.br', BASE), { kind: 'root' });
});

test('identifica endereços com prefixo, para testar sem domínio próprio', () => {
  const parse = (host: string) => parseHost(host, 'vercel.app', 'condominiu-');
  assert.deepEqual(parse('condominiu-admin.vercel.app'), { kind: 'platform' });
  assert.deepEqual(parse('condominiu-api.vercel.app'), { kind: 'api' });
  assert.deepEqual(parse('condominiu-aurora.vercel.app'), { kind: 'tenant', slug: 'aurora' });
  assert.deepEqual(parse('condominiu.vercel.app'), { kind: 'root' });
  assert.deepEqual(parse('condominiu-.vercel.app'), { kind: 'root' });
  assert.deepEqual(parse('aurora.vercel.app'), { kind: 'root' });
  assert.deepEqual(parse('admin.vercel.app'), { kind: 'root' });
  assert.deepEqual(parse('x.condominiu-admin.vercel.app'), { kind: 'root' });
});

test('sugere e valida endereços', () => {
  assert.equal(slugify('Residencial Águas Claras - Bloco Único'), 'residencial-aguas-claras-bloco-unico');
  assert.equal(validSlug('aurora'), true);
  assert.equal(validSlug('admin'), false);
  assert.equal(validSlug('-aurora'), false);
  assert.equal(validSlug('Aurora'), false);
  assert.equal(validSlug('a'.repeat(51)), false);
});

test('valida CPF e CNPJ, inclusive alfanumérico', () => {
  assert.equal(normalizeTaxId('529.982.247-25'), '52998224725');
  assert.equal(normalizeTaxId('111.111.111-11'), null);
  assert.equal(normalizeTaxId('529.982.247-24'), null);
  assert.equal(normalizeTaxId('11.222.333/0001-81'), '11222333000181');
  assert.equal(normalizeTaxId('11.222.333/0001-82'), null);
  assert.equal(normalizeTaxId('12.ABC.345/01DE-35'), '12ABC34501DE35');
});

test('senha e segredo: confere o certo e recusa o errado', async () => {
  const hash = await hashPassword('senha-correta');
  assert.equal(await verifyPassword('senha-correta', hash), true);
  assert.equal(await verifyPassword('senha-errada', hash), false);
  const key = randomBytes(32);
  const sealed = encryptSecret('$aact_segredo', key);
  assert.ok(!sealed.includes('aact'));
  assert.equal(decryptSecret(sealed, key), '$aact_segredo');
  assert.throws(() => decryptSecret(sealed, randomBytes(32)));
});

test('transições de pagamento', () => {
  assert.equal(canMove('pendente', 'paga'), true);
  assert.equal(canMove('paga', 'vencida'), false);
  assert.equal(canMove('paga', 'confirmada'), false);
  assert.equal(canMove('paga', 'estornada'), true);
  assert.equal(canMove('estornada', 'paga'), false);
  assert.equal(canMove('cancelada', 'pendente'), true);
});
