# Sistema de gestão de condomínios

Sistema multiempresa para vender mensalidade a condomínios. Cada condomínio tem um endereço próprio e recebe os pagamentos dos moradores em uma subconta Asaas no CNPJ dele. A sua empresa recebe a mensalidade do sistema e, se quiser, um repasse por pagamento.

| Endereço | Quem usa | O que faz |
|---|---|---|
| `admin.SEUDOMINIO` | Você | Cadastra condomínios, define valores, acompanha a receita e suspende quem não paga |
| `condominio.SEUDOMINIO` | Síndico, gestor, porteiro e morador | Unidades, cobranças, painel de pagamentos, visitantes e acessos |
| `api.SEUDOMINIO` | Futuro aplicativo | A mesma API, com login por token e o cabeçalho `X-Condominium-Slug` |

## Como está organizado

- `src/server`: API REST em `/api/v1`, webhooks do Asaas e rotinas.
- `src/web`: painéis em React, servidos como arquivos estáticos.
- `db/migrations`: tabelas e isolamento entre condomínios com Row Level Security.
- `scripts/fake-asaas.ts`: simulador do Asaas usado nos testes e na demonstração.
- `tests`: testes de isolamento, pagamentos e regras, com um Postgres real.

O sistema entra no banco com o papel `condo_app`, que não pode ignorar o isolamento. As chaves das subcontas ficam criptografadas, e o dinheiro dos moradores não passa pela sua conta.

## Rodar a demonstração

Precisa de Node 22.13 ou mais novo e de um Postgres local que aceite conexão sem senha, por exemplo:

```sh
docker run --name condo-pg -e POSTGRES_HOST_AUTH_METHOD=trust -p 55432:5432 -d postgres:16
npm install
DEMO_ADMIN_URL=wire://postgres@127.0.0.1:55432/postgres \
DEMO_APP_URL=wire://condo_app@127.0.0.1:55432/postgres \
npm run demo
```

Depois abra:

- `http://admin.localhost:3000`, com `admin@exemplo.test` e a senha `demonstracao-123`
- `http://aurora.localhost:3000`, com `sindica@aurora.test` e a mesma senha

Os dados são fictícios e o Asaas é simulado. A demonstração espera um banco vazio; para repetir, recrie o contêiner.

## Testes

```sh
TEST_PG_OWNER=postgres npm test
```

## Publicar

Siga [docs/DEPLOY.md](docs/DEPLOY.md).
