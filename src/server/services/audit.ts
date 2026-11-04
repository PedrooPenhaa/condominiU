import type { Client } from '../db/index.ts';

export async function audit(
  client: Client,
  entry: { condominiumId?: string | null; actorId?: string | null; action: string; details?: Record<string, unknown> },
) {
  await client.query(
    `INSERT INTO audit_log (condominium_id, actor_user_id, action, details) VALUES ($1, $2, $3, $4)`,
    [entry.condominiumId ?? null, entry.actorId ?? null, entry.action, entry.details ?? {}],
  );
}
