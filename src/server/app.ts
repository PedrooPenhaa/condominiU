import { z } from 'zod';
import * as auth from './auth.ts';
import { withPlatform, withTenant, type Row } from './db/index.ts';
import type { Deps } from './deps.ts';
import { badRequest, forbidden, HttpError, notFound, unauthorized } from './errors.ts';
import { safeEqual } from './security.ts';
import * as charges from './services/charges.ts';
import * as condominiums from './services/condominiums.ts';
import { runJobs } from './services/jobs.ts';
import * as units from './services/units.ts';
import * as visitors from './services/visitors.ts';
import { authorizeWebhook, receiveWebhook } from './services/webhooks.ts';
import { AsaasError } from './asaas/client.ts';
import { parseHost, slugify, type HostContext } from './tenancy.ts';

const MAX_BODY = 1024 * 1024;
const uuid = z.string().uuid();
const competence = z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'Use o mês no formato AAAA-MM.');
const dateText = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use a data no formato AAAA-MM-DD.');
const cents = z.number().int().min(0).max(100_000_000);
const text = (max = 200) => z.string().trim().min(1, 'Preencha todos os campos obrigatórios.').max(max);
const optionalText = (max = 200) => z.string().trim().max(max).nullish();

const condominiumSchema = z.object({
  name: text(),
  slug: text(50).optional(),
  kind: z.enum(['predio', 'casas', 'misto']),
  hasConcierge: z.boolean(),
  legalNature: z.enum(['condominio_edilicio', 'associacao', 'outro']),
  cnpj: text(20),
  email: z.string().email('Informe um e-mail válido para o condomínio.'),
  mobilePhone: text(20),
  address: text(),
  addressNumber: text(20),
  complement: optionalText(),
  province: text(),
  postalCode: text(10),
  monthlyIncomeCents: cents.refine((v) => v > 0, 'Informe a arrecadação mensal estimada.'),
  feeMonthlyCents: cents,
  feeSplitType: z.enum(['none', 'fixed', 'percent']),
  feeSplitValue: z.number().int().min(0).max(100_000),
  billingDueDay: z.number().int().min(1).max(28),
  managerName: text(),
  managerEmail: z.string().email('Informe um e-mail válido para o síndico.'),
});
const feesSchema = condominiumSchema.pick({ feeMonthlyCents: true, feeSplitType: true, feeSplitValue: true, billingDueDay: true });
const payerSchema = z.object({ name: text(), cpfCnpj: text(20), email: z.string().email('Informe um e-mail válido.').or(z.literal('')).nullish(), mobilePhone: optionalText(20) });
const unitSchema = z.object({
  kind: z.enum(['apartamento', 'casa', 'sala', 'lote']),
  block: z.string().trim().max(40).default(''),
  number: text(20),
  feeCents: cents,
  payer: payerSchema.nullish(),
});

interface Ctx {
  req: Request;
  url: URL;
  host: HostContext;
  params: string[];
  deps: Deps;
  token: string | null;
  viaCookie: boolean;
  user: Row | null;
  outHeaders: Headers;
}

type Scope = 'public' | 'user' | 'platform' | 'manager' | 'staff' | 'member';
interface Tenant {
  condominium: Row;
  role: string;
  unitId: string | null;
}
interface Route {
  method: string;
  pattern: RegExp;
  scope: Scope;
  handler: (ctx: Ctx, tenant: Tenant) => Promise<unknown>;
}

async function parse<T extends z.ZodTypeAny>(req: Request, schema: T): Promise<z.output<T>> {
  const raw = await req.text();
  if (raw.length > MAX_BODY) throw new HttpError(413, 'corpo_grande', 'O envio passou do limite de tamanho.');
  let body: unknown;
  try {
    body = raw ? JSON.parse(raw) : {};
  } catch {
    throw badRequest('O corpo da requisição precisa ser JSON válido.');
  }
  const result = schema.safeParse(body);
  if (!result.success) throw badRequest(result.error.issues[0]?.message ?? 'Dados inválidos.');
  return result.data;
}

