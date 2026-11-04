/** Estados de uma cobrança e as regras de transição, usadas por webhooks e pela conferência diária. */
export type PaymentState =
  | 'criando' | 'pendente' | 'confirmada' | 'paga' | 'vencida' | 'cancelada' | 'estornada' | 'contestada' | 'falhou';

const EVENT_STATE: Record<string, PaymentState> = {
  PAYMENT_CONFIRMED: 'confirmada',
  PAYMENT_RECEIVED: 'paga',
  PAYMENT_OVERDUE: 'vencida',
  PAYMENT_DELETED: 'cancelada',
  PAYMENT_RESTORED: 'pendente',
  PAYMENT_REFUNDED: 'estornada',
  PAYMENT_CHARGEBACK_REQUESTED: 'contestada',
  PAYMENT_CHARGEBACK_DISPUTE: 'contestada',
};

const API_STATE: Record<string, PaymentState> = {
  PENDING: 'pendente',
  CONFIRMED: 'confirmada',
  RECEIVED: 'paga',
  RECEIVED_IN_CASH: 'paga',
  OVERDUE: 'vencida',
  REFUNDED: 'estornada',
  CHARGEBACK_REQUESTED: 'contestada',
  CHARGEBACK_DISPUTE: 'contestada',
  AWAITING_CHARGEBACK_REVERSAL: 'contestada',
};

const ALLOWED: Record<PaymentState, PaymentState[]> = {
  criando: ['pendente', 'confirmada', 'paga', 'vencida', 'cancelada', 'estornada', 'contestada'],
  falhou: ['pendente', 'confirmada', 'paga', 'vencida', 'cancelada'],
  pendente: ['confirmada', 'paga', 'vencida', 'cancelada', 'estornada', 'contestada'],
  vencida: ['pendente', 'confirmada', 'paga', 'cancelada', 'estornada', 'contestada'],
  confirmada: ['paga', 'cancelada', 'estornada', 'contestada'],
  paga: ['estornada', 'contestada'],
  contestada: ['paga', 'estornada'],
  cancelada: ['pendente'],
  estornada: [],
};

export const stateForEvent = (event: string): PaymentState | null => EVENT_STATE[event] ?? null;
export const stateForApiStatus = (status: string): PaymentState | null => API_STATE[status] ?? null;

/** Impede que um aviso fora de ordem desfaça um pagamento: "venceu" não apaga "pagou". */
export function canMove(from: PaymentState, to: PaymentState): boolean {
  return ALLOWED[from].includes(to);
}

export const toCents = (value: number | null | undefined): number | null =>
  value === null || value === undefined ? null : Math.round(value * 100);

export function computeSplitCents(type: string, value: number, netCents: number | null): number {
  if (type === 'fixed') return value;
  if (type === 'percent' && netCents !== null) return Math.round((netCents * value) / 10000);
  return 0;
}
