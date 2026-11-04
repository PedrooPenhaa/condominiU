import { createServer, type Server } from 'node:http';
import { randomUUID } from 'node:crypto';

/**
 * Simulador local do Asaas para testes e demonstração. Não substitui o sandbox real:
 * ele cobre só os caminhos usados pelo sistema, no formato descrito na documentação.
 */
export interface FakeAsaas {
  server: Server;
  url: string;
  calls: Array<{ method: string; path: string; key: string; body: any }>;
  payments: Map<string, any>;
  accounts: Map<string, any>;
  /** Faz a próxima criação de cobrança executar no "Asaas" e depois derrubar a conexão. */
  failNextPaymentAfterCreate: boolean;
  close(): Promise<void>;
}

export async function startFakeAsaas(port = 0): Promise<FakeAsaas> {
  const state: FakeAsaas = {
    server: null as unknown as Server,
    url: '',
    calls: [],
    payments: new Map(),
    accounts: new Map(),
    failNextPaymentAfterCreate: false,
    close: () => new Promise((resolve) => state.server.close(() => resolve())),
  };
  const customers = new Map<string, any>();
  const subscriptions = new Map<string, any>();

  state.server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const url = new URL(req.url ?? '/', 'http://x');
      const path = url.pathname.replace(/^\/v3/, '');
      const body = raw ? JSON.parse(raw) : undefined;
      const key = String(req.headers.access_token ?? '');
      state.calls.push({ method: req.method ?? '', path, key, body });
      const reply = (status: number, data: unknown) => {
        res.writeHead(status, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify(data));
      };
      const fail = (description: string) => reply(400, { errors: [{ code: 'invalid', description }] });
      if (!key) return reply(401, { errors: [{ description: 'Sem chave' }] });

      if (req.method === 'POST' && path === '/accounts') {
        for (const field of ['name', 'email', 'cpfCnpj', 'mobilePhone', 'incomeValue', 'address', 'addressNumber', 'province', 'postalCode']) {
          if (!body[field]) return fail(`Campo obrigatório: ${field}`);
        }
        const id = randomUUID();
        const account = { id, walletId: `wallet_${id}`, apiKey: `$aact_sub_${id}`, status: 'AWAITING_APPROVAL', ...body };
        state.accounts.set(account.apiKey, account);
        return reply(200, account);
      }
      if (req.method === 'GET' && path === '/myAccount/status') {
        return reply(200, { general: state.accounts.get(key)?.status ?? 'PENDING' });
      }
      if (req.method === 'POST' && path === '/customers') {
        if (!body.name || !body.cpfCnpj) return fail('Nome e CPF/CNPJ são obrigatórios');
        const customer = { id: `cus_${randomUUID()}`, ...body };
        customers.set(customer.id, customer);
        return reply(200, customer);
      }
      if (req.method === 'POST' && path === '/payments') {
        if (!customers.has(body.customer)) return fail('Cliente inexistente');
        if (!body.billingType || !body.value || !body.dueDate) return fail('Campos obrigatórios ausentes');
        const payment = {
          id: `pay_${randomUUID()}`, status: 'PENDING', invoiceUrl: `https://sandbox.example/i/${randomUUID()}`, owner: key, ...body,
        };
        state.payments.set(payment.id, payment);
        if (state.failNextPaymentAfterCreate) {
          state.failNextPaymentAfterCreate = false;
          return res.destroy();
        }
        return reply(200, payment);
      }
      if (req.method === 'GET' && path === '/payments') {
        const reference = url.searchParams.get('externalReference');
        const data = [...state.payments.values()].filter((p) => p.owner === key && p.externalReference === reference);
        return reply(200, { data, totalCount: data.length });
      }
      const payment = /^\/payments\/([^/]+)$/.exec(path);
      if (payment) {
        const found = state.payments.get(decodeURIComponent(payment[1]!));
        if (!found) return reply(404, { errors: [{ description: 'Cobrança não encontrada' }] });
        if (req.method === 'GET') return reply(200, found);
        if (req.method === 'DELETE') {
          found.deleted = true;
          return reply(200, { deleted: true, id: found.id });
        }
      }
      if (req.method === 'POST' && path === '/subscriptions') {
        if (!customers.has(body.customer) || !body.nextDueDate || !body.cycle) return fail('Assinatura inválida');
        const subscription = { id: `sub_${randomUUID()}`, ...body };
        subscriptions.set(subscription.id, subscription);
        return reply(200, subscription);
      }
      const sub = /^\/subscriptions\/([^/]+)$/.exec(path);
      if (sub) {
        const found = subscriptions.get(decodeURIComponent(sub[1]!));
        if (!found) return reply(404, { errors: [{ description: 'Assinatura não encontrada' }] });
        if (req.method === 'PUT') {
          Object.assign(found, body);
          return reply(200, found);
        }
        if (req.method === 'DELETE') return reply(200, { deleted: true });
      }
      return reply(404, { errors: [{ description: `Rota simulada inexistente: ${req.method} ${path}` }] });
    });
  });
  await new Promise<void>((resolve) => state.server.listen(port, '127.0.0.1', resolve));
  const address = state.server.address();
  state.url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}/v3`;
  return state;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const fake = await startFakeAsaas(Number(process.env.FAKE_ASAAS_PORT ?? 4010));
  console.log(`Simulador do Asaas em ${fake.url}`);
}