function readToken(req: Request, deps: Deps): { token: string | null; viaCookie: boolean } {
  const header = req.headers.get('authorization');
  if (header?.startsWith('Bearer ')) return { token: header.slice(7), viaCookie: false };
  const name = auth.cookieName(deps);
  for (const part of (req.headers.get('cookie') ?? '').split(';')) {
    const [key, value] = part.trim().split('=');
    if (key === name && value) return { token: value, viaCookie: true };
  }
  return { token: null, viaCookie: false };
}

function hostHeader(req: Request, deps: Deps) {
  const forwarded = deps.config.trustProxy ? req.headers.get('x-forwarded-host') : null;
  return forwarded ?? req.headers.get('host') ?? new URL(req.url).host;
}

/** Bloqueia envios feitos por outros sites usando a sessão do navegador. */
function assertSameOrigin(req: Request, deps: Deps) {
  const origin = req.headers.get('origin');
  const expected = `${deps.config.publicProtocol}://${hostHeader(req, deps)}`;
  if (origin !== expected) throw new HttpError(403, 'origem_invalida', 'Envio bloqueado: origem não reconhecida.');
}

async function resolveTenant(ctx: Ctx): Promise<Tenant> {
  const slug = ctx.host.kind === 'tenant' ? ctx.host.slug : ctx.req.headers.get('x-condominium-slug');
  if (!slug) throw badRequest('Informe o condomínio pelo endereço ou pelo cabeçalho X-Condominium-Slug.');
  return withPlatform(ctx.deps.db, async (c) => {
    const [condominium] = await c.query(`SELECT * FROM condominiums WHERE slug = $1 AND status <> 'cancelado'`, [slug]);
    if (!condominium) throw notFound('Condomínio não encontrado.');
    if (ctx.user!.is_platform_admin) return { condominium, role: 'plataforma', unitId: null };
    const [membership] = await c.query(`SELECT role, unit_id FROM memberships WHERE user_id = $1 AND condominium_id = $2`, [ctx.user!.id, condominium.id]);
    if (!membership) throw forbidden('Seu usuário não tem acesso a este condomínio.');
    return { condominium, role: membership.role, unitId: membership.unit_id };
  });
}

const MANAGERS = new Set(['sindico', 'gestor', 'plataforma']);
const STAFF = new Set([...MANAGERS, 'porteiro']);

function assertNotSuspended(condominium: Row, method: string) {
  if (condominium.status === 'suspenso' && method !== 'GET') {
    throw new HttpError(402, 'condominio_suspenso', 'Este condomínio está suspenso. Fale com a administradora para reativar.');
  }
}

const routes: Route[] = [];
function route(method: string, path: string, scope: Scope, handler: Route['handler']) {
  const pattern = new RegExp(`^${path.replace(/:\w+/g, '([^/]+)')}$`);
  routes.push({ method, pattern, scope, handler });
}

// Público
route('GET', '/healthz', 'public', async () => ({ ok: true }));
route('GET', '/api/v1/context', 'public', async (ctx) => {
  const base = { host: ctx.host.kind, brand: ctx.deps.config.brandName, base_domain: ctx.deps.config.baseDomain };
  if (ctx.host.kind !== 'tenant') return base;
  const slug = ctx.host.slug;
  const [row] = await withPlatform(ctx.deps.db, (c) =>
    c.query(`SELECT name, slug, kind, has_concierge, status FROM condominiums WHERE slug = $1 AND status <> 'cancelado'`, [slug]),
  );
  if (!row) throw notFound('Este endereço não pertence a nenhum condomínio.');
  return { ...base, condominium: row };
});
route('POST', '/api/v1/auth/login', 'public', async (ctx) => {
  const input = await parse(ctx.req, z.object({
    email: z.string().email('Informe um e-mail válido.'),
    password: z.string().min(1, 'Informe a senha.').max(200),
    client: z.enum(['web', 'mobile']).default('web'),
  }));
  const session = await auth.login(ctx.deps, input, ctx.host);
  if (input.client === 'mobile') return { token: session.token, user: session.user };
  ctx.outHeaders.append('Set-Cookie', auth.sessionCookie(ctx.deps, session.token, session.days));
  return { user: session.user };
});

