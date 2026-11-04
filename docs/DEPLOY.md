# Como publicar

Este guia coloca o sistema no ar de graça para testar de ponta a ponta, com dinheiro fictício e dados fictícios. Ele usa um domínio gratuito, Vercel Hobby, Supabase Free e o sandbox do Asaas. A última seção diz o que mudar antes do primeiro cliente real.

## O que ainda não foi executado

Estes pontos só foram testados localmente ou conferidos na documentação, então podem pedir ajustes na primeira publicação:

- A conexão pelo pacote `pg`, porque os testes usaram um cliente próprio de desenvolvimento.
- O deploy real na Vercel, porque a função e as rotas só rodaram localmente.
- A integração real com o Asaas, porque os testes usaram um simulador.
- O domínio gratuito com os nameservers da Vercel.

## Regras do teste gratuito

- Use só dados fictícios e seus próprios e-mails e celulares, porque o [sandbox pode enviar mensagens de verdade](https://docs.asaas.com/docs/sandbox).
- Não atenda clientes nem cobre ninguém neste ambiente. O plano Hobby é [só para uso não comercial](https://vercel.com/docs/limits/fair-use-guidelines). Se tiver dúvida sobre o teste, pergunte ao suporte da Vercel.
- O Supabase Free [não tem backup automático](https://supabase.com/pricing) e [pausa o projeto depois de uma semana com pouca atividade](https://supabase.com/kb/faqs/platform/free-project-pausing). Os dados continuam guardados.

## 1. Crie as contas

- GitHub, com um repositório privado para este código.
- Vercel, no plano Hobby.
- Supabase, no plano Free. Escolha São Paulo se a região estiver disponível.
- [Sandbox do Asaas](https://docs.asaas.com/docs/sandbox).

## 2. Escolha o domínio

Cada condomínio usa um subdomínio, então é preciso um domínio próprio. A Freenom [não é mais gratuita](https://domainincite.com/31821-freenom-is-back-but-no-longer-free). Escolha uma destas opções:

- **Grátis:** registre um nome na [DigitalPlat](https://themenonlab.blog/blog/free-domain-names-digitalplat), como `meuteste.qzz.io`. O serviço não tem garantia de funcionamento, então use só no teste.
- **Definitivo:** registre um `.com.br`, por [cerca de R$ 40 por ano](https://hostgator.com.br/blog/quanto-custa-um-dominio/). Ele elimina o risco do domínio gratuito e pode continuar depois do teste.

No restante do guia, `seudominio` representa o nome escolhido.

## 3. Prepare o banco

1. No Supabase, abra **SQL Editor** e execute `db/migrations/001_schema.sql` e depois `db/migrations/002_isolation.sql`.

2. Crie a senha do papel usado pelo sistema, com um valor longo e aleatório:

   ```sql
   ALTER ROLE condo_app LOGIN PASSWORD 'TROQUE_ESTA_SENHA';
   ```

3. Em **Connect**, copie o endereço do pooler em modo transação, na porta 6543. Monte o `DATABASE_URL` com o usuário `condo_app.REF_DO_PROJETO`, sem `sslmode` na URL:

   ```
   postgres://condo_app.REF_DO_PROJETO:SENHA@HOST_DO_POOLER:6543/postgres
   ```

4. Em **Database Settings**, baixe o certificado raiz e guarde o conteúdo para `DB_SSL_CA`, em uma linha, com `\n` no lugar das quebras.

## 4. Pegue os dados do Asaas

1. No sandbox, gere uma chave de API.
2. Consulte a sua carteira. Mantenha as aspas simples, porque a chave começa com `$`:

   ```sh
   curl -H 'access_token: SUA_CHAVE' -H 'User-Agent: condominios' https://api-sandbox.asaas.com/v3/wallets
   ```

3. Guarde o `id` da resposta para `ASAAS_WALLET_ID`.
4. Em **Integrações > Segurança**, habilite o split.

## 5. Publique na Vercel

1. Envie este código para o repositório privado e importe o projeto na Vercel. O arquivo `vercel.json` já define o build.
2. Antes de publicar, cadastre estas variáveis:

| Variável | Valor |
|---|---|
| `BASE_DOMAIN` | `seudominio` |
| `BRAND_NAME` | Nome da empresa |
| `NODE_ENV` | `production` |
| `TRUST_PROXY` | `1` |
| `DATABASE_URL` | Endereço da etapa 3 |
| `DB_POOL_MAX` | `2` |
| `DB_SSL_CA` | Certificado da etapa 3 |
| `ENCRYPTION_KEY` | Gere com o comando abaixo e guarde uma cópia segura |
| `JOBS_SECRET` | Valor aleatório longo |
| `CRON_SECRET` | O mesmo valor de `JOBS_SECRET` |
| `ASAAS_ENV` | `sandbox` |
| `ASAAS_API_KEY` | Chave da etapa 4 |
| `ASAAS_WALLET_ID` | Carteira da etapa 4 |
| `ASAAS_WEBHOOK_TOKEN` | Valor aleatório de 32 a 255 caracteres |

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Sem a `ENCRYPTION_KEY` original, as chaves das subcontas não podem mais ser lidas. Não troque esse valor depois do primeiro cadastro.

3. Publique. Se mudar alguma variável depois, publique de novo para ela valer.

A rotina diária já vem configurada para as 9h17 UTC. No plano Hobby, ela [pode rodar em qualquer momento dentro dessa hora](https://vercel.com/docs/cron-jobs/manage-cron-jobs).

## 6. Conecte o domínio

1. Em **Settings > Domains**, adicione `*.seudominio`. A Vercel vai mostrar os nameservers dela.
2. No painel do domínio, coloque esses nameservers.
3. Espere a propagação. A Vercel diz que ela [normalmente leva de 24 a 48 horas](https://vercel.com/docs/platforms/multi-tenant-platforms/limits).
4. Abra `https://admin.seudominio/healthz`. A resposta esperada é `{"ok":true}`.

Se o domínio gratuito não aceitar os nameservers da Vercel, use um DNS externo e [delegue a validação do certificado](https://vercel.com/docs/domains/working-with-domains/add-a-domain#use-wildcard-domains-with-an-external-dns-provider). Com a [DigitalPlat](https://github.com/DigitalPlatDev/FreeDomain/discussions/80048), a Cloudflare pode recusar o nome, e o deSEC é a alternativa indicada por usuários. Se isso travar o teste, troque por um `.com.br`.

## 7. Crie o seu acesso

No seu computador, crie um arquivo `.env` com `DATABASE_URL` e `DB_SSL_CA`, depois execute:

```sh
npm install
ADMIN_EMAIL=voce@empresa.com ADMIN_NAME="Seu nome" ADMIN_PASSWORD="senha-longa-aqui" npm run create-admin
```

Entre em `https://admin.seudominio`.

## 8. Configure o webhook da sua conta

No sandbox do Asaas, crie um webhook com a URL `https://admin.seudominio/webhooks/asaas/platform`, o token de `ASAAS_WEBHOOK_TOKEN` e os eventos `PAYMENT_*`.

Não é preciso configurar webhook de condomínio: o sistema cria um para cada subconta.

## 9. Teste de ponta a ponta

Faça este roteiro pelo painel e confira no Asaas. O sandbox [aprova contas automaticamente quando os dados são válidos e simula os pagamentos](https://docs.asaas.com/docs/sandbox).

- [ ] Cadastrar um condomínio com um CNPJ válido e abrir o endereço dele
- [ ] Criar a conta de recebimento e clicar em **Consultar agora** até aparecer **Aprovada**
- [ ] Começar a cobrar a mensalidade e simular o pagamento da fatura
- [ ] Entrar como síndico, trocar a senha e importar as unidades
- [ ] Emitir as cobranças do mês
- [ ] Simular o pagamento de uma cobrança e ver o azulejo ficar azul
- [ ] Conferir no Asaas se o repasse chegou à sua carteira, se tiver configurado um
- [ ] Testar uma cobrança vencida, um estorno e um cancelamento
- [ ] Criar acessos de morador e porteiro e testar um visitante
- [ ] Conferir que um usuário de um condomínio não entra em outro
- [ ] Chamar a rotina com o segredo e conferir que nada ficou divergente:

  ```sh
  curl -H 'x-jobs-secret: SEU_JOBS_SECRET' -X POST https://admin.seudominio/internal/jobs/run
  ```

O sandbox [nem sempre se comporta como a produção](https://docs.asaas.com/docs/sandbox), então passar neste roteiro não dispensa o teste real da próxima seção.

## 10. Antes do primeiro cliente real

1. Registre o domínio definitivo, se ainda estiver no gratuito.
2. Passe para Vercel Pro e Supabase Pro, e ative o backup do banco. Teste uma restauração.
3. [Peça a homologação ao Asaas](https://docs.asaas.com/docs/faq-periodo-de-avaliacao). Antes dela, o limite é de 10 subcontas, R$ 2.000 em cobranças por subconta e 60 dias.
4. Confirme com o gerente do Asaas:
   - Qual `companyType` usar para condomínio, já que a API não lista esse tipo.
   - Se condomínios e associações são aceitos no modelo sem BaaS.
   - Se a sua carteira pode receber o split das subcontas.
   - Como e com que tarifa o saldo segue para o banco do condomínio.
5. Comece com um banco novo. As subcontas do sandbox não valem em produção, e os webhooks delas apontam para o domínio de teste.
6. Gere novos valores para os segredos e troque `BASE_DOMAIN`, `DATABASE_URL`, `DB_SSL_CA`, `ASAAS_ENV`, `ASAAS_API_KEY` e `ASAAS_WALLET_ID`.
7. Refaça as etapas 3, 6, 7 e 8 no novo ambiente.
8. Faça uma cobrança real de baixo valor antes de abrir para clientes.

## Se algo falhar

| Sintoma | O que verificar |
|---|---|
| `/healthz` responde 503 | Variáveis ausentes ou inválidas; veja os logs da função |
| Tela de login da Vercel no endereço `.vercel.app` | Proteção de deployment; teste pelo seu domínio |
| Erro de certificado ao conectar no banco | `DB_SSL_CA` incompleto, ou `sslmode` na URL |
| Erro de senha ao conectar | Usuário sem `.REF_DO_PROJETO`, ou senha da etapa 3 |
| O banco parou de responder | Projeto pausado; restaure no painel do Supabase |
| Subdomínio sem certificado | Nameservers ainda não propagados |
| Webhook recusado | Token diferente de `ASAAS_WEBHOOK_TOKEN` |
| O Asaas recusa a subconta | Campos obrigatórios ou `companyType`; veja a mensagem no painel |
| A chave do Asaas é recusada | Chave de produção no sandbox, ou o contrário |
