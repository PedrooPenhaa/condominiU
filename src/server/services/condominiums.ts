import { CONDOMINIUM_WEBHOOK_EVENTS, AsaasError } from '../asaas/client.ts';
import { withPlatform, type Client, type Row } from '../db/index.ts';
import { condominiumAsaas, platformAsaas, publicUrl, type Deps } from '../deps.ts';
import { badRequest, conflict, HttpError, notFound } from '../errors.ts';
import { encryptSecret, hashPassword, normalizeTaxId, randomToken, sha256 } from '../security.ts';
import { validSlug } from '../tenancy.ts';
import { audit } from './audit.ts';

export interface CondominiumInput {
  name: string;
  slug: string;
  kind: 'predio' | 'casas' | 'misto';
  hasConcierge: boolean;
  legalNature: 'condominio_edilicio' | 'associacao' | 'outro';
  cnpj: string;
  email: string;
  mobilePhone: string;
  address: string;
  addressNumber: string;
  complement?: string;
  province: string;
  postalCode: string;
  monthlyIncomeCents: number;
  feeMonthlyCents: number;
  feeSplitType: 'none' | 'fixed' | 'percent';
  feeSplitValue: number;
  billingDueDay: number;
  managerName: string;
  managerEmail: string;
}

function checkSplit(type: string, value: number) {
  if (type === 'percent' && (value <= 0 || value > 2000)) throw badRequest('O repasse percentual precisa ficar entre 0,01% e 20%.');
  if (type === 'fixed' && value <= 0) throw badRequest('Informe o valor fixo do repasse.');
}

export async function createCondominium(deps: Deps, input: CondominiumInput, actorId: string) {
  if (!validSlug(input.slug)) throw badRequest('Use só letras minúsculas, números e hifens no endereço. Alguns nomes, como admin e api, são reservados.');
  const cnpj = normalizeTaxId(input.cnpj);
  if (!cnpj || cnpj.length !== 14) throw badRequest('Informe um CNPJ válido para o condomínio.');
  checkSplit(input.feeSplitType, input.feeSplitValue);
  const postalCode = input.postalCode.replace(/\D/g, '');
  if (postalCode.length !== 8) throw badRequest('Informe um CEP com 8 dígitos.');
  const temporaryPassword = randomToken(9);
  const passwordHash = await hashPassword(temporaryPassword);

  try {
    return await withPlatform(deps.db, async (client) => {
      const [condominium] = await client.query(
        `INSERT INTO condominiums (slug, name, kind, has_concierge, legal_nature, cnpj, email, mobile_phone, address,
           address_number, complement, province, postal_code, monthly_income_cents, fee_monthly_cents, fee_split_type,
           fee_split_value, billing_due_day)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18) RETURNING *`,
        [input.slug, input.name, input.kind, input.hasConcierge, input.legalNature, cnpj, input.email, input.mobilePhone,
          input.address, input.addressNumber, input.complement ?? null, input.province, postalCode, input.monthlyIncomeCents,
          input.feeMonthlyCents, input.feeSplitType, input.feeSplitValue, input.billingDueDay],
      );
      const access = await grantAccess(client, {
        email: input.managerEmail,
        name: input.managerName,
        passwordHash,
        condominiumId: condominium!.id,
        role: 'sindico',
      });
      await audit(client, { condominiumId: condominium!.id, actorId, action: 'condominio.criado', details: { slug: input.slug } });
      return {
        condominium: publicCondominium(deps, condominium!),
        manager: { email: input.managerEmail, temporaryPassword: access.createdUser ? temporaryPassword : null },
      };
    });
  } catch (error) {
    const pgError = error as { code?: string; message: string };
    if (pgError.code === '23505') {
      if (pgError.message.includes('cnpj')) throw conflict('Já existe um condomínio ativo com este CNPJ.');
      throw conflict('Este endereço já está em uso. Escolha outro.');
    }
    throw error;
  }
}

