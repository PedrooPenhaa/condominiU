import { AsaasError, type AsaasClient, type SplitRule } from '../asaas/client.ts';
import { withTenant, type Row } from '../db/index.ts';
import { condominiumAsaas, type Deps } from '../deps.ts';
import { badRequest, conflict, HttpError, notFound } from '../errors.ts';
import { audit } from './audit.ts';

export interface GenerateInput {
  competence: string;
  dueDate: string;
  description?: string;
}

export interface GenerateResult {
  created: number;
  alreadyExisting: number;
  failed: Array<{ unit: string; reason: string }>;
  withoutPayer: string[];
}

const unitLabel = (row: Row) => (row.block ? `${row.block} ${row.number}` : String(row.number));
const MIN_MARGIN_CENTS = 300;

function splitFor(deps: Deps, condominium: Row, valueCents: number): SplitRule[] | undefined {
  if (condominium.fee_split_type === 'none') return undefined;
  const walletId = deps.config.asaasWalletId;
  if (!walletId) throw new HttpError(500, 'carteira_nao_configurada', 'Configure ASAAS_WALLET_ID para receber repasses.');
  if (condominium.fee_split_type === 'fixed') {
    if (condominium.fee_split_value + MIN_MARGIN_CENTS >= valueCents) {
      throw new HttpError(409, 'repasse_excede', 'O repasse fixo não cabe no valor desta cobrança.');
    }
    return [{ walletId, fixedValue: condominium.fee_split_value / 100 }];
  }
  return [{ walletId, percentualValue: condominium.fee_split_value / 100 }];
}

async function ensureCustomer(deps: Deps, asaas: AsaasClient, condominiumId: string, resident: Row) {
  if (resident.asaas_customer_id) return resident.asaas_customer_id as string;
  const customer = await asaas.createCustomer({
    name: resident.name,
    cpfCnpj: resident.cpf_cnpj,
    email: resident.email,
    mobilePhone: resident.mobile_phone,
    externalReference: resident.id,
  });
  await withTenant(deps.db, condominiumId, (c) =>
    c.query(`UPDATE residents SET asaas_customer_id = $2 WHERE id = $1`, [resident.id, customer.id]),
  );
  return customer.id;
}

/**
 * Emite uma cobrança já reservada no banco. O id interno vai como referência externa:
 * se uma tentativa anterior caiu no meio, procura antes de criar, evitando cobrar duas vezes.
 */
async function issue(deps: Deps, asaas: AsaasClient, condominium: Row, charge: Row, resident: Row) {
  try {
    const previous = charge.last_error ? await asaas.findPaymentByReference(charge.id) : null;
    const payment =
      previous ??
      (await asaas.createPayment({
        customer: await ensureCustomer(deps, asaas, condominium.id, resident),
        billingType: 'UNDEFINED',
        valueCents: charge.value_cents,
        dueDate: charge.due_date,
        description: charge.description,
        externalReference: charge.id,
        split: splitFor(deps, condominium, charge.value_cents),
      }));
    await withTenant(deps.db, condominium.id, (c) =>
      c.query(
        `UPDATE charges SET asaas_payment_id = $2, invoice_url = $3, status = 'pendente', last_error = NULL,
           split_type = $4, split_value = $5, updated_at = now() WHERE id = $1 AND status IN ('criando', 'falhou')`,
        [charge.id, payment.id, payment.invoiceUrl ?? null, condominium.fee_split_type, condominium.fee_split_value],
      ),
    );
    return null;
  } catch (error) {
    const message = (error as Error).message;
    // Se não dá para saber se o Asaas criou, fica em "criando" para a próxima tentativa procurar antes.
    const uncertain = error instanceof AsaasError && error.uncertain;
    await withTenant(deps.db, condominium.id, (c) =>
      c.query(`UPDATE charges SET status = $2, last_error = $3, updated_at = now() WHERE id = $1`, [
        charge.id, uncertain ? 'criando' : 'falhou', message,
      ]),
    );
    return message;
  }
}

export function assertCanCharge(condominium: Row) {
  if (condominium.status !== 'ativo') {
    throw new HttpError(409, 'condominio_inativo', 'As cobranças ficam disponíveis depois que a conta de recebimento for aprovada e enquanto o condomínio estiver ativo.');
  }
}

