import { withPlatform, withTenant } from '../db/index.ts';
import { condominiumAsaas, type Deps } from '../deps.ts';
import { syncApproval } from './condominiums.ts';
import { canMove, computeSplitCents, stateForApiStatus, toCents, type PaymentState } from './payment-state.ts';
import { processStored } from './webhooks.ts';

/** Rotina periódica: reprocessa avisos com falha e confere o sistema com o Asaas. */
export async function runJobs(deps: Deps) {
  const result = { webhooksRetried: 0, chargesCorrected: 0, chargesChecked: 0, approvalsChecked: 0, errors: [] as string[] };

  const pending = await withPlatform(deps.db, (c) =>
    c.query(`SELECT id FROM webhook_events WHERE status <> 'processado' AND attempts < 10
             AND received_at < now() - interval '1 minute' ORDER BY received_at LIMIT 200`),
  );
  for (const row of pending) {
    await processStored(deps, row.id);
    result.webhooksRetried += 1;
  }

  const waiting = await withPlatform(deps.db, (c) =>
    c.query(`SELECT id FROM condominiums WHERE status = 'aguardando_aprovacao' AND asaas_api_key_enc IS NOT NULL`),
  );
  for (const row of waiting) {
    try {
      await syncApproval(deps, row.id);
      result.approvalsChecked += 1;
    } catch (error) {
      result.errors.push(`aprovação ${row.id}: ${(error as Error).message}`);
    }
  }

  const condominiums = await withPlatform(deps.db, (c) =>
    c.query(`SELECT * FROM condominiums WHERE asaas_api_key_enc IS NOT NULL AND status IN ('ativo', 'suspenso')`),
  );
  for (const condominium of condominiums) {
    const asaas = condominiumAsaas(deps, condominium);
    const open = await withTenant(deps.db, condominium.id, (c) =>
      c.query(`SELECT * FROM charges WHERE status IN ('pendente', 'confirmada', 'vencida') AND asaas_payment_id IS NOT NULL
               AND updated_at < now() - interval '6 hours' ORDER BY updated_at LIMIT 100`),
    );
    for (const charge of open) {
      try {
        const payment = await asaas.getPayment(charge.asaas_payment_id);
        result.chargesChecked += 1;
        const next = payment.deleted ? 'cancelada' : stateForApiStatus(payment.status);
        const moved = next && next !== charge.status && canMove(charge.status as PaymentState, next);
        const netCents = toCents(payment.netValue);
        await withTenant(deps.db, condominium.id, (c) =>
          c.query(
            `UPDATE charges SET status = $2, net_cents = coalesce($3, net_cents), split_cents = $4,
               paid_at = CASE WHEN $2 IN ('paga', 'confirmada') THEN coalesce(paid_at, now()) ELSE paid_at END, updated_at = now()
             WHERE id = $1`,
            [charge.id, moved ? next : charge.status, netCents,
              moved && (next === 'paga' || next === 'confirmada')
                ? computeSplitCents(charge.split_type, charge.split_value, netCents ?? charge.net_cents)
                : charge.split_cents],
          ),
        );
        if (moved) result.chargesCorrected += 1;
      } catch (error) {
        result.errors.push(`cobrança ${charge.id}: ${(error as Error).message}`);
      }
    }
  }

  await withPlatform(deps.db, (c) => c.query(`DELETE FROM sessions WHERE expires_at < now()`));
  return result;
}