/** Dá acesso a uma pessoa; cria o usuário quando o e-mail ainda não existe. Roda com visão da plataforma. */
export async function grantAccess(
  client: Client,
  input: { email: string; name: string; passwordHash: string; condominiumId: string; role: string; unitId?: string | null },
) {
  const [existing] = await client.query(`SELECT id FROM users WHERE lower(email) = lower($1)`, [input.email]);
  let userId = existing?.id as string | undefined;
  if (!userId) {
    const [user] = await client.query(
      `INSERT INTO users (email, name, password_hash) VALUES ($1, $2, $3) RETURNING id`,
      [input.email.toLowerCase(), input.name, input.passwordHash],
    );
    userId = user!.id;
  }
  await client.query(
    `INSERT INTO memberships (user_id, condominium_id, role, unit_id) VALUES ($1, $2, $3, $4)
     ON CONFLICT (user_id, condominium_id) DO UPDATE SET role = EXCLUDED.role, unit_id = EXCLUDED.unit_id`,
    [userId, input.condominiumId, input.role, input.unitId ?? null],
  );
  return { userId: userId!, createdUser: !existing };
}

/** Remove segredos antes de enviar ao navegador. */
export function publicCondominium(deps: Deps, row: Row) {
  const { asaas_api_key_enc, asaas_webhook_token_hash, ...safe } = row;
  return {
    ...safe,
    has_receiving_account: Boolean(asaas_api_key_enc),
    panel_url: publicUrl(deps, row.slug),
  };
}

async function load(deps: Deps, id: string) {
  const [row] = await withPlatform(deps.db, (c) => c.query(`SELECT * FROM condominiums WHERE id = $1`, [id]));
  if (!row) throw notFound('Condomínio não encontrado.');
  return row;
}

/** Tipos aceitos pelo Asaas hoje; não há um tipo específico para condomínio. Confirme o enquadramento com o Asaas. */
function companyTypeFor(legalNature: string) {
  return legalNature === 'associacao' ? 'ASSOCIATION' : undefined;
}

/** Cria a conta de recebimento do condomínio: uma subconta Asaas no CNPJ dele. */
export async function provisionReceivingAccount(deps: Deps, id: string, actorId: string) {
  const row = await load(deps, id);
  if (row.asaas_account_id) throw conflict('Este condomínio já tem conta de recebimento.');
  const webhookToken = randomToken(48);
  const account = await platformAsaas(deps).createSubaccount({
    name: row.name,
    email: row.email,
    cpfCnpj: row.cnpj,
    mobilePhone: row.mobile_phone,
    incomeValue: row.monthly_income_cents / 100,
    companyType: companyTypeFor(row.legal_nature),
    address: row.address,
    addressNumber: row.address_number,
    complement: row.complement,
    province: row.province,
    postalCode: row.postal_code,
    webhooks: [{
      name: 'Sistema de gestão',
      url: publicUrl(deps, 'admin', `/webhooks/asaas/condominium/${row.id}`),
      email: row.email,
      enabled: true,
      interrupted: false,
      apiVersion: 3,
      authToken: webhookToken,
      sendType: 'SEQUENTIALLY',
      events: CONDOMINIUM_WEBHOOK_EVENTS,
    }],
  });
  // A chave só aparece nesta resposta do Asaas. Se a gravação falhar, tenta de novo antes de desistir.
  const save = () =>
    withPlatform(deps.db, async (client) => {
      const [updated] = await client.query(
        `UPDATE condominiums SET asaas_account_id = $2, asaas_wallet_id = $3, asaas_api_key_enc = $4,
           asaas_webhook_token_hash = $5, asaas_approval = 'em_analise', status = 'aguardando_aprovacao', updated_at = now()
         WHERE id = $1 RETURNING *`,
        [id, account.id, account.walletId, encryptSecret(account.apiKey, deps.config.encryptionKey), sha256(webhookToken)],
      );
      await audit(client, { condominiumId: id, actorId, action: 'condominio.conta_criada', details: { accountId: account.id } });
      return updated!;
    });
  const saved = await save().catch(async (error) => {
    console.error(`CRÍTICO: subconta ${account.id} criada e não gravada para o condomínio ${id}`, error);
    return save();
  });
  return publicCondominium(deps, saved);
}

export async function syncApproval(deps: Deps, id: string) {
  const row = await load(deps, id);
  const status = await condominiumAsaas(deps, row).accountStatus();
  return applyApproval(deps, row.id, status.general ?? 'PENDING');
}