// Usuário autenticado
route('POST', '/api/v1/auth/logout', 'user', async (ctx) => {
  await auth.logout(ctx.deps, ctx.token!);
  ctx.outHeaders.append('Set-Cookie', auth.clearCookie(ctx.deps));
  return { ok: true };
});
route('POST', '/api/v1/auth/change-password', 'user', async (ctx) => {
  const input = await parse(ctx.req, z.object({
    current: z.string().min(1, 'Informe a senha atual.'),
    next: z.string().min(10, 'A nova senha precisa ter ao menos 10 caracteres.').max(200),
  }));
  await auth.changePassword(ctx.deps, ctx.user!, input.current, input.next, ctx.token!);
  return { ok: true };
});
route('GET', '/api/v1/me', 'user', async (ctx) => {
  const memberships = await withPlatform(ctx.deps.db, (c) =>
    c.query(
      `SELECT m.role, m.unit_id, c.id AS condominium_id, c.slug, c.name FROM memberships m
       JOIN condominiums c ON c.id = m.condominium_id WHERE m.user_id = $1 AND c.status <> 'cancelado' ORDER BY c.name`,
      [ctx.user!.id],
    ),
  );
  return { user: auth.publicUser(ctx.user!), memberships };
});

// Painel da administração
route('GET', '/api/v1/platform/dashboard', 'platform', (ctx) => condominiums.platformDashboard(ctx.deps));
route('GET', '/api/v1/platform/condominiums', 'platform', (ctx) => condominiums.listCondominiums(ctx.deps));
route('POST', '/api/v1/platform/condominiums', 'platform', async (ctx) => {
  const input = await parse(ctx.req, condominiumSchema);
  return condominiums.createCondominium(ctx.deps, { ...input, slug: input.slug ?? slugify(input.name), complement: input.complement ?? undefined }, ctx.user!.id);
});
route('GET', '/api/v1/platform/condominiums/:id', 'platform', (ctx) => condominiums.condominiumDetail(ctx.deps, uuid.parse(ctx.params[0])));
route('PATCH', '/api/v1/platform/condominiums/:id/fees', 'platform', async (ctx) =>
  condominiums.updateFees(ctx.deps, uuid.parse(ctx.params[0]), ctx.user!.id, await parse(ctx.req, feesSchema)));
route('POST', '/api/v1/platform/condominiums/:id/provision', 'platform', (ctx) =>
  condominiums.provisionReceivingAccount(ctx.deps, uuid.parse(ctx.params[0]), ctx.user!.id));
route('POST', '/api/v1/platform/condominiums/:id/sync-approval', 'platform', (ctx) =>
  condominiums.syncApproval(ctx.deps, uuid.parse(ctx.params[0])));
route('POST', '/api/v1/platform/condominiums/:id/billing', 'platform', async (ctx) => {
  const input = await parse(ctx.req, z.object({ billingType: z.enum(['UNDEFINED', 'BOLETO', 'PIX']).default('UNDEFINED') }));
  return condominiums.startPlatformBilling(ctx.deps, uuid.parse(ctx.params[0]), ctx.user!.id, input.billingType);
});
route('POST', '/api/v1/platform/condominiums/:id/status', 'platform', async (ctx) => {
  const input = await parse(ctx.req, z.object({ status: z.enum(['ativo', 'suspenso', 'cancelado']) }));
  return condominiums.setStatus(ctx.deps, uuid.parse(ctx.params[0]), ctx.user!.id, input.status);
});
route('GET', '/api/v1/platform/invoices', 'platform', (ctx) => condominiums.listPlatformInvoices(ctx.deps));

