import { useState, type FormEvent } from 'react';
import { api, APPROVAL_LABEL, CHARGE_LABEL, CONDO_LABEL, dateBr, KIND_LABEL, money, moneyWhole, parseMoney } from './lib.ts';
import { Field, Link, Loading, navigate, Notice, Tabs, useAction, useLoad, usePath } from './ui.tsx';

function slugify(name: string) {
  return name.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 50);
}

export function AdminApp({ me, brand, hostOf, onLogout }: { me: any; brand: string; hostOf: (slug: string) => string; onLogout: () => void }) {
  const path = usePath();
  const detail = /^\/condominios\/([0-9a-f-]{36})$/.exec(path);
  return (
    <div className="shell">
      <header className="topbar">
        <strong className="brand">{brand}</strong>
        <Tabs items={[
          { to: '/', label: 'Condomínios', active: path === '/' || path.startsWith('/condominios') },
          { to: '/mensalidades', label: 'Mensalidades', active: path === '/mensalidades' },
        ]} />
        <span className="topbar-user">{me.user.name}</span>
        <button className="link" onClick={onLogout}>Sair</button>
      </header>
      <main className="page">
        {path === '/mensalidades' ? <Invoices />
          : path === '/condominios/novo' ? <NewCondominium hostOf={hostOf} />
          : detail ? <CondominiumDetail id={detail[1]!} />
          : <Overview hostOf={hostOf} />}
      </main>
    </div>
  );
}

