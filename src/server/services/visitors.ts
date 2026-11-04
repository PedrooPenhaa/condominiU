import { randomInt } from 'node:crypto';
import { withTenant } from '../db/index.ts';
import type { Deps } from '../deps.ts';
import { conflict, forbidden, notFound } from '../errors.ts';
import { audit } from './audit.ts';

/**
 * Passe de visitante. Com porteiro, a portaria confere o código. Sem porteiro,
 * o morador registra a entrada. A abertura de portão eletrônico fica para o aplicativo.
 */
export async function createPass(
  deps: Deps,
  condominiumId: string,
  input: { unitId: string; visitorName: string; validHours: number },
  actorId: string | null,
) {
  return withTenant(deps.db, condominiumId, async (c) => {
    const [unit] = await c.query(`SELECT id FROM units WHERE id = $1`, [input.unitId]);
    if (!unit) throw notFound('Unidade não encontrada.');
    for (let attempt = 0; attempt < 5; attempt++) {
      const code = String(randomInt(100000, 1000000));
      const [pass] = await c.query(
        `INSERT INTO visitor_passes (condominium_id, unit_id, created_by, visitor_name, code, valid_until)
         VALUES ($1, $2, $3, $4, $5, now() + ($6 || ' hours')::interval)
         ON CONFLICT (condominium_id, code) DO NOTHING RETURNING *`,
        [condominiumId, input.unitId, actorId, input.visitorName, code, String(input.validHours)],
      );
      if (pass) return pass;
    }
    throw conflict('Não foi possível gerar o código. Tente de novo.');
  });
}

export function listPasses(deps: Deps, condominiumId: string, unitId?: string | null) {
  return withTenant(deps.db, condominiumId, (c) =>
    c.query(
      `SELECT v.*, u.block, u.number, (v.status = 'autorizado' AND v.valid_until < now()) AS expired
       FROM visitor_passes v JOIN units u ON u.id = v.unit_id
       WHERE ($1::uuid IS NULL OR v.unit_id = $1) AND v.created_at > now() - interval '30 days'
       ORDER BY v.created_at DESC LIMIT 100`,
      [unitId ?? null],
    ),
  );
}

export async function checkIn(
  deps: Deps,
  condominiumId: string,
  code: string,
  actor: { id: string; role: string; unitId: string | null },
) {
  return withTenant(deps.db, condominiumId, async (c) => {
    const [pass] = await c.query(`SELECT * FROM visitor_passes WHERE code = $1`, [code.trim()]);
    if (!pass) throw notFound('Código não encontrado.');
    if (actor.role === 'morador' && pass.unit_id !== actor.unitId) throw forbidden('Este código é de outra unidade.');
    if (pass.status !== 'autorizado') throw conflict(pass.status === 'entrou' ? 'Este código já foi usado.' : 'Este código foi cancelado.');
    if (new Date(pass.valid_until) < new Date()) throw conflict('Este código venceu.');
    const [updated] = await c.query(
      `UPDATE visitor_passes SET status = 'entrou', checked_in_at = now(), checked_in_by = $2 WHERE id = $1 RETURNING *`,
      [pass.id, actor.id],
    );
    await audit(c, { condominiumId, actorId: actor.id, action: 'visitante.entrada', details: { pass: pass.id } });
    return updated;
  });
}
