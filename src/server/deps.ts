import { AsaasClient } from './asaas/client.ts';
import type { Config } from './config.ts';
import type { Db, Row } from './db/index.ts';
import { HttpError } from './errors.ts';
import { decryptSecret } from './security.ts';

export interface Deps {
  db: Db;
  config: Config;
  fetcher?: typeof fetch;
}

export function platformAsaas(deps: Deps) {
  return new AsaasClient(deps.config.asaasBaseUrl, deps.config.asaasApiKey, deps.fetcher);
}

export function condominiumAsaas(deps: Deps, condominium: Row) {
  if (!condominium.asaas_api_key_enc) {
    throw new HttpError(409, 'conta_nao_criada', 'Crie a conta de recebimento deste condomínio antes de continuar.');
  }
  const key = decryptSecret(condominium.asaas_api_key_enc, deps.config.encryptionKey);
  return new AsaasClient(deps.config.asaasBaseUrl, key, deps.fetcher);
}

export function publicUrl(deps: Deps, subdomain: string, path = '') {
  const { publicProtocol, publicPort, baseDomain, hostPrefix } = deps.config;
  return `${publicProtocol}://${hostPrefix}${subdomain}.${baseDomain}${publicPort}${path}`;
}
