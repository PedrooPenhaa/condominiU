export interface Config {
  baseDomain: string;
  brandName: string;
  databaseUrl: string;
  encryptionKey: Buffer;
  jobsSecret: string;
  asaasBaseUrl: string;
  asaasApiKey: string;
  asaasWalletId: string;
  asaasWebhookToken: string;
  publicProtocol: 'http' | 'https';
  publicPort: string;
  trustProxy: boolean;
  production: boolean;
}

const ASAAS_URLS: Record<string, string> = {
  sandbox: 'https://api-sandbox.asaas.com/v3',
  production: 'https://api.asaas.com/v3',
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const production = env.NODE_ENV === 'production';
  const required = (name: string): string => {
    const value = env[name];
    if (!value) throw new Error(`Variável de ambiente obrigatória ausente: ${name}`);
    return value;
  };
  const encryptionKey = Buffer.from(required('ENCRYPTION_KEY'), 'base64');
  if (encryptionKey.length !== 32) throw new Error('ENCRYPTION_KEY precisa ter 32 bytes em base64');
  const asaasEnv = env.ASAAS_ENV ?? 'sandbox';
  const asaasBaseUrl = env.ASAAS_BASE_URL ?? ASAAS_URLS[asaasEnv];
  if (!asaasBaseUrl) throw new Error('ASAAS_ENV precisa ser sandbox ou production');
  const webhookToken = required('ASAAS_WEBHOOK_TOKEN');
  if (webhookToken.length < 32) throw new Error('ASAAS_WEBHOOK_TOKEN precisa ter ao menos 32 caracteres');
  return {
    baseDomain: required('BASE_DOMAIN').toLowerCase(),
    brandName: env.BRAND_NAME ?? 'Gestora de condomínios',
    databaseUrl: required('DATABASE_URL'),
    encryptionKey,
    jobsSecret: required('JOBS_SECRET'),
    asaasBaseUrl,
    asaasApiKey: required('ASAAS_API_KEY'),
    asaasWalletId: env.ASAAS_WALLET_ID ?? '',
    asaasWebhookToken: webhookToken,
    publicProtocol: production ? 'https' : 'http',
    publicPort: production ? '' : `:${env.PORT ?? '3000'}`,
    trustProxy: env.TRUST_PROXY === '1',
    production,
  };
}
