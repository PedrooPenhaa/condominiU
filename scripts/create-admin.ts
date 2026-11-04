import { createDb, withPlatform } from '../src/server/db/index.ts';
import { hashPassword } from '../src/server/security.ts';

/** Cria o primeiro administrador: ADMIN_EMAIL, ADMIN_NAME e ADMIN_PASSWORD. */
const { DATABASE_URL, ADMIN_EMAIL, ADMIN_NAME, ADMIN_PASSWORD } = process.env;
if (!DATABASE_URL || !ADMIN_EMAIL || !ADMIN_PASSWORD) throw new Error('Defina DATABASE_URL, ADMIN_EMAIL e ADMIN_PASSWORD');
if (ADMIN_PASSWORD.length < 12) throw new Error('Use uma senha com ao menos 12 caracteres');

const db = await createDb(DATABASE_URL);
const hash = await hashPassword(ADMIN_PASSWORD);
await withPlatform(db, (c) =>
  c.query(
    `INSERT INTO users (email, name, password_hash, is_platform_admin, must_change_password)
     VALUES (lower($1), $2, $3, true, false)
     ON CONFLICT (lower(email)) DO UPDATE SET password_hash = EXCLUDED.password_hash, is_platform_admin = true`,
    [ADMIN_EMAIL, ADMIN_NAME ?? 'Administrador', hash],
  ),
);
await db.close();
console.log(`Administrador pronto: ${ADMIN_EMAIL}`);
