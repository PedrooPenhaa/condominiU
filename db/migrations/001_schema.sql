-- Estrutura principal. O schema "app" não é exposto pela API automática do Supabase.
CREATE SCHEMA IF NOT EXISTS app;
SET search_path = app;

CREATE TABLE users (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email text NOT NULL,
  name text NOT NULL,
  password_hash text NOT NULL,
  is_platform_admin boolean NOT NULL DEFAULT false,
  must_change_password boolean NOT NULL DEFAULT true,
  failed_logins integer NOT NULL DEFAULT 0,
  locked_until timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX users_email_unique ON users (lower(email));

CREATE TABLE sessions (
  token_hash text PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  client text NOT NULL CHECK (client IN ('web', 'mobile')),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX sessions_user ON sessions (user_id);

CREATE TABLE condominiums (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  slug text NOT NULL UNIQUE CHECK (slug ~ '^[a-z0-9]([a-z0-9-]{0,48}[a-z0-9])?$'),
  name text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('predio', 'casas', 'misto')),
  has_concierge boolean NOT NULL DEFAULT false,
  legal_nature text NOT NULL DEFAULT 'condominio_edilicio'
    CHECK (legal_nature IN ('condominio_edilicio', 'associacao', 'outro')),
  cnpj text NOT NULL,
  email text NOT NULL,
  mobile_phone text NOT NULL,
  address text NOT NULL,
  address_number text NOT NULL,
  complement text,
  province text NOT NULL,
  postal_code text NOT NULL,
  monthly_income_cents integer NOT NULL CHECK (monthly_income_cents > 0),
  status text NOT NULL DEFAULT 'rascunho'
    CHECK (status IN ('rascunho', 'aguardando_aprovacao', 'ativo', 'suspenso', 'cancelado')),
  asaas_account_id text,
  asaas_wallet_id text,
  asaas_api_key_enc text,
  asaas_webhook_token_hash text,
  asaas_approval text NOT NULL DEFAULT 'nao_criada',
  fee_monthly_cents integer NOT NULL DEFAULT 0 CHECK (fee_monthly_cents >= 0),
  fee_split_type text NOT NULL DEFAULT 'none' CHECK (fee_split_type IN ('none', 'fixed', 'percent')),
  -- Centavos quando fixed; centésimos de ponto percentual quando percent (150 = 1,50%)
  fee_split_value integer NOT NULL DEFAULT 0 CHECK (fee_split_value >= 0),
  billing_due_day integer NOT NULL DEFAULT 10 CHECK (billing_due_day BETWEEN 1 AND 28),
  platform_customer_id text,
  platform_subscription_id text UNIQUE,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX condominiums_cnpj_unique ON condominiums (cnpj) WHERE status <> 'cancelado';

CREATE TABLE units (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  condominium_id uuid NOT NULL REFERENCES condominiums(id) ON DELETE CASCADE,
  kind text NOT NULL DEFAULT 'apartamento' CHECK (kind IN ('apartamento', 'casa', 'sala', 'lote')),
  block text NOT NULL DEFAULT '',
  number text NOT NULL,
  fee_cents integer NOT NULL CHECK (fee_cents >= 0),
  active boolean NOT NULL DEFAULT true,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (condominium_id, block, number)
);

CREATE TABLE memberships (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  condominium_id uuid NOT NULL REFERENCES condominiums(id) ON DELETE CASCADE,
  role text NOT NULL CHECK (role IN ('sindico', 'gestor', 'porteiro', 'morador')),
  unit_id uuid REFERENCES units(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (user_id, condominium_id)
);

CREATE TABLE residents (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  condominium_id uuid NOT NULL REFERENCES condominiums(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  name text NOT NULL,
  cpf_cnpj text NOT NULL,
  email text,
  mobile_phone text,
  is_payer boolean NOT NULL DEFAULT true,
  asaas_customer_id text,
  user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX residents_one_payer ON residents (unit_id) WHERE is_payer;

CREATE TABLE charges (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  condominium_id uuid NOT NULL REFERENCES condominiums(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES units(id),
  resident_id uuid REFERENCES residents(id) ON DELETE SET NULL,
  competence text NOT NULL CHECK (competence ~ '^[0-9]{4}-(0[1-9]|1[0-2])$'),
  description text NOT NULL,
  value_cents integer NOT NULL CHECK (value_cents > 0),
  due_date date NOT NULL,
  status text NOT NULL DEFAULT 'criando' CHECK (status IN (
    'criando', 'pendente', 'confirmada', 'paga', 'vencida', 'cancelada', 'estornada', 'contestada', 'falhou'
  )),
  asaas_payment_id text UNIQUE,
  invoice_url text,
  paid_at timestamptz,
  net_cents integer,
  -- Regra de repasse à plataforma vigente quando a cobrança foi emitida
  split_type text NOT NULL DEFAULT 'none' CHECK (split_type IN ('none', 'fixed', 'percent')),
  split_value integer NOT NULL DEFAULT 0,
  split_cents integer NOT NULL DEFAULT 0,
  last_error text,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (condominium_id, unit_id, competence, description)
);
CREATE INDEX charges_competence ON charges (condominium_id, competence);
CREATE INDEX charges_open ON charges (status, updated_at) WHERE status IN ('pendente', 'confirmada', 'vencida');

CREATE TABLE platform_invoices (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  condominium_id uuid NOT NULL REFERENCES condominiums(id) ON DELETE CASCADE,
  asaas_payment_id text NOT NULL UNIQUE,
  value_cents integer NOT NULL,
  due_date date NOT NULL,
  status text NOT NULL CHECK (status IN ('pendente', 'confirmada', 'paga', 'vencida', 'cancelada', 'estornada', 'contestada')),
  invoice_url text,
  paid_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX platform_invoices_condo ON platform_invoices (condominium_id, due_date DESC);

CREATE TABLE visitor_passes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  condominium_id uuid NOT NULL REFERENCES condominiums(id) ON DELETE CASCADE,
  unit_id uuid NOT NULL REFERENCES units(id) ON DELETE CASCADE,
  created_by uuid REFERENCES users(id) ON DELETE SET NULL,
  visitor_name text NOT NULL,
  code text NOT NULL,
  valid_until timestamptz NOT NULL,
  status text NOT NULL DEFAULT 'autorizado' CHECK (status IN ('autorizado', 'entrou', 'cancelado')),
  checked_in_at timestamptz,
  checked_in_by uuid REFERENCES users(id) ON DELETE SET NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (condominium_id, code)
);

CREATE TABLE webhook_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  source text NOT NULL CHECK (source IN ('platform', 'condominium')),
  condominium_id uuid REFERENCES condominiums(id) ON DELETE SET NULL,
  event_id text NOT NULL,
  event_type text NOT NULL,
  payload jsonb NOT NULL,
  status text NOT NULL DEFAULT 'recebido' CHECK (status IN ('recebido', 'processado', 'falhou')),
  attempts integer NOT NULL DEFAULT 0,
  error text,
  received_at timestamptz NOT NULL DEFAULT now(),
  processed_at timestamptz,
  UNIQUE (source, event_id)
);
CREATE INDEX webhook_events_retry ON webhook_events (status, received_at) WHERE status <> 'processado';

CREATE TABLE audit_log (
  id bigserial PRIMARY KEY,
  condominium_id uuid REFERENCES condominiums(id) ON DELETE SET NULL,
  actor_user_id uuid REFERENCES users(id) ON DELETE SET NULL,
  action text NOT NULL,
  details jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX audit_log_condo ON audit_log (condominium_id, created_at DESC);
