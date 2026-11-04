import { withPlatform, withTenant } from '../db/index.ts';
import type { Deps } from '../deps.ts';
import { badRequest, conflict, notFound } from '../errors.ts';
import { hashPassword, normalizeTaxId, randomToken } from '../security.ts';
import { audit } from './audit.ts';
import { grantAccess } from './condominiums.ts';

export interface PayerInput {
  name: string;
  cpfCnpj: string;
  email?: string | null;
  mobilePhone?: string | null;
}

export function listUnits(deps: Deps, condominiumId: string) {
  return withTenant(deps.db, condominiumId, (c) =>
    c.query(
      `SELECT u.*, r.id AS resident_id, r.name AS payer_name, r.email AS payer_email, r.mobile_phone AS payer_phone
       FROM units u LEFT JOIN residents r ON r.unit_id = u.id AND r.is_payer
       ORDER BY u.block, length(u.number), u.number`,
    ),
  );
}

export async function createUnit(
  deps: Deps,
  condominiumId: string,
  input: { kind: string; block: string; number: string; feeCents: number; payer?: PayerInput | null },
  actorId: string | null,
) {
  const taxId = input.payer ? normalizeTaxId(input.payer.cpfCnpj) : null;
  if (input.payer && !taxId) throw badRequest(`CPF ou CNPJ inválido para ${input.payer.name}.`);
  try {
    return await withTenant(deps.db, condominiumId, async (c) => {
      const [unit] = await c.query(
        `INSERT INTO units (condominium_id, kind, block, number, fee_cents) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
        [condominiumId, input.kind, input.block.trim(), input.number.trim(), input.feeCents],
      );
      if (input.payer) {
        await c.query(
          `INSERT INTO residents (condominium_id, unit_id, name, cpf_cnpj, email, mobile_phone) VALUES ($1, $2, $3, $4, $5, $6)`,
          [condominiumId, unit!.id, input.payer.name, taxId, input.payer.email || null, input.payer.mobilePhone || null],
        );
      }
      await audit(c, { condominiumId, actorId, action: 'unidade.criada', details: { unit: unit!.id } });
      return unit!;
    });
  } catch (error) {
    if ((error as { code?: string }).code === '23505') {
      throw conflict(`A unidade ${input.block} ${input.number} já existe.`.replace('  ', ' '));
    }
    throw error;
  }
}

/** Importa unidades coladas de uma planilha. Colunas: bloco; número; valor; pagador; CPF; e-mail; celular. */
export async function importUnits(deps: Deps, condominiumId: string, kind: string, text: string, actorId: string | null) {
  const created: string[] = [];
  const errors: Array<{ line: number; reason: string }> = [];
  const lines = text.split(/\r?\n/);
  for (const [index, raw] of lines.entries()) {
    if (!raw.trim()) continue;
    const parts = raw.split(/[;\t]/).map((p) => p.trim());
    const [block = '', number = '', value = '', name, cpf, email, phone] = parts;
    const lineNumber = index + 1;
    if (/^(bloco|quadra)/i.test(block) && /n[uú]mero/i.test(number)) continue;
    const feeCents = Math.round(Number(value.replace(/\./g, '').replace(',', '.')) * 100);
    if (!number || !Number.isFinite(feeCents) || feeCents < 0) {
      errors.push({ line: lineNumber, reason: 'Informe número e valor válidos.' });
      continue;
    }
    try {
      await createUnit(
        deps,
        condominiumId,
        { kind, block, number, feeCents, payer: name && cpf ? { name, cpfCnpj: cpf, email, mobilePhone: phone } : null },
        actorId,
      );
      created.push(`${block} ${number}`.trim());
    } catch (error) {
      errors.push({ line: lineNumber, reason: (error as Error).message });
    }
  }
  return { created: created.length, errors };
}

export async function updateUnit(
  deps: Deps,
  condominiumId: string,
  id: string,
  input: { feeCents: number; active: boolean },
  actorId: string | null,
) {
  return withTenant(deps.db, condominiumId, async (c) => {
    const [unit] = await c.query(`UPDATE units SET fee_cents = $2, active = $3 WHERE id = $1 RETURNING *`, [id, input.feeCents, input.active]);
    if (!unit) throw notFound('Unidade não encontrada.');
    await audit(c, { condominiumId, actorId, action: 'unidade.alterada', details: { unit: id, ...input } });
    return unit;
  });
}

/** Define quem paga a unidade. Quem assume recebe um novo cadastro de cliente no Asaas. */
export async function setPayer(deps: Deps, condominiumId: string, unitId: string, input: PayerInput, actorId: string | null) {
  const taxId = normalizeTaxId(input.cpfCnpj);
  if (!taxId) throw badRequest('Informe um CPF ou CNPJ válido.');
  return withTenant(deps.db, condominiumId, async (c) => {
    const [unit] = await c.query(`SELECT id FROM units WHERE id = $1`, [unitId]);
    if (!unit) throw notFound('Unidade não encontrada.');
    const [current] = await c.query(`SELECT * FROM residents WHERE unit_id = $1 AND is_payer`, [unitId]);
    let resident;
    if (current && current.cpf_cnpj === taxId) {
      [resident] = await c.query(
        `UPDATE residents SET name = $2, email = $3, mobile_phone = $4 WHERE id = $1 RETURNING *`,
        [current.id, input.name, input.email || null, input.mobilePhone || null],
      );
    } else {
      if (current) await c.query(`UPDATE residents SET is_payer = false WHERE id = $1`, [current.id]);
      [resident] = await c.query(
        `INSERT INTO residents (condominium_id, unit_id, name, cpf_cnpj, email, mobile_phone) VALUES ($1, $2, $3, $4, $5, $6) RETURNING *`,
        [condominiumId, unitId, input.name, taxId, input.email || null, input.mobilePhone || null],
      );
    }
    await audit(c, { condominiumId, actorId, action: 'unidade.pagador', details: { unit: unitId } });
    return resident;
  });
}

export async function addMember(
  deps: Deps,
  condominiumId: string,
  input: { name: string; email: string; role: string; unitId?: string | null },
  actorId: string | null,
) {
  if (input.role === 'morador' && !input.unitId) throw badRequest('Escolha a unidade do morador.');
  const temporaryPassword = randomToken(9);
  const passwordHash = await hashPassword(temporaryPassword);
  return withPlatform(deps.db, async (c) => {
    if (input.unitId) {
      const [unit] = await c.query(`SELECT id FROM units WHERE id = $1 AND condominium_id = $2`, [input.unitId, condominiumId]);
      if (!unit) throw notFound('Unidade não encontrada.');
    }
    const access = await grantAccess(c, { ...input, passwordHash, condominiumId, unitId: input.unitId ?? null });
    await audit(c, { condominiumId, actorId, action: 'acesso.concedido', details: { role: input.role, email: input.email } });
    return { email: input.email, temporaryPassword: access.createdUser ? temporaryPassword : null };
  });
}

export function listMembers(deps: Deps, condominiumId: string) {
  return withPlatform(deps.db, (c) =>
    c.query(
      `SELECT m.id, m.role, m.unit_id, u.name, u.email, un.block, un.number
       FROM memberships m JOIN users u ON u.id = m.user_id LEFT JOIN units un ON un.id = m.unit_id
       WHERE m.condominium_id = $1 ORDER BY m.role, u.name`,
      [condominiumId],
    ),
  );
}
