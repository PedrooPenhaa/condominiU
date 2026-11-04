export class ApiError extends Error {
  constructor(message: string, readonly status: number, readonly code: string) {
    super(message);
  }
}

export async function api<T = any>(path: string, options: { method?: string; body?: unknown } = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`/api/v1${path}`, {
      method: options.method ?? 'GET',
      headers: options.body !== undefined ? { 'Content-Type': 'application/json' } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : options.method && options.method !== 'GET' ? '{}' : undefined,
      credentials: 'same-origin',
    });
  } catch {
    throw new ApiError('Sem conexão com o servidor. Verifique a internet e tente de novo.', 0, 'rede');
  }
  const data = await response.json().catch(() => ({}));
  if (!response.ok) throw new ApiError(data.message ?? 'Não foi possível concluir.', response.status, data.error ?? 'erro');
  return data as T;
}

const BRL = new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL' });
export const money = (cents: number | null | undefined) => BRL.format((cents ?? 0) / 100);
export const moneyWhole = (cents: number) =>
  new Intl.NumberFormat('pt-BR', { style: 'currency', currency: 'BRL', maximumFractionDigits: cents % 100 === 0 ? 0 : 2 }).format(cents / 100);

/** Converte "1.234,50" em centavos. Devolve null se o texto não for um valor. */
export function parseMoney(text: string): number | null {
  const clean = text.replace(/[R$\s]/g, '').replace(/\./g, '').replace(',', '.');
  if (!clean) return null;
  const value = Number(clean);
  return Number.isFinite(value) && value >= 0 ? Math.round(value * 100) : null;
}

export const dateBr = (iso: string | null | undefined) => {
  if (!iso) return '';
  const [y, m, d] = iso.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
};

const MONTHS = ['janeiro', 'fevereiro', 'março', 'abril', 'maio', 'junho', 'julho', 'agosto', 'setembro', 'outubro', 'novembro', 'dezembro'];
export const monthLabel = (competence: string) => {
  const [y, m] = competence.split('-');
  return `${MONTHS[Number(m) - 1]} de ${y}`;
};
export const currentCompetence = () => new Date().toISOString().slice(0, 7);
export const shiftMonth = (competence: string, delta: number) => {
  const [y, m] = competence.split('-').map(Number) as [number, number];
  return new Date(Date.UTC(y, m - 1 + delta, 1)).toISOString().slice(0, 7);
};

export const CHARGE_LABEL: Record<string, string> = {
  criando: 'Emitindo',
  pendente: 'Em aberto',
  confirmada: 'Paga, saldo a liberar',
  paga: 'Paga',
  vencida: 'Vencida',
  cancelada: 'Cancelada',
  estornada: 'Estornada',
  contestada: 'Contestada',
  falhou: 'Não emitida',
};
export const CONDO_LABEL: Record<string, string> = {
  rascunho: 'Sem conta de recebimento',
  aguardando_aprovacao: 'Aguardando aprovação',
  ativo: 'Ativo',
  suspenso: 'Suspenso',
  cancelado: 'Cancelado',
};
export const APPROVAL_LABEL: Record<string, string> = {
  nao_criada: 'Ainda não criada',
  em_analise: 'Em análise no Asaas',
  pendente: 'Pendente: o responsável precisa enviar documentos',
  aprovada: 'Aprovada',
  reprovada: 'Reprovada',
};
export const KIND_LABEL: Record<string, string> = { predio: 'Prédios', casas: 'Casas', misto: 'Prédios e casas' };
export const ROLE_LABEL: Record<string, string> = {
  sindico: 'Síndico', gestor: 'Gestor', porteiro: 'Porteiro', morador: 'Morador', plataforma: 'Administração',
};