function Overview({ hostOf }: { hostOf: (slug: string) => string }) {
  const dashboard = useLoad(() => api('/platform/dashboard'), []);
  const list = useLoad(() => api<any[]>('/platform/condominiums'), []);
  if (!dashboard.data || !list.data) return <Loading error={dashboard.error ?? list.error} />;
  const d = dashboard.data;
  return (
    <>
      <section className="statement">
        <h1>
          {d.active === 1 ? '1 condomínio ativo' : `${d.active} condomínios ativos`} pagando {moneyWhole(d.mrr_cents)} por mês
        </h1>
        <dl className="facts">
          <div><dt>Recebido neste mês</dt><dd>{money(d.paid_month_cents + d.split_month_cents)}</dd></div>
          <div><dt>Mensalidades vencidas</dt><dd className={d.overdue_count ? 'alert-text' : ''}>{money(d.overdue_cents)}</dd></div>
          <div><dt>Em implantação</dt><dd>{d.onboarding}</dd></div>
          <div><dt>Pago pelos moradores neste mês</dt><dd>{money(d.volume_month_cents)}</dd></div>
        </dl>
      </section>
      <div className="section-head">
        <h2>Condomínios</h2>
        <Link to="/condominios/novo" className="button primary">Cadastrar condomínio</Link>
      </div>
      {list.data.length === 0 ? (
        <p className="empty">Cadastre o primeiro condomínio para gerar o endereço e o acesso do síndico.</p>
      ) : (
        <div className="table-box">
          <table>
            <thead><tr><th>Condomínio</th><th>Endereço</th><th>Tipo</th><th className="num">Unidades</th><th className="num">Mensalidade</th><th>Situação</th></tr></thead>
            <tbody>
              {list.data.map((c) => (
                <tr key={c.id}>
                  <td><Link to={`/condominios/${c.id}`}>{c.name}</Link></td>
                  <td className="muted">{hostOf(c.slug)}</td>
                  <td>{KIND_LABEL[c.kind]}{c.has_concierge ? ', com portaria' : ', sem portaria'}</td>
                  <td className="num">{c.unit_count}</td>
                  <td className="num">{money(c.fee_monthly_cents)}</td>
                  <td>
                    <span className={`pill pill-${c.status}`}>{CONDO_LABEL[c.status]}</span>
                    {c.overdue_invoices > 0 && <span className="pill pill-suspenso">Mensalidade vencida</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function NewCondominium({ hostOf }: { hostOf: (slug: string) => string }) {
  const [form, setForm] = useState<Record<string, any>>({
    name: '', slug: '', kind: 'predio', hasConcierge: 'sim', legalNature: 'condominio_edilicio', cnpj: '', email: '', mobilePhone: '',
    postalCode: '', address: '', addressNumber: '', complement: '', province: '', monthlyIncome: '', feeMonthly: '197,00',
    feeSplitType: 'none', feeSplitValue: '', billingDueDay: '10', managerName: '', managerEmail: '',
  });
  const [slugTouched, setSlugTouched] = useState(false);
  const [created, setCreated] = useState<any>(null);
  const { busy, error, run, setError } = useAction();
  const set = (key: string) => (event: { target: { value: string } }) => setForm((f) => ({ ...f, [key]: event.target.value }));
  const slug = slugTouched ? form.slug : slugify(form.name);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const monthlyIncomeCents = parseMoney(form.monthlyIncome);
    const feeMonthlyCents = parseMoney(form.feeMonthly);
    if (monthlyIncomeCents === null || feeMonthlyCents === null) return setError('Confira os valores em reais.');
    const raw = Number(String(form.feeSplitValue || '0').replace(',', '.'));
    if (!Number.isFinite(raw)) return setError('Confira o valor do repasse.');
    void run(async () => {
      const result = await api('/platform/condominiums', {
        method: 'POST',
        body: {
          name: form.name, slug, kind: form.kind, hasConcierge: form.hasConcierge === 'sim', legalNature: form.legalNature,
          cnpj: form.cnpj, email: form.email, mobilePhone: form.mobilePhone, address: form.address, addressNumber: form.addressNumber,
          complement: form.complement, province: form.province, postalCode: form.postalCode, monthlyIncomeCents, feeMonthlyCents,
          feeSplitType: form.feeSplitType, feeSplitValue: form.feeSplitType === 'none' ? 0 : Math.round(raw * 100),
          billingDueDay: Number(form.billingDueDay), managerName: form.managerName, managerEmail: form.managerEmail,
        },
      });
      setCreated(result);
    });
  };

  if (created) {
    return (
      <section className="narrow">
        <h1>{created.condominium.name} cadastrado</h1>
        <p>Envie estes dados ao síndico. A senha aparece só agora e precisa ser trocada no primeiro acesso.</p>
        <dl className="credentials">
          <div><dt>Endereço</dt><dd><a href={created.condominium.panel_url}>{created.condominium.panel_url}</a></dd></div>
          <div><dt>E-mail</dt><dd>{created.manager.email}</dd></div>
          <div><dt>Senha temporária</dt><dd><code>{created.manager.temporaryPassword ?? 'Este e-mail já tem cadastro e usa a senha atual.'}</code></dd></div>
        </dl>
        <Link to={`/condominios/${created.condominium.id}`} className="button primary">Criar a conta de recebimento</Link>
      </section>
    );
  }

  return (
    <form className="form-page" onSubmit={submit}>
      <h1>Cadastrar condomínio</h1>
      <fieldset>
        <legend>Identificação</legend>
        <div className="grid-2">
          <Field label="Nome"><input required value={form.name} onChange={set('name')} /></Field>
          <Field label="Endereço do painel" hint={hostOf(slug || 'seucondominio')}>
            <input required pattern="[a-z0-9-]+" value={slug} onChange={(e) => { setSlugTouched(true); setForm((f) => ({ ...f, slug: e.target.value })); }} />
          </Field>
          <Field label="Tipo">
            <select value={form.kind} onChange={set('kind')}>
              <option value="predio">Prédios</option><option value="casas">Casas</option><option value="misto">Prédios e casas</option>
            </select>
          </Field>
          <Field label="Portaria">
            <select value={form.hasConcierge} onChange={set('hasConcierge')}>
              <option value="sim">Com porteiro</option><option value="nao">Sem porteiro</option>
            </select>
          </Field>
          <Field label="Natureza jurídica">
            <select value={form.legalNature} onChange={set('legalNature')}>
              <option value="condominio_edilicio">Condomínio com convenção</option><option value="associacao">Associação de moradores</option><option value="outro">Outra</option>
            </select>
          </Field>
          <Field label="CNPJ"><input required value={form.cnpj} onChange={set('cnpj')} /></Field>
        </div>
      </fieldset>
      <fieldset>
        <legend>Contato e endereço para a conta de recebimento</legend>
        <div className="grid-2">
          <Field label="E-mail do condomínio" hint="O Asaas envia a ativação da conta para este e-mail."><input type="email" required value={form.email} onChange={set('email')} /></Field>
          <Field label="Celular"><input type="tel" required value={form.mobilePhone} onChange={set('mobilePhone')} /></Field>
          <Field label="CEP"><input required inputMode="numeric" value={form.postalCode} onChange={set('postalCode')} /></Field>
          <Field label="Logradouro"><input required value={form.address} onChange={set('address')} /></Field>
          <Field label="Número"><input required value={form.addressNumber} onChange={set('addressNumber')} /></Field>
          <Field label="Complemento"><input value={form.complement} onChange={set('complement')} /></Field>
          <Field label="Bairro ou região"><input required value={form.province} onChange={set('province')} /></Field>
          <Field label="Arrecadação mensal estimada" hint="O Asaas exige este dado."><input required inputMode="decimal" placeholder="50.000,00" value={form.monthlyIncome} onChange={set('monthlyIncome')} /></Field>
        </div>
      </fieldset>
      <fieldset>
        <legend>O que você recebe</legend>
        <div className="grid-2">
          <Field label="Mensalidade do sistema" hint="Cobrada do condomínio, cai na sua conta."><input required inputMode="decimal" value={form.feeMonthly} onChange={set('feeMonthly')} /></Field>
          <Field label="Dia de vencimento"><input type="number" min={1} max={28} required value={form.billingDueDay} onChange={set('billingDueDay')} /></Field>
          <Field label="Repasse por boleto pago" hint="Sai automaticamente de cada pagamento de morador.">
            <select value={form.feeSplitType} onChange={set('feeSplitType')}>
              <option value="none">Sem repasse</option><option value="fixed">Valor fixo em reais</option><option value="percent">Percentual</option>
            </select>
          </Field>
          {form.feeSplitType !== 'none' && (
            <Field label={form.feeSplitType === 'fixed' ? 'Valor do repasse (R$)' : 'Percentual do repasse (%)'}>
              <input required inputMode="decimal" value={form.feeSplitValue} onChange={set('feeSplitValue')} />
            </Field>
          )}
        </div>
      </fieldset>
      <fieldset>
        <legend>Síndico</legend>
        <div className="grid-2">
          <Field label="Nome"><input required value={form.managerName} onChange={set('managerName')} /></Field>
          <Field label="E-mail"><input type="email" required value={form.managerEmail} onChange={set('managerEmail')} /></Field>
        </div>
      </fieldset>
      {error && <Notice>{error}</Notice>}
      <div className="actions">
        <button className="primary" disabled={busy}>{busy ? 'Cadastrando…' : 'Cadastrar condomínio'}</button>
        <Link to="/" className="button">Voltar</Link>
      </div>
    </form>
  );
}

function CondominiumDetail({ id }: { id: string }) {
  const { data, error, reload } = useLoad(() => api(`/platform/condominiums/${id}`), [id]);
  const action = useAction();
  const [confirmCancel, setConfirmCancel] = useState(false);
  if (!data) return <Loading error={error} />;
  const c = data.condominium;
  const act = (path: string, body?: unknown) => action.run(async () => {
    await api(`/platform/condominiums/${id}/${path}`, { method: 'POST', body });
    await reload();
  });
  const accountDone = c.has_receiving_account;
  const approved = c.asaas_approval === 'aprovada';
  const billing = Boolean(c.platform_subscription_id);

  return (
    <>
      <p className="crumb"><Link to="/">Condomínios</Link></p>
      <div className="section-head">
        <div>
          <h1>{c.name}</h1>
          <p className="muted"><a href={c.panel_url}>{c.panel_url}</a></p>
        </div>
        <span className={`pill pill-${c.status}`}>{CONDO_LABEL[c.status]}</span>
      </div>
      {action.error && <Notice>{action.error}</Notice>}

      <ol className="steps">
        <li className={accountDone ? 'done' : ''}>
          <h3>Conta de recebimento</h3>
          {accountDone
            ? <p>Criada no CNPJ do condomínio. O dinheiro dos moradores entra nela.</p>
            : <><p>Cria uma subconta Asaas no CNPJ do condomínio.</p><button className="primary" disabled={action.busy} onClick={() => act('provision')}>Criar conta de recebimento</button></>}
        </li>
        <li className={approved ? 'done' : ''}>
          <h3>Aprovação dos documentos</h3>
          <p>{APPROVAL_LABEL[c.asaas_approval]}</p>
          {!approved && accountDone && <button disabled={action.busy} onClick={() => act('sync-approval')}>Consultar agora</button>}
        </li>
        <li className={billing ? 'done' : ''}>
          <h3>Sua mensalidade: {money(c.fee_monthly_cents)}</h3>
          {billing
            ? <p>Cobrança ativa, com vencimento todo dia {c.billing_due_day}.</p>
            : <><p>Inicia a cobrança mensal para a sua conta.</p><button className="primary" disabled={action.busy || !approved} onClick={() => act('billing', { billingType: 'UNDEFINED' })}>Começar a cobrar</button></>}
        </li>
      </ol>

      <div className="split">
        <Fees condominium={c} onSaved={reload} />
        <section>
          <h2>Uso</h2>
          <dl className="facts facts-stack">
            <div><dt>Unidades ativas</dt><dd>{data.usage.units}</dd></div>
            <div><dt>Recebido dos moradores</dt><dd>{money(data.usage.received_cents)}</dd></div>
            <div><dt>Portaria</dt><dd>{c.has_concierge ? 'Com porteiro' : 'Sem porteiro'}</dd></div>
          </dl>
          <h3>Responsáveis</h3>
          <ul className="plain">
            {data.managers.map((m: any) => <li key={m.email}>{m.name}, {m.email}</li>)}
          </ul>
        </section>
      </div>

      <h2>Mensalidades deste condomínio</h2>
      {data.invoices.length === 0 ? <p className="empty">As faturas aparecem aqui depois que a cobrança começar.</p> : <InvoiceTable rows={data.invoices} />}

      <div className="danger-zone">
        {c.status === 'ativo' && <button disabled={action.busy} onClick={() => act('status', { status: 'suspenso' })}>Suspender acesso</button>}
        {c.status === 'suspenso' && <button disabled={action.busy} onClick={() => act('status', { status: 'ativo' })}>Reativar acesso</button>}
        {c.status !== 'cancelado' && !confirmCancel && <button className="link danger" onClick={() => setConfirmCancel(true)}>Cancelar contrato</button>}
        {confirmCancel && c.status !== 'cancelado' && (
          <>
            <span>A assinatura será encerrada e o painel sairá do ar.</span>
            <button className="danger-solid" disabled={action.busy} onClick={async () => { await act('status', { status: 'cancelado' }); navigate('/'); }}>Confirmar cancelamento</button>
            <button className="link" onClick={() => setConfirmCancel(false)}>Manter contrato</button>
          </>
        )}
      </div>
    </>
  );
}

function Fees({ condominium: c, onSaved }: { condominium: any; onSaved: () => void }) {
  const [fee, setFee] = useState(((c.fee_monthly_cents ?? 0) / 100).toFixed(2).replace('.', ','));
  const [type, setType] = useState(c.fee_split_type);
  const [value, setValue] = useState(c.fee_split_type === 'none' ? '' : (c.fee_split_value / 100).toFixed(2).replace('.', ','));
  const [day, setDay] = useState(String(c.billing_due_day));
  const [saved, setSaved] = useState(false);
  const { busy, error, run, setError } = useAction();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        setSaved(false);
        const cents = parseMoney(fee);
        const splitValue = type === 'none' ? 0 : parseMoney(value);
        if (cents === null || splitValue === null) return setError('Confira os valores.');
        void run(async () => {
          await api(`/platform/condominiums/${c.id}/fees`, { method: 'PATCH', body: { feeMonthlyCents: cents, feeSplitType: type, feeSplitValue: splitValue, billingDueDay: Number(day) } });
          setSaved(true);
          onSaved();
        });
      }}
    >
      <h2>O que você recebe</h2>
      <Field label="Mensalidade (R$)"><input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} /></Field>
      <Field label="Dia de vencimento"><input type="number" min={1} max={28} value={day} onChange={(e) => setDay(e.target.value)} /></Field>
      <Field label="Repasse por boleto pago">
        <select value={type} onChange={(e) => setType(e.target.value)}>
          <option value="none">Sem repasse</option><option value="fixed">Valor fixo em reais</option><option value="percent">Percentual</option>
        </select>
      </Field>
      {type !== 'none' && <Field label={type === 'fixed' ? 'Valor (R$)' : 'Percentual (%)'}><input inputMode="decimal" value={value} onChange={(e) => setValue(e.target.value)} /></Field>}
      <p className="field-hint">Mudanças no repasse valem para as próximas cobranças.</p>
      {error && <Notice>{error}</Notice>}
      {saved && <Notice kind="ok">Valores salvos.</Notice>}
      <button disabled={busy}>{busy ? 'Salvando…' : 'Salvar valores'}</button>
    </form>
  );
}

function InvoiceTable({ rows, showCondominium }: { rows: any[]; showCondominium?: boolean }) {
  return (
    <div className="table-box">
      <table>
        <thead><tr>{showCondominium && <th>Condomínio</th>}<th>Vencimento</th><th className="num">Valor</th><th>Situação</th><th>Pago em</th><th>Fatura</th></tr></thead>
        <tbody>
          {rows.map((i) => (
            <tr key={i.id}>
              {showCondominium && <td><Link to={`/condominios/${i.condominium_id}`}>{i.condominium_name}</Link></td>}
              <td>{dateBr(i.due_date)}</td>
              <td className="num">{money(i.value_cents)}</td>
              <td><span className={`pill pill-charge-${i.status}`}>{CHARGE_LABEL[i.status]}</span></td>
              <td>{dateBr(i.paid_at)}</td>
              <td>{i.invoice_url && <a href={i.invoice_url} target="_blank" rel="noreferrer">Abrir</a>}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function Invoices() {
  const { data, error } = useLoad(() => api<any[]>('/platform/invoices'), []);
  if (!data) return <Loading error={error} />;
  return (
    <>
      <h1>Mensalidades</h1>
      {data.length === 0 ? <p className="empty">As faturas aparecem aqui quando a primeira cobrança for gerada.</p> : <InvoiceTable rows={data} showCondominium />}
    </>
  );
}