export async function generateCharges(deps: Deps, condominium: Row, input: GenerateInput, actorId: string | null): Promise<GenerateResult> {
  assertCanCharge(condominium);
  if (input.dueDate < new Date().toISOString().slice(0, 10)) throw badRequest('O vencimento não pode estar no passado.');
  const asaas = condominiumAsaas(deps, condominium);
  const description = input.description?.trim() || `Taxa condominial ${input.competence.slice(5)}/${input.competence.slice(0, 4)}`;

  const units = await withTenant(deps.db, condominium.id, (c) =>
    c.query(
      `SELECT u.*, r.id AS resident_id FROM units u
       LEFT JOIN residents r ON r.unit_id = u.id AND r.is_payer
       WHERE u.active AND u.fee_cents > 0 ORDER BY u.block, u.number`,
    ),
  );
  const result: GenerateResult = { created: 0, alreadyExisting: 0, failed: [], withoutPayer: [] };

  for (const unit of units) {
    if (!unit.resident_id) {
      result.withoutPayer.push(unitLabel(unit));
      continue;
    }
    const { charge, inserted, resident } = await withTenant(deps.db, condominium.id, async (c) => {
      const [fresh] = await c.query(
        `INSERT INTO charges (condominium_id, unit_id, resident_id, competence, description, value_cents, due_date)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (condominium_id, unit_id, competence, description) DO NOTHING RETURNING *`,
        [condominium.id, unit.id, unit.resident_id, input.competence, description, unit.fee_cents, input.dueDate],
      );
      const [existing] = fresh
        ? [fresh]
        : await c.query(`SELECT * FROM charges WHERE unit_id = $1 AND competence = $2 AND description = $3`, [unit.id, input.competence, description]);
      const [payer] = await c.query(`SELECT * FROM residents WHERE id = $1`, [unit.resident_id]);
      return { charge: existing!, inserted: Boolean(fresh), resident: payer! };
    });
    if (!inserted && !['criando', 'falhou'].includes(charge.status)) {
      result.alreadyExisting += 1;
      continue;
    }
    let failure: string | null;
    try {
      failure = await issue(deps, asaas, condominium, charge, resident);
    } catch (error) {
      failure = (error as Error).message;
    }
    if (failure) result.failed.push({ unit: unitLabel(unit), reason: failure });
    else result.created += 1;
  }
  await withTenant(deps.db, condominium.id, (c) =>
    audit(c, {
      condominiumId: condominium.id,
      actorId,
      action: 'cobrancas.geradas',
      details: { competence: input.competence, created: result.created, failed: result.failed.length },
    }),
  );
  return result;
}

export async function cancelCharge(deps: Deps, condominium: Row, chargeId: string, actorId: string | null) {
  const [charge] = await withTenant(deps.db, condominium.id, (c) => c.query(`SELECT * FROM charges WHERE id = $1`, [chargeId]));
  if (!charge) throw notFound('Cobrança não encontrada.');
  if (!['pendente', 'vencida', 'criando', 'falhou'].includes(charge.status)) {
    throw conflict('Só é possível cancelar cobranças que ainda não foram pagas.');
  }
  if (charge.asaas_payment_id) await condominiumAsaas(deps, condominium).deletePayment(charge.asaas_payment_id);
  return withTenant(deps.db, condominium.id, async (c) => {
    const [updated] = await c.query(`UPDATE charges SET status = 'cancelada', updated_at = now() WHERE id = $1 RETURNING *`, [chargeId]);
    await audit(c, { condominiumId: condominium.id, actorId, action: 'cobranca.cancelada', details: { chargeId } });
    return updated;
  });
}

export function listCharges(deps: Deps, condominiumId: string, competence: string) {
  return withTenant(deps.db, condominiumId, (c) =>
    c.query(
      `SELECT ch.*, u.block, u.number, r.name AS payer_name
       FROM charges ch JOIN units u ON u.id = ch.unit_id LEFT JOIN residents r ON r.id = ch.resident_id
       WHERE ch.competence = $1 ORDER BY u.block, u.number`,
      [competence],
    ),
  );
}

export function condominiumSummary(deps: Deps, condominiumId: string, competence: string) {
  return withTenant(deps.db, condominiumId, async (c) => {
    const [charges] = await c.query(
      `SELECT
         coalesce(sum(value_cents) FILTER (WHERE status NOT IN ('cancelada', 'estornada', 'falhou')), 0)::int AS expected_cents,
         coalesce(sum(value_cents) FILTER (WHERE status IN ('paga', 'confirmada')), 0)::int AS paid_cents,
         coalesce(sum(value_cents) FILTER (WHERE status = 'vencida'), 0)::int AS overdue_cents,
         count(*) FILTER (WHERE status IN ('paga', 'confirmada'))::int AS paid_count,
         count(*) FILTER (WHERE status = 'vencida')::int AS overdue_count,
         count(*) FILTER (WHERE status = 'pendente')::int AS pending_count,
         count(*) FILTER (WHERE status IN ('falhou', 'criando'))::int AS failed_count
       FROM charges WHERE competence = $1`,
      [competence],
    );
    const tiles = await c.query(
      `SELECT u.id, u.block, u.number, u.kind, u.fee_cents, r.name AS payer_name, r.id AS resident_id,
              ch.id AS charge_id, ch.status AS charge_status, ch.invoice_url, ch.value_cents, ch.due_date, ch.last_error
       FROM units u
       LEFT JOIN residents r ON r.unit_id = u.id AND r.is_payer
       LEFT JOIN LATERAL (
         SELECT * FROM charges x WHERE x.unit_id = u.id AND x.competence = $1 AND x.status NOT IN ('cancelada')
         ORDER BY x.created_at DESC LIMIT 1
       ) ch ON true
       WHERE u.active ORDER BY u.block, length(u.number), u.number`,
      [competence],
    );
    return { ...charges, tiles };
  });
}
