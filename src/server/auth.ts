import { withPlatform, type Row } from './db/index.ts';
import type { Deps } from './deps.ts';
import { forbidden, HttpError, unauthorized } from './errors.ts';
import { hashPassword, randomToken, sha256, verifyPassword } from './security.ts';
import type { HostContext } from './tenancy.ts';

const MAX_FAILURES = 5;
const WEB_DAYS = 7;
const MOBILE_DAYS = 60;
// Comparação de tempo constante também quando o e-mail não existe
const DUMMY_HASH = hashPassword(randomToken());

export function cookieName(deps: Deps) {
  return deps.config.production ? '__Host-session' : 'session';
}

export function sessionCookie(deps: Deps, token: string, days: number) {
  const secure = deps.config.production ? '; Secure' : '';
  return `${cookieName(deps)}=${token}; HttpOnly; Path=/; SameSite=Lax; Max-Age=${days * 86400}${secure}`;
}

export function clearCookie(deps: Deps) {
  const secure = deps.config.production ? '; Secure' : '';
  return `${cookieName(deps)}=; HttpOnly; Path=/; SameSite=Lax; Max-Age=0${secure}`;
}

export async function login(
  deps: Deps,
  input: { email: string; password: string; client: 'web' | 'mobile' },
  host: HostContext,
) {
  const [user] = await withPlatform(deps.db, (c) => c.query(`SELECT * FROM users WHERE lower(email) = lower($1)`, [input.email]));
  if (!user) {
    await verifyPassword(input.password, await DUMMY_HASH);
    throw new HttpError(401, 'credenciais_invalidas', 'E-mail ou senha incorretos.');
  }
  if (user.locked_until && new Date(user.locked_until) > new Date()) {
    throw new HttpError(429, 'acesso_bloqueado', 'Muitas tentativas. Tente de novo em 15 minutos.');
  }
  const valid = await verifyPassword(input.password, user.password_hash);
  if (!valid) {
    await withPlatform(deps.db, (c) =>
      c.query(
        `UPDATE users SET failed_logins = CASE WHEN failed_logins + 1 >= $2 THEN 0 ELSE failed_logins + 1 END,
           locked_until = CASE WHEN failed_logins + 1 >= $2 THEN now() + interval '15 minutes' ELSE locked_until END
         WHERE id = $1`,
        [user.id, MAX_FAILURES],
      ),
    );
    throw new HttpError(401, 'credenciais_invalidas', 'E-mail ou senha incorretos.');
  }
  await assertHostAccess(deps, user, host);
  const token = randomToken();
  const days = input.client === 'mobile' ? MOBILE_DAYS : WEB_DAYS;
  await withPlatform(deps.db, async (c) => {
    await c.query(`UPDATE users SET failed_logins = 0, locked_until = NULL WHERE id = $1`, [user.id]);
    await c.query(
      `INSERT INTO sessions (token_hash, user_id, client, expires_at) VALUES ($1, $2, $3, now() + ($4 || ' days')::interval)`,
      [sha256(token), user.id, input.client, String(days)],
    );
  });
  return { token, days, user: publicUser(user) };
}

async function assertHostAccess(deps: Deps, user: Row, host: HostContext) {
  if (host.kind === 'platform' && !user.is_platform_admin) throw forbidden('Este painel é exclusivo da administração.');
  if (host.kind === 'tenant' && !user.is_platform_admin) {
    const [membership] = await withPlatform(deps.db, (c) =>
      c.query(
        `SELECT 1 AS ok FROM memberships m JOIN condominiums c ON c.id = m.condominium_id
         WHERE m.user_id = $1 AND c.slug = $2`,
        [user.id, host.slug],
      ),
    );
    if (!membership) throw forbidden('Seu usuário não tem acesso a este condomínio.');
  }
}

export function publicUser(user: Row) {
  return {
    id: user.id,
    email: user.email,
    name: user.name,
    is_platform_admin: user.is_platform_admin,
    must_change_password: user.must_change_password,
  };
}

export async function userFromToken(deps: Deps, token: string | null): Promise<Row | null> {
  if (!token) return null;
  const [user] = await withPlatform(deps.db, (c) =>
    c.query(
      `SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token_hash = $1 AND s.expires_at > now()`,
      [sha256(token)],
    ),
  );
  return user ?? null;
}

export async function logout(deps: Deps, token: string) {
  await withPlatform(deps.db, (c) => c.query(`DELETE FROM sessions WHERE token_hash = $1`, [sha256(token)]));
}

export async function changePassword(deps: Deps, user: Row, current: string, next: string, keepToken: string) {
  if (!(await verifyPassword(current, user.password_hash))) throw unauthorized('A senha atual está incorreta.');
  const hash = await hashPassword(next);
  await withPlatform(deps.db, async (c) => {
    await c.query(`UPDATE users SET password_hash = $2, must_change_password = false WHERE id = $1`, [user.id, hash]);
    // Encerra as outras sessões, mantendo a atual
    await c.query(`DELETE FROM sessions WHERE user_id = $1 AND token_hash <> $2`, [user.id, sha256(keepToken)]);
  });
}