export async function applyApproval(deps: Deps, id: string, general: string) {
  const labels: Record<string, string> = {
    APPROVED: 'aprovada', AWAITING_APPROVAL: 'em_analise', PENDING: 'pendente', REJECTED: 'reprovada',
  };
  const approval = labels[general] ?? 'pendente';
  return withPlatform(deps.db, async (client) => {
    const [row] = await client.query(
      `UPDATE condominiums SET asaas_approval = $2,
         status = CASE WHEN $2 = 'aprovada' AND status = 'aguardando_aprovacao' THEN 'ativo' ELSE status END,
         updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, approval],
    );
    return publicCondominium(deps, row!);
  });
}

function nextDueDate(day: number, now = new Date()) {
  const year = now.getUTCFullYear();
  const month = now.getUTCMonth();
  const candidate = new Date(Date.UTC(year, now.getUTCDate() >= day ? month + 1 : month, day));
  return candidate.toISOString().slice(0, 10);
}

/** Começa a cobrar a mensalidade fixa do condomínio, que entra na SUA conta Asaas. */
export async function startPlatformBilling(deps: Deps, id: string, actorId: string, billingType: 'UNDEFINED' | 'BOLETO' | 'PIX') {
  const row = await load(deps, id);
  if (row.platform_subscription_id) throw conflict('A mensalidade deste condomínio já está ativa.');
  if (row.fee_monthly_cents <= 0) throw badRequest('Defina o valor da mensalidade antes de começar a cobrança.');
  const asaas = platformAsaas(deps);
  let customerId = row.platform_customer_id as string | null;
  if (!customerId) {
    const customer = await asaas.createCustomer({
      name: row.name, cpfCnpj: row.cnpj, email: row.email, mobilePhone: row.mobile_phone, externalReference: row.id,
    });
    customerId = customer.id;
    await withPlatform(deps.db, (c) => c.query(`UPDATE condominiums SET platform_customer_id = $2 WHERE id = $1`, [id, customerId]));
  }
  const subscription = await asaas.createSubscription({
    customer: customerId,
    billingType,
    valueCents: row.fee_monthly_cents,
    nextDueDate: nextDueDate(row.billing_due_day),
    description: `Mensalidade do sistema: ${row.name}`,
    externalReference: row.id,
  });
  return withPlatform(deps.db, async (client) => {
    const [updated] = await client.query(
      `UPDATE condominiums SET platform_subscription_id = $2, updated_at = now() WHERE id = $1 RETURNING *`,
      [id, subscription.id],
    );
    await audit(client, { condominiumId: id, actorId, action: 'mensalidade.iniciada', details: { subscription: subscription.id } });
    return publicCondominium(deps, updated!);
  });
}

export async function updateFees(
  deps: Deps,
  id: string,
  actorId: string,
  input: { feeMonthlyCents: number; feeSplitType: string; feeSplitValue: number; billingDueDay: number },
) {
  checkSplit(input.feeSplitType, input.feeSplitValue);
  const row = await load(deps, id);
  if (row.platform_subscription_id && input.feeMonthlyCents > 0 && input.feeMonthlyCents !== row.fee_monthly_cents) {
    await platformAsaas(deps).updateSubscription(row.platform_subscription_id, { valueCents: input.feeMonthlyCents });
  }
  return withPlatform(deps.db, async (client) => {
    const [updated] = await client.query(
      `UPDATE condominiums SET fee_monthly_cents = $2, fee_split_type = $3, fee_split_value = $4, billing_due_day = $5, updated_at = now()
       WHERE id = $1 RETURNING *`,
      [id, input.feeMonthlyCents, input.feeSplitType, input.feeSplitValue, input.billingDueDay],
    );
    await audit(client, { condominiumId: id, actorId, action: 'condominio.valores_alterados', details: input });
    return publicCondominium(deps, updated!);
  });
}

const STATUS_MOVES: Record<string, string[]> = {
  rascunho: ['cancelado'],
  aguardando_aprovacao: ['cancelado'],
  ativo: ['suspenso', 'cancelado'],
  suspenso: ['ativo', 'cancelado'],
  cancelado: [],
};

export async function setStatus(deps: Deps, id: string, actorId: string, status: string) {
  const row = await load(deps, id);
  if (!STATUS_MOVES[row.status]?.includes(status)) {
    throw new HttpError(409, 'status_invalido', `Não é possível passar de ${row.status} para ${status}.`);
  }
  if (status === 'cancelado' && row.platform_subscription_id) {
    try {
      await platformAsaas(deps).cancelSubscription(row.platform_subscription_id);
    } catch (error) {
      if (!(error instanceof AsaasError) || error.status !== 404) throw error;
    }
  }
  return withPlatform(deps.db, async (client) => {
    const [updated] = await client.query(
      `UPDATE condominiums SET status = $2, platform_subscription_id = CASE WHEN $2 = 'cancelado' THEN NULL ELSE platform_subscription_id END,
         updated_at = now() WHERE id = $1 RETURNING *`,
      [id, status],
    );
    await audit(client, { condominiumId: id, actorId, action: 'condominio.status', details: { from: row.status, to: status } });
    return publicCondominium(deps, updated!);
  });
}

export function platformDashboard(deps: Deps) {
  return withPlatform(deps.db, async (client) => {
    const [totals] = await client.query(`
      SELECT
        count(*) FILTER (WHERE status <> 'cancelado')::int AS total,
        count(*) FILTER (WHERE status = 'ativo')::int AS active,
        count(*) FILTER (WHERE status IN ('rascunho', 'aguardando_aprovacao'))::int AS onboarding,
        count(*) FILTER (WHERE status = 'suspenso')::int AS suspended,
        coalesce(sum(fee_monthly_cents) FILTER (WHERE status = 'ativo' AND platform_subscription_id IS NOT NULL), 0)::int AS mrr_cents
      FROM condominiums`);
    const [invoices] = await client.query(`
      SELECT
        count(*) FILTER (WHERE status = 'vencida')::int AS overdue_count,
        coalesce(sum(value_cents) FILTER (WHERE status = 'vencida'), 0)::int AS overdue_cents,
        coalesce(sum(value_cents) FILTER (WHERE status = 'paga' AND paid_at >= date_trunc('month', now())), 0)::int AS paid_month_cents
      FROM platform_invoices`);
    const [split] = await client.query(`
      SELECT coalesce(sum(split_cents), 0)::int AS split_month_cents,
             coalesce(sum(value_cents), 0)::int AS volume_month_cents
      FROM charges WHERE status = 'paga' AND paid_at >= date_trunc('month', now())`);
    return { ...totals, ...invoices, ...split };
  });
}

export function listCondominiums(deps: Deps) {
  return withPlatform(deps.db, async (client) => {
    const rows = await client.query(`
      SELECT c.*,
        (SELECT count(*)::int FROM units u WHERE u.condominium_id = c.id AND u.active) AS unit_count,
        (SELECT count(*)::int FROM platform_invoices i WHERE i.condominium_id = c.id AND i.status = 'vencida') AS overdue_invoices
      FROM condominiums c ORDER BY c.created_at DESC`);
    return rows.map((row) => publicCondominium(deps, row));
  });
}

export async function condominiumDetail(deps: Deps, id: string) {
  return withPlatform(deps.db, async (client) => {
    const [row] = await client.query(`SELECT * FROM condominiums WHERE id = $1`, [id]);
    if (!row) throw notFound('Condomínio não encontrado.');
    const invoices = await client.query(
      `SELECT * FROM platform_invoices WHERE condominium_id = $1 ORDER BY due_date DESC LIMIT 24`, [id],
    );
    const managers = await client.query(
      `SELECT u.name, u.email, m.role FROM memberships m JOIN users u ON u.id = m.user_id
       WHERE m.condominium_id = $1 AND m.role IN ('sindico', 'gestor') ORDER BY u.name`, [id],
    );
    const [usage] = await client.query(
      `SELECT (SELECT count(*)::int FROM units WHERE condominium_id = $1 AND active) AS units,
              (SELECT coalesce(sum(value_cents), 0)::int FROM charges WHERE condominium_id = $1 AND status = 'paga') AS received_cents`,
      [id],
    );
    return { condominium: publicCondominium(deps, row), invoices, managers, usage };
  });
}

export function listPlatformInvoices(deps: Deps) {
  return withPlatform(deps.db, (client) =>
    client.query(`
      SELECT i.*, c.name AS condominium_name, c.slug
      FROM platform_invoices i JOIN condominiums c ON c.id = i.condominium_id
      ORDER BY CASE i.status WHEN 'vencida' THEN 0 WHEN 'pendente' THEN 1 ELSE 2 END, i.due_date DESC LIMIT 200`),
  );
}