// Painel do condomínio
route('GET', '/api/v1/condo', 'member', async (_ctx, tenant) => {
  const { name, slug, kind, has_concierge, status, asaas_approval, id } = tenant.condominium;
  return { condominium: { id, name, slug, kind, has_concierge, status, asaas_approval }, role: tenant.role, unit_id: tenant.unitId };
});
route('GET', '/api/v1/condo/summary', 'manager', async (ctx, tenant) => {
  const month = competence.parse(ctx.url.searchParams.get('competence') ?? new Date().toISOString().slice(0, 7));
  return charges.condominiumSummary(ctx.deps, tenant.condominium.id, month);
});
route('GET', '/api/v1/condo/units', 'staff', (ctx, tenant) => units.listUnits(ctx.deps, tenant.condominium.id));
route('POST', '/api/v1/condo/units', 'manager', async (ctx, tenant) => {
  const input = await parse(ctx.req, unitSchema);
  return units.createUnit(ctx.deps, tenant.condominium.id, input as any, ctx.user!.id);
});
route('POST', '/api/v1/condo/units/import', 'manager', async (ctx, tenant) => {
  const input = await parse(ctx.req, z.object({ kind: z.enum(['apartamento', 'casa', 'sala', 'lote']), text: z.string().max(200_000) }));
  return units.importUnits(ctx.deps, tenant.condominium.id, input.kind, input.text, ctx.user!.id);
});
route('PATCH', '/api/v1/condo/units/:id', 'manager', async (ctx, tenant) => {
  const input = await parse(ctx.req, z.object({ feeCents: cents, active: z.boolean() }));
  return units.updateUnit(ctx.deps, tenant.condominium.id, uuid.parse(ctx.params[0]), input, ctx.user!.id);
});
route('PUT', '/api/v1/condo/units/:id/payer', 'manager', async (ctx, tenant) => {
  const input = await parse(ctx.req, payerSchema);
  return units.setPayer(ctx.deps, tenant.condominium.id, uuid.parse(ctx.params[0]), input, ctx.user!.id);
});
route('GET', '/api/v1/condo/charges', 'manager', async (ctx, tenant) =>
  charges.listCharges(ctx.deps, tenant.condominium.id, competence.parse(ctx.url.searchParams.get('competence') ?? new Date().toISOString().slice(0, 7))));
route('POST', '/api/v1/condo/charges/generate', 'manager', async (ctx, tenant) => {
  const input = await parse(ctx.req, z.object({ competence, dueDate: dateText, description: optionalText(100) }));
  return charges.generateCharges(ctx.deps, tenant.condominium, { ...input, description: input.description ?? undefined }, ctx.user!.id);
});
route('POST', '/api/v1/condo/charges/:id/cancel', 'manager', (ctx, tenant) =>
  charges.cancelCharge(ctx.deps, tenant.condominium, uuid.parse(ctx.params[0]), ctx.user!.id));
route('GET', '/api/v1/condo/my-charges', 'member', async (ctx, tenant) => {
  if (!tenant.unitId) return [];
  return withTenant(ctx.deps.db, tenant.condominium.id, (c) =>
    c.query(
      `SELECT id, competence, description, value_cents, due_date, status, invoice_url, paid_at
       FROM charges WHERE unit_id = $1 AND status NOT IN ('criando', 'falhou', 'cancelada') ORDER BY due_date DESC LIMIT 36`,
      [tenant.unitId],
    ),
  );
});
route('GET', '/api/v1/condo/members', 'manager', (ctx, tenant) => units.listMembers(ctx.deps, tenant.condominium.id));
route('POST', '/api/v1/condo/members', 'manager', async (ctx, tenant) => {
  const input = await parse(ctx.req, z.object({
    name: text(),
    email: z.string().email('Informe um e-mail válido.'),
    role: z.enum(['gestor', 'porteiro', 'morador']),
    unitId: uuid.nullish(),
  }));
  return units.addMember(ctx.deps, tenant.condominium.id, input, ctx.user!.id);
});
route('GET', '/api/v1/condo/visitors', 'member', (ctx, tenant) =>
  visitors.listPasses(ctx.deps, tenant.condominium.id, tenant.role === 'morador' ? tenant.unitId : null));
