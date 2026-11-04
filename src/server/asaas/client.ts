export class AsaasError extends Error {
  constructor(
    message: string,
    readonly status: number,
    /** Verdadeiro quando não se sabe se o Asaas executou o pedido (queda de rede, tempo esgotado, erro 5xx). */
    readonly uncertain: boolean,
  ) {
    super(message);
  }
}

export interface SplitRule {
  walletId: string;
  fixedValue?: number;
  percentualValue?: number;
}

export interface AsaasPayment {
  id: string;
  status: string;
  value: number;
  netValue?: number;
  dueDate: string;
  invoiceUrl?: string;
  customer?: string;
  subscription?: string;
  externalReference?: string;
  paymentDate?: string;
  clientPaymentDate?: string;
  confirmedDate?: string;
  deleted?: boolean;
}

const money = (cents: number) => Math.round(cents) / 100;

/** Cliente da API do Asaas. Cada instância usa uma chave: a sua conta ou a subconta de um condomínio. */
export class AsaasClient {
  constructor(
    private baseUrl: string,
    private apiKey: string,
    private fetcher: typeof fetch = fetch,
  ) {}

  private async request<T>(method: string, path: string, body?: unknown): Promise<T> {
    let response: Response;
    try {
      response = await this.fetcher(`${this.baseUrl}${path}`, {
        method,
        headers: {
          access_token: this.apiKey,
          'Content-Type': 'application/json',
          'User-Agent': 'condo-saas/0.1',
        },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(20_000),
      });
    } catch (error) {
      throw new AsaasError(`Falha de conexão com o Asaas: ${(error as Error).message}`, 0, true);
    }
    const text = await response.text();
    let data: any = {};
    try {
      data = text ? JSON.parse(text) : {};
    } catch {
      // A mensagem abaixo já indica o status recebido
    }
    if (!response.ok) {
      const description = data?.errors?.map((e: any) => e.description).join('; ');
      throw new AsaasError(description || `O Asaas respondeu com status ${response.status}`, response.status, response.status >= 500);
    }
    return data as T;
  }

  createSubaccount(input: {
    name: string;
    email: string;
    cpfCnpj: string;
    mobilePhone: string;
    incomeValue: number;
    companyType?: string;
    address: string;
    addressNumber: string;
    complement?: string | null;
    province: string;
    postalCode: string;
    webhooks?: unknown[];
  }) {
    return this.request<{ id: string; walletId: string; apiKey: string }>('POST', '/accounts', input);
  }

  accountStatus() {
    return this.request<{ general?: string; commercialInfo?: string; documentation?: string; bankAccountInfo?: string }>(
      'GET',
      '/myAccount/status',
    );
  }

  createCustomer(input: {
    name: string;
    cpfCnpj: string;
    email?: string | null;
    mobilePhone?: string | null;
    externalReference?: string;
    notificationDisabled?: boolean;
  }) {
    return this.request<{ id: string }>('POST', '/customers', input);
  }

  createPayment(input: {
    customer: string;
    billingType: 'UNDEFINED' | 'BOLETO' | 'PIX' | 'CREDIT_CARD';
    valueCents: number;
    dueDate: string;
    description: string;
    externalReference: string;
    split?: SplitRule[];
  }) {
    const { valueCents, ...rest } = input;
    return this.request<AsaasPayment>('POST', '/payments', { ...rest, value: money(valueCents) });
  }

  getPayment(id: string) {
    return this.request<AsaasPayment>('GET', `/payments/${encodeURIComponent(id)}`);
  }

  async findPaymentByReference(reference: string): Promise<AsaasPayment | null> {
    const result = await this.request<{ data: AsaasPayment[] }>(
      'GET',
      `/payments?externalReference=${encodeURIComponent(reference)}&limit=1`,
    );
    return result.data?.[0] ?? null;
  }

  deletePayment(id: string) {
    return this.request<{ deleted: boolean }>('DELETE', `/payments/${encodeURIComponent(id)}`);
  }

  createSubscription(input: {
    customer: string;
    billingType: 'UNDEFINED' | 'BOLETO' | 'PIX' | 'CREDIT_CARD';
    valueCents: number;
    nextDueDate: string;
    description: string;
    externalReference: string;
  }) {
    const { valueCents, ...rest } = input;
    return this.request<{ id: string }>('POST', '/subscriptions', { ...rest, value: money(valueCents), cycle: 'MONTHLY' });
  }

  updateSubscription(id: string, input: { valueCents: number }) {
    return this.request<{ id: string }>('PUT', `/subscriptions/${encodeURIComponent(id)}`, {
      value: money(input.valueCents),
      updatePendingPayments: false,
    });
  }

  cancelSubscription(id: string) {
    return this.request<{ deleted: boolean }>('DELETE', `/subscriptions/${encodeURIComponent(id)}`);
  }
}

export const CONDOMINIUM_WEBHOOK_EVENTS = [
  'PAYMENT_CREATED', 'PAYMENT_UPDATED', 'PAYMENT_CONFIRMED', 'PAYMENT_RECEIVED', 'PAYMENT_OVERDUE',
  'PAYMENT_DELETED', 'PAYMENT_RESTORED', 'PAYMENT_REFUNDED', 'PAYMENT_PARTIALLY_REFUNDED',
  'PAYMENT_CHARGEBACK_REQUESTED', 'PAYMENT_CHARGEBACK_DISPUTE',
  'PAYMENT_SPLIT_DONE', 'PAYMENT_SPLIT_CANCELLED', 'PAYMENT_SPLIT_DIVERGENCE_BLOCK', 'PAYMENT_SPLIT_DIVERGENCE_BLOCK_FINISHED',
  'ACCOUNT_STATUS_GENERAL_APPROVAL_APPROVED', 'ACCOUNT_STATUS_GENERAL_APPROVAL_AWAITING_APPROVAL',
  'ACCOUNT_STATUS_GENERAL_APPROVAL_PENDING', 'ACCOUNT_STATUS_GENERAL_APPROVAL_REJECTED',
];
