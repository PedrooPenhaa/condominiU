import type { AsaasPayment } from '../asaas/client.ts';
import { withPlatform, type Client, type Row } from '../db/index.ts';
import type { Deps } from '../deps.ts';
import { unauthorized } from '../errors.ts';
import { safeEqual, sha256 } from '../security.ts';
import { applyApproval } from './condominiums.ts';
import { canMove, computeSplitCents, stateForEvent, toCents, type PaymentState } from './payment-state.ts';

interface AsaasEvent {
  id: string;
  event: string;
  payment?: AsaasPayment;
  [key: string]: unknown;
}

function paidAt(payment: AsaasPayment) {
  return payment.confirmedDate ?? payment.paymentDate ?? payment.clientPaymentDate ?? new Date().toISOString();
}

export async function authorizeWebhook(deps: Deps, source: 'platform' | 'condominium', condominiumId: string | null, token: string | null) {
  if (!token) throw unauthorized('Token do webhook ausente.');
  if (source === 'platform') {
    if (!safeEqual(token, deps.config.asaasWebhookToken)) throw unauthorized('Token do webhook inválido.');
    return;
  }
  const [row] = await withPlatform(deps.db, (c) =>
    c.query(`SELECT asaas_webhook_token_hash FROM condominiums WHERE id = $1`, [condominiumId]),
  );
  if (!row?.asaas_webhook_token_hash || !safeEqual(sha256(token), row.asaas_webhook_token_hash)) {
    throw unauthorized('Token do webhook inválido.');
  }
}

/** Grava o evento antes de processar. Reenvios do mesmo evento são ignorados aqui. */
export async function receiveWebhook(deps: Deps, source: 'platform' | 'condominium', condominiumId: string | null, event: AsaasEvent) {
  const eventId = event.id || sha256(JSON.stringify(event));
  const [stored] = await withPlatform(deps.db, (c) =>
    c.query(
      `INSERT INTO webhook_events (source, condominium_id, event_id, event_type, payload)
       VALUES ($1, $2, $3, $4, $5) ON CONFLICT (source, event_id) DO NOTHING RETURNING id`,
      [source, condominiumId, eventId, event.event ?? 'DESCONHECIDO', event],
    ),
  );
  if (!stored) return { duplicate: true };
  await processStored(deps, stored.id);
  return { duplicate: false };
}

export async function processStored(deps: Deps, eventRowId: string) {
  const [row] = await withPlatform(deps.db, (c) => c.query(`SELECT * FROM webhook_events WHERE id = $1`, [eventRowId]));
  if (!row || row.status === 'processado') return;
  try {
    await dispatch(deps, row);
    await withPlatform(deps.db, (c) =>
      c.query(`UPDATE webhook_events SET status = 'processado', processed_at = now(), attempts = attempts + 1, error = NULL WHERE id = $1`, [eventRowId]),
    );
  } catch (error) {
    await withPlatform(deps.db, (c) =>
      c.query(`UPDATE webhook_events SET status = 'falhou', attempts = attempts + 1, error = $2 WHERE id = $1`, [eventRowId, (error as Error).message]),
    );
  }
}

async function dispatch(deps: Deps, row: Row) {
  const event = row.payload as AsaasEvent;
  if (event.event?.startsWith('ACCOUNT_STATUS_GENERAL_APPROVAL_') && row.condominium_id) {
    await applyApproval(deps, row.condominium_id, event.event.replace('ACCOUNT_STATUS_GENERAL_APPROVAL_', ''));
    return;
  }
  if (!event.payment) return;
  await withPlatform(deps.db, (client) =>
    row.source === 'platform'
      ? applyPlatformInvoice(client, event)
      : applyCharge(client, row.condominium_id, event),
  );
}

async function applyCharge(client: Client, condominiumId: string, event: AsaasEvent) {
  const payment = event.payment!;
  const [charge] = await client.query(
    `SELECT * FROM charges WHERE condominium_id = $1
       AND (asaas_payment_id = $2 OR id::text = $3) ORDER BY asaas_payment_id = $2 DESC NULLS LAST LIMIT 1`,
    [condominiumId, payment.id, payment.externalReference ?? ''],
  );
  // Cobrança criada direto no painel do Asaas, fora do sistema: guarda o evento e não altera nada.
  if (!charge) return;

  if (event.event === 'PAYMENT_SPLIT_DIVERGENCE_BLOCK' || event.event === 'PAYMENT_SPLIT_CANCELLED') {
    await client.query(`UPDATE charges SET last_error = $2, updated_at = now() WHERE id = $1`, [
      charge.id, event.event === 'PAYMENT_SPLIT_CANCELLED' ? 'O repasse desta cobrança foi cancelado.' : 'O repasse excede o valor líquido. Ajuste em até 2 dias úteis.',
    ]);
    return;
  }

  const next = stateForEvent(event.event);
  const netCents = toCents(payment.netValue);
  if (event.event === 'PAYMENT_UPDATED' && payment.dueDate) {
    await client.query(`UPDATE charges SET due_date = $2, value_cents = $3, updated_at = now() WHERE id = $1`, [
      charge.id, payment.dueDate, toCents(payment.value) ?? charge.value_cents,
    ]);
    return;
  }
  if (!next || !canMove(charge.status as PaymentState, next)) return;

  const settled = next === 'paga' || next === 'confirmada';
  const reversed = next === 'estornada';
  await client.query(
    `UPDATE charges SET status = $2, asaas_payment_id = coalesce(asaas_payment_id, $3), net_cents = coalesce($4, net_cents),
       invoice_url = coalesce($5, invoice_url), paid_at = CASE WHEN $6 THEN coalesce(paid_at, $7::timestamptz) WHEN $8 THEN NULL ELSE paid_at END,
       split_cents = $9, updated_at = now()
     WHERE id = $1`,
    [charge.id, next, payment.id, netCents, payment.invoiceUrl ?? null, settled, paidAt(payment), reversed,
      settled ? computeSplitCents(charge.split_type, charge.split_value, netCents ?? charge.net_cents) : reversed ? 0 : charge.split_cents],
  );
}

async function applyPlatformInvoice(client: Client, event: AsaasEvent) {
  const payment = event.payment!;
  const [condominium] = await client.query(
    `SELECT id FROM condominiums
     WHERE ($1::text IS NOT NULL AND platform_subscription_id = $1) OR id::text = $2 LIMIT 1`,
    [payment.subscription ?? null, payment.externalReference ?? ''],
  );
  if (!condominium) return;

  const next = stateForEvent(event.event) ?? (event.event === 'PAYMENT_CREATED' ? 'pendente' : null);
  const [existing] = await client.query(`SELECT * FROM platform_invoices WHERE asaas_payment_id = $1`, [payment.id]);
  if (!existing) {
    await client.query(
      `INSERT INTO platform_invoices (condominium_id, asaas_payment_id, value_cents, due_date, status, invoice_url, paid_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [condominium.id, payment.id, toCents(payment.value), payment.dueDate, next ?? 'pendente', payment.invoiceUrl ?? null,
        next === 'paga' || next === 'confirmada' ? paidAt(payment) : null],
    );
    return;
  }
  if (!next || next === existing.status || !canMove(existing.status as PaymentState, next)) return;
  await client.query(
    `UPDATE platform_invoices SET status = $2, invoice_url = coalesce($3, invoice_url),
       paid_at = CASE WHEN $4 THEN coalesce(paid_at, $5::timestamptz) ELSE paid_at END, updated_at = now()
     WHERE id = $1`,
    [existing.id, next, payment.invoiceUrl ?? null, next === 'paga' || next === 'confirmada', paidAt(payment)],
  );
}