route('POST', '/api/v1/condo/visitors', 'member', async (ctx, tenant) => {
  const input = await parse(ctx.req, z.object({ unitId: uuid.nullish(), visitorName: text(), validHours: z.number().int().min(1).max(168).default(24) }));
  const unitId = tenant.role === 'morador' ? tenant.unitId : input.unitId;
  if (!unitId) throw badRequest('Escolha a unidade que recebe o visitante.');
  return visitors.createPass(ctx.deps, tenant.condominium.id, { unitId, visitorName: input.visitorName, validHours: input.validHours }, ctx.user!.id);
});
route('POST', '/api/v1/condo/visitors/check-in', 'member', async (ctx, tenant) => {
  const input = await parse(ctx.req, z.object({ code: z.string().trim().regex(/^\d{6}$/, 'O código tem 6 dígitos.') }));
  if (tenant.condominium.has_concierge && tenant.role === 'morador') throw forbidden('Neste condomínio, a portaria registra a entrada.');
  return visitors.checkIn(ctx.deps, tenant.condominium.id, input.code, { id: ctx.user!.id, role: tenant.role, unitId: tenant.unitId });
});

const WEBHOOK_PLATFORM = /^\/webhooks\/asaas\/platform$/;
const WEBHOOK_CONDO = /^\/webhooks\/asaas\/condominium\/([0-9a-f-]{36})$/;

export const SECURITY_HEADERS: Record<string, string> = {
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'strict-origin-when-cross-origin',
  'Content-Security-Policy':
    "default-src 'self'; style-src 'self' https://fonts.googleapis.com; font-src https://fonts.gstatic.com; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'; base-uri 'self'; form-action 'self'",
};

function json(status: number, data: unknown, extra?: Headers) {
  const headers = new Headers(extra);
  headers.set('Content-Type', 'application/json; charset=utf-8');
  headers.set('Cache-Control', 'no-store');
  return new Response(JSON.stringify(data), { status, headers });
}

