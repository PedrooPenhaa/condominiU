export type HostContext =
  | { kind: 'platform' }
  | { kind: 'tenant'; slug: string }
  | { kind: 'api' }
  | { kind: 'root' };

/** Subdomínios que nunca podem virar endereço de condomínio. */
export const RESERVED_SLUGS = new Set([
  'admin', 'api', 'app', 'www', 'mail', 'email', 'smtp', 'ftp', 'webmail', 'suporte', 'support', 'ajuda',
  'help', 'status', 'static', 'assets', 'cdn', 'blog', 'login', 'painel', 'dashboard', 'teste', 'test', 'dev',
  'staging', 'sandbox', 'webhook', 'webhooks', 'pagamentos', 'financeiro',
]);

export function parseHost(rawHost: string, baseDomain: string): HostContext {
  const host = rawHost.toLowerCase().replace(/:\d+$/, '').replace(/\.$/, '');
  if (host === baseDomain || host === `www.${baseDomain}`) return { kind: 'root' };
  const suffix = `.${baseDomain}`;
  if (!host.endsWith(suffix)) return { kind: 'root' };
  const sub = host.slice(0, -suffix.length);
  if (sub.includes('.')) return { kind: 'root' };
  if (sub === 'admin') return { kind: 'platform' };
  if (sub === 'api') return { kind: 'api' };
  if (RESERVED_SLUGS.has(sub)) return { kind: 'root' };
  return { kind: 'tenant', slug: sub };
}

export function validSlug(slug: string): boolean {
  return /^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$/.test(slug) && !RESERVED_SLUGS.has(slug) && !slug.includes('--');
}

/** Sugere um endereço a partir do nome: "Residencial Aurora" vira "residencial-aurora". */
export function slugify(name: string): string {
  return name
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 50)
    .replace(/-+$/g, '');
}