export function withSecurityHeaders(response: Response, production: boolean) {
  for (const [key, value] of Object.entries(SECURITY_HEADERS)) response.headers.set(key, value);
  if (production) response.headers.set('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  return response;
}

function errorResponse(error: unknown) {
  if (error instanceof HttpError) return json(error.status, { error: error.code, message: error.message });
  if (error instanceof z.ZodError) return json(422, { error: 'dados_invalidos', message: 'Identificador ou parâmetro inválido.' });
  if (error instanceof AsaasError) {
    return json(502, {
      error: 'erro_asaas',
      message: error.uncertain ? 'O Asaas não respondeu. Tente de novo em alguns minutos.' : `O Asaas recusou o pedido: ${error.message}`,
    });
  }
  console.error(error);
  return json(500, { error: 'erro_interno', message: 'Ocorreu um erro interno. Tente de novo em alguns minutos.' });
}

async function handleWebhook(req: Request, deps: Deps, source: 'platform' | 'condominium', condominiumId: string | null) {
  await authorizeWebhook(deps, source, condominiumId, req.headers.get('asaas-access-token'));
  const raw = await req.text();
  if (raw.length > MAX_BODY) throw new HttpError(413, 'corpo_grande', 'O envio passou do limite de tamanho.');
  let event: any;
  try {
    event = JSON.parse(raw);
  } catch {
    throw badRequest('Corpo inválido.');
  }
  const result = await receiveWebhook(deps, source, condominiumId, event);
  return json(200, { received: true, ...result });
}

/** Trata toda requisição da API. Usa o padrão Request/Response para rodar em qualquer hospedagem. */
export async function handle(req: Request, deps: Deps): Promise<Response> {
  const url = new URL(req.url);
  const respond = async (): Promise<Response> => {
    if (req.method === 'POST') {
      if (WEBHOOK_PLATFORM.test(url.pathname)) return handleWebhook(req, deps, 'platform', null);
      const condo = WEBHOOK_CONDO.exec(url.pathname);
      if (condo) return handleWebhook(req, deps, 'condominium', condo[1]!);
      if (url.pathname === '/internal/jobs/run') {
        const secret = req.headers.get('x-jobs-secret') ?? (req.headers.get('authorization') ?? '').replace('Bearer ', '');
        if (!safeEqual(secret, deps.config.jobsSecret)) throw unauthorized('Segredo inválido.');
        return json(200, await runJobs(deps));
      }
    }
    if (req.method === 'GET' && url.pathname === '/internal/jobs/run') {
      // Formato usado pelo agendador da Vercel
      const secret = (req.headers.get('authorization') ?? '').replace('Bearer ', '');
      if (!safeEqual(secret, deps.config.jobsSecret)) throw unauthorized('Segredo inválido.');
      return json(200, await runJobs(deps));
    }

    const matches = routes
      .map((r) => ({ r, m: r.pattern.exec(url.pathname) }))
      .filter((x): x is { r: Route; m: RegExpExecArray } => x.m !== null);
    if (matches.length === 0) throw notFound('Endereço não encontrado.');
    const match = matches.find((x) => x.r.method === req.method);
    if (!match) throw new HttpError(405, 'metodo_invalido', 'Método não permitido.');

    const { token, viaCookie } = readToken(req, deps);
    const ctx: Ctx = {
      req, url, deps, token, viaCookie,
      host: parseHost(hostHeader(req, deps), deps.config.baseDomain),
      params: match.m.slice(1),
      user: null,
      outHeaders: new Headers(),
    };
    const browserLogin = url.pathname === '/api/v1/auth/login' && req.headers.get('origin') !== null;
    if (req.method !== 'GET' && (viaCookie || browserLogin)) assertSameOrigin(req, deps);
    const scope = match.r.scope;
    let tenant = undefined as unknown as Tenant;
    if (scope !== 'public') {
      ctx.user = await auth.userFromToken(deps, token);
      if (!ctx.user) throw unauthorized();
      if (ctx.user.must_change_password && !url.pathname.startsWith('/api/v1/auth/') && url.pathname !== '/api/v1/me' && url.pathname !== '/api/v1/condo') {
        throw new HttpError(403, 'trocar_senha', 'Troque a senha temporária para continuar.');
      }
    }
    if (scope === 'platform') {
      if (!ctx.user!.is_platform_admin) throw forbidden();
      if (ctx.host.kind !== 'platform' && ctx.host.kind !== 'api') throw forbidden('Use o endereço da administração.');
    }
    if (scope === 'manager' || scope === 'staff' || scope === 'member') {
      tenant = await resolveTenant(ctx);
      if (scope === 'manager' && !MANAGERS.has(tenant.role)) throw forbidden();
      if (scope === 'staff' && !STAFF.has(tenant.role)) throw forbidden();
      assertNotSuspended(tenant.condominium, req.method);
    }
    const data = await match.r.handler(ctx, tenant);
    return json(200, data, ctx.outHeaders);
  };
  try {
    return await respond();
  } catch (error) {
    return errorResponse(error);
  }
}

export function isApiPath(pathname: string) {
  return pathname.startsWith('/api/') || pathname.startsWith('/webhooks/') || pathname.startsWith('/internal/') || pathname === '/healthz';
}
