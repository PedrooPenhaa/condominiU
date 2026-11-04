import { useEffect, useMemo, useState, type FormEvent } from 'react';
import { api, CHARGE_LABEL, currentCompetence, dateBr, money, moneyWhole, monthLabel, parseMoney, ROLE_LABEL, shiftMonth } from './lib.ts';
import { Field, Loading, navigate, Notice, Tabs, useAction, useLoad, usePath } from './ui.tsx';

export function TenantApp({ me, context, onLogout }: { me: any; context: any; onLogout: () => void }) {
  const path = usePath();
  const { data, error } = useLoad(() => api('/condo'), []);
  useEffect(() => {
    if (!data) return;
    const home = data.role === 'morador' ? '/minhas-cobrancas' : data.role === 'porteiro' ? '/visitantes' : '/';
    if (path === '/' && home !== '/') navigate(home);
  }, [data, path]);
  if (!data) return <main className="center"><Loading error={error} /></main>;
  const { condominium, role } = data;
  const manager = ['sindico', 'gestor', 'plataforma'].includes(role);
  const tabs = [
    ...(manager ? [
      { to: '/', label: 'Pagamentos', active: path === '/' },
      { to: '/unidades', label: 'Unidades', active: path === '/unidades' },
    ] : []),
    ...(role === 'morador' ? [{ to: '/minhas-cobrancas', label: 'Minhas cobranças', active: path === '/minhas-cobrancas' }] : []),
    { to: '/visitantes', label: 'Visitantes', active: path === '/visitantes' },
    ...(manager ? [{ to: '/acessos', label: 'Acessos', active: path === '/acessos' }] : []),
  ];
  return (
    <div className="shell">
      <header className="topbar">
        <strong className="brand">{condominium.name}</strong>
        <Tabs items={tabs} />
        <span className="topbar-user">{me.user.name}</span>
        <button className="link" onClick={onLogout}>Sair</button>
      </header>
      {condominium.status === 'suspenso' && <Notice kind="info">Este condomínio está suspenso. Você pode consultar os dados, mas alterações estão bloqueadas.</Notice>}
      <main className="page">
        {path === '/unidades' && manager ? <Units condominium={condominium} />
          : path === '/acessos' && manager ? <Members />
          : path === '/visitantes' ? <Visitors condominium={condominium} role={role} />
          : path === '/minhas-cobrancas' ? <MyCharges />
          : manager ? <Payments condominium={condominium} />
          : null}
      </main>
    </div>
  );
}

function tileClass(status: string | null) {
  if (status === 'paga') return 'tile tile-paid';
  if (status === 'confirmada') return 'tile tile-confirmed';
  if (status === 'vencida' || status === 'contestada') return 'tile tile-overdue';
  if (status === 'pendente') return 'tile tile-open';
  if (status === 'falhou' || status === 'criando') return 'tile tile-failed';
  return 'tile tile-none';
}

/** Giro fixo por unidade: o painel lembra as composições de azulejos de Athos Bulcão. */
function tileTurn(text: string) {
  let sum = 0;
  for (const ch of text) sum = (sum * 31 + ch.charCodeAt(0)) >>> 0;
  return `turn-${sum % 4}`;
}

function Payments({ condominium }: { condominium: any }) {
  const [competence, setCompetence] = useState(currentCompetence());
  const { data, error, reload } = useLoad(() => api(`/condo/summary?competence=${competence}`), [competence]);
  const [selected, setSelected] = useState<any>(null);
  const [showGenerate, setShowGenerate] = useState(false);
  const groups = useMemo(() => {
    const map = new Map<string, any[]>();
    for (const tile of data?.tiles ?? []) {
      const key = tile.block || '';
      map.set(key, [...(map.get(key) ?? []), tile]);
    }
    return [...map.entries()];
  }, [data]);
  if (!data) return <Loading error={error} />;
  const canCharge = condominium.status === 'ativo';
  const blockWord = condominium.kind === 'casas' ? 'Quadra' : 'Bloco';

  return (
    <>
      <section className="statement">
        <div className="month-nav">
          <button aria-label="Mês anterior" className="icon" onClick={() => { setCompetence(shiftMonth(competence, -1)); setSelected(null); }}>‹</button>
          <span>{monthLabel(competence)}</span>
          <button aria-label="Próximo mês" className="icon" onClick={() => { setCompetence(shiftMonth(competence, 1)); setSelected(null); }}>›</button>
        </div>
        <h1>{moneyWhole(data.paid_cents)} recebidos de {moneyWhole(data.expected_cents)}</h1>
        <dl className="facts">
          <div><dt>Unidades pagas</dt><dd>{data.paid_count}</dd></div>
          <div><dt>Em aberto</dt><dd>{data.pending_count}</dd></div>
          <div><dt>Vencidas</dt><dd className={data.overdue_count ? 'alert-text' : ''}>{data.overdue_count}</dd></div>
          <div><dt>Valor vencido</dt><dd className={data.overdue_count ? 'alert-text' : ''}>{money(data.overdue_cents)}</dd></div>
        </dl>
      </section>

      {!canCharge && (
        <Notice kind="info">As cobranças ficam disponíveis depois que a conta de recebimento for aprovada. A administradora acompanha essa etapa com você.</Notice>
      )}

      <div className="section-head">
        <h2>Painel de unidades</h2>
        <button className="primary" disabled={!canCharge} onClick={() => setShowGenerate((v) => !v)}>Gerar cobranças de {monthLabel(competence).split(' ')[0]}</button>
      </div>
      {showGenerate && <Generate competence={competence} onDone={() => { void reload(); }} />}

      {data.tiles.length === 0 ? (
        <p className="empty">Cadastre as unidades para ver o painel. Você pode colar uma planilha inteira na aba Unidades.</p>
      ) : (
        <div className="board-wrap">
          <div className="board">
            {groups.map(([block, tiles]) => (
              <section key={block} aria-label={block ? `${blockWord} ${block}` : 'Unidades'}>
                {block && <h3 className="block-name">{blockWord} {block}</h3>}
                <div className="tiles">
                  {tiles.map((tile: any) => (
                    <button
                      key={tile.id}
                      className={`${tileClass(tile.charge_status)} ${tileTurn(`${tile.block}${tile.number}`)}${selected?.id === tile.id ? ' tile-selected' : ''}`}
                      aria-label={`Unidade ${tile.block} ${tile.number}: ${tile.charge_status ? CHARGE_LABEL[tile.charge_status] : 'sem cobrança'}`}
                      aria-pressed={selected?.id === tile.id}
                      onClick={() => setSelected(tile)}
                    >
                      <span>{tile.number}</span>
                    </button>
                  ))}
                </div>
              </section>
            ))}
          </div>
          <aside className="detail" aria-live="polite">
            {selected ? <UnitDetail tile={selected} competence={competence} onChanged={async () => { await reload(); setSelected(null); }} /> : <Legend />}
          </aside>
        </div>
      )}
    </>
  );
}

function Legend() {
  const rows: Array<[string, string]> = [
    ['tile-paid', 'Paga'], ['tile-confirmed', 'Paga, saldo a liberar'], ['tile-open', 'Em aberto'],
    ['tile-overdue', 'Vencida'], ['tile-failed', 'Não emitida'], ['tile-none', 'Sem cobrança'],
  ];
  return (
    <>
      <h3>Como ler</h3>
      <ul className="legend">
        {rows.map(([cls, label]) => <li key={cls}><span className={`tile tile-mini ${cls}`} aria-hidden="true" />{label}</li>)}
      </ul>
      <p className="muted">Toque em uma unidade para ver a cobrança e o pagador.</p>
    </>
  );
}

function UnitDetail({ tile, competence, onChanged }: { tile: any; competence: string; onChanged: () => void }) {
  const { busy, error, run } = useAction();
  const canCancel = ['pendente', 'vencida', 'criando', 'falhou'].includes(tile.charge_status);
  return (
    <>
      <h3>{tile.block ? `${tile.block} ` : ''}{tile.number}</h3>
      <dl className="facts facts-stack">
        <div><dt>Pagador</dt><dd>{tile.payer_name ?? 'Não cadastrado'}</dd></div>
        <div><dt>Situação em {monthLabel(competence)}</dt><dd>{tile.charge_status ? CHARGE_LABEL[tile.charge_status] : 'Sem cobrança'}</dd></div>
        {tile.value_cents && <div><dt>Valor</dt><dd>{money(tile.value_cents)}</dd></div>}
        {tile.due_date && <div><dt>Vencimento</dt><dd>{dateBr(tile.due_date)}</dd></div>}
      </dl>
      {tile.last_error && <Notice>{tile.last_error}</Notice>}
      {error && <Notice>{error}</Notice>}
      <div className="actions">
        {tile.invoice_url && <a className="button" href={tile.invoice_url} target="_blank" rel="noreferrer">Abrir fatura</a>}
        {canCancel && tile.charge_id && (
          <button className="link danger" disabled={busy} onClick={() => run(async () => { await api(`/condo/charges/${tile.charge_id}/cancel`, { method: 'POST' }); onChanged(); })}>Cancelar cobrança</button>
        )}
      </div>
    </>
  );
}

function Generate({ competence, onDone }: { competence: string; onDone: () => void }) {
  const [dueDate, setDueDate] = useState(`${competence}-10`);
  const [description, setDescription] = useState('');
  const [result, setResult] = useState<any>(null);
  const { busy, error, run } = useAction();
  return (
    <form
      className="inline-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          setResult(await api('/condo/charges/generate', { method: 'POST', body: { competence, dueDate, description: description || undefined } }));
          onDone();
        });
      }}
    >
      <Field label="Vencimento"><input type="date" required value={dueDate} onChange={(e) => setDueDate(e.target.value)} /></Field>
      <Field label="Descrição (opcional)"><input placeholder={`Taxa condominial ${competence.slice(5)}/${competence.slice(0, 4)}`} value={description} onChange={(e) => setDescription(e.target.value)} /></Field>
      <button className="primary" disabled={busy}>{busy ? 'Emitindo…' : 'Emitir cobranças'}</button>
      {error && <Notice>{error}</Notice>}
      {result && (
        <div className="result">
          <Notice kind={result.failed.length ? 'info' : 'ok'}>
            {result.created} emitidas. {result.alreadyExisting > 0 && `${result.alreadyExisting} já existiam. `}
            {result.withoutPayer.length > 0 && `Sem pagador cadastrado: ${result.withoutPayer.join(', ')}. `}
          </Notice>
          {result.failed.map((f: any) => <Notice key={f.unit}>{f.unit}: {f.reason}</Notice>)}
        </div>
      )}
    </form>
  );
}

function Units({ condominium }: { condominium: any }) {
  const { data, error, reload } = useLoad(() => api<any[]>('/condo/units'), []);
  const [mode, setMode] = useState<'none' | 'one' | 'import'>('none');
  const [editing, setEditing] = useState<any>(null);
  if (!data) return <Loading error={error} />;
  const houses = condominium.kind === 'casas';
  return (
    <>
      <div className="section-head">
        <h1>Unidades</h1>
        <div className="actions">
          <button onClick={() => setMode(mode === 'import' ? 'none' : 'import')}>Colar planilha</button>
          <button className="primary" onClick={() => setMode(mode === 'one' ? 'none' : 'one')}>Adicionar unidade</button>
        </div>
      </div>
      {mode === 'one' && <AddUnit houses={houses} onDone={() => { void reload(); setMode('none'); }} />}
      {mode === 'import' && <ImportUnits houses={houses} onDone={() => void reload()} />}
      {data.length === 0 ? <p className="empty">Cole a planilha de unidades para cadastrar todas de uma vez.</p> : (
        <div className="table-box">
          <table>
            <thead><tr><th>{houses ? 'Quadra' : 'Bloco'}</th><th>Número</th><th className="num">Taxa mensal</th><th>Pagador</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {data.map((u) => (
                <tr key={u.id}>
                  <td>{u.block}</td><td>{u.number}</td><td className="num">{money(u.fee_cents)}</td>
                  <td>{u.payer_name ?? <span className="alert-text">Sem pagador</span>}</td>
                  <td>{u.active ? 'Ativa' : 'Inativa'}</td>
                  <td><button className="link" onClick={() => setEditing(u)}>Editar</button></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {editing && <EditUnit unit={editing} onClose={() => setEditing(null)} onDone={() => { void reload(); setEditing(null); }} />}
    </>
  );
}

function PayerFields({ value, onChange }: { value: any; onChange: (v: any) => void }) {
  const set = (key: string) => (e: { target: { value: string } }) => onChange({ ...value, [key]: e.target.value });
  return (
    <>
      <Field label="Nome do pagador"><input value={value.name} onChange={set('name')} /></Field>
      <Field label="CPF ou CNPJ"><input value={value.cpfCnpj} onChange={set('cpfCnpj')} /></Field>
      <Field label="E-mail"><input type="email" value={value.email} onChange={set('email')} /></Field>
      <Field label="Celular"><input type="tel" value={value.mobilePhone} onChange={set('mobilePhone')} /></Field>
    </>
  );
}

const emptyPayer = { name: '', cpfCnpj: '', email: '', mobilePhone: '' };

function AddUnit({ houses, onDone }: { houses: boolean; onDone: () => void }) {
  const [block, setBlock] = useState('');
  const [number, setNumber] = useState('');
  const [fee, setFee] = useState('');
  const [payer, setPayer] = useState(emptyPayer);
  const { busy, error, run, setError } = useAction();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const feeCents = parseMoney(fee);
    if (feeCents === null) return setError('Confira o valor da taxa.');
    void run(async () => {
      await api('/condo/units', { method: 'POST', body: { kind: houses ? 'casa' : 'apartamento', block, number, feeCents, payer: payer.name ? payer : null } });
      onDone();
    });
  };
  return (
    <form className="panel-form" onSubmit={submit}>
      <div className="grid-3">
        <Field label={houses ? 'Quadra (opcional)' : 'Bloco'}><input value={block} onChange={(e) => setBlock(e.target.value)} /></Field>
        <Field label="Número"><input required value={number} onChange={(e) => setNumber(e.target.value)} /></Field>
        <Field label="Taxa mensal (R$)"><input required inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} /></Field>
        <PayerFields value={payer} onChange={setPayer} />
      </div>
      {error && <Notice>{error}</Notice>}
      <button className="primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar unidade'}</button>
    </form>
  );
}

function EditUnit({ unit, onClose, onDone }: { unit: any; onClose: () => void; onDone: () => void }) {
  const [fee, setFee] = useState((unit.fee_cents / 100).toFixed(2).replace('.', ','));
  const [active, setActive] = useState(unit.active);
  const [payer, setPayer] = useState({ ...emptyPayer, name: unit.payer_name ?? '', email: unit.payer_email ?? '', mobilePhone: unit.payer_phone ?? '' });
  const { busy, error, run, setError } = useAction();
  return (
    <form
      className="panel-form"
      onSubmit={(event) => {
        event.preventDefault();
        const feeCents = parseMoney(fee);
        if (feeCents === null) return setError('Confira o valor da taxa.');
        void run(async () => {
          await api(`/condo/units/${unit.id}`, { method: 'PATCH', body: { feeCents, active } });
          if (payer.cpfCnpj) await api(`/condo/units/${unit.id}/payer`, { method: 'PUT', body: payer });
          onDone();
        });
      }}
    >
      <h2>Unidade {unit.block} {unit.number}</h2>
      <div className="grid-3">
        <Field label="Taxa mensal (R$)"><input inputMode="decimal" value={fee} onChange={(e) => setFee(e.target.value)} /></Field>
        <Field label="Situação">
          <select value={active ? 'sim' : 'nao'} onChange={(e) => setActive(e.target.value === 'sim')}>
            <option value="sim">Ativa</option><option value="nao">Inativa</option>
          </select>
        </Field>
        <PayerFields value={payer} onChange={setPayer} />
      </div>
      <p className="field-hint">Para trocar ou atualizar o pagador, informe o CPF ou CNPJ dele.</p>
      {error && <Notice>{error}</Notice>}
      <div className="actions">
        <button className="primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar alterações'}</button>
        <button type="button" onClick={onClose}>Fechar</button>
      </div>
    </form>
  );
}

function ImportUnits({ houses, onDone }: { houses: boolean; onDone: () => void }) {
  const [text, setText] = useState('');
  const [result, setResult] = useState<any>(null);
  const { busy, error, run } = useAction();
  return (
    <form
      className="panel-form"
      onSubmit={(event) => {
        event.preventDefault();
        void run(async () => {
          setResult(await api('/condo/units/import', { method: 'POST', body: { kind: houses ? 'casa' : 'apartamento', text } }));
          onDone();
        });
      }}
    >
      <Field label="Cole as linhas da planilha" hint="Colunas: bloco ou quadra; número; taxa; pagador; CPF; e-mail; celular. Separe por ponto e vírgula ou cole direto do Excel.">
        <textarea rows={6} required value={text} placeholder={'A;101;850,00;Ana Souza;52998224725;ana@email.com;61999990000'} onChange={(e) => setText(e.target.value)} />
      </Field>
      {error && <Notice>{error}</Notice>}
      {result && <Notice kind={result.errors.length ? 'info' : 'ok'}>{result.created} unidades cadastradas.</Notice>}
      {result?.errors.map((e: any) => <Notice key={e.line}>Linha {e.line}: {e.reason}</Notice>)}
      <button className="primary" disabled={busy}>{busy ? 'Importando…' : 'Importar unidades'}</button>
    </form>
  );
}

function Members() {
  const members = useLoad(() => api<any[]>('/condo/members'), []);
  const units = useLoad(() => api<any[]>('/condo/units'), []);
  const [form, setForm] = useState({ name: '', email: '', role: 'morador', unitId: '' });
  const [created, setCreated] = useState<any>(null);
  const { busy, error, run } = useAction();
  if (!members.data || !units.data) return <Loading error={members.error ?? units.error} />;
  return (
    <>
      <h1>Acessos</h1>
      <form
        className="panel-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            setCreated(await api('/condo/members', { method: 'POST', body: { ...form, unitId: form.unitId || null } }));
            setForm({ name: '', email: '', role: 'morador', unitId: '' });
            void members.reload();
          });
        }}
      >
        <div className="grid-3">
          <Field label="Nome"><input required value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></Field>
          <Field label="E-mail"><input type="email" required value={form.email} onChange={(e) => setForm({ ...form, email: e.target.value })} /></Field>
          <Field label="Perfil">
            <select value={form.role} onChange={(e) => setForm({ ...form, role: e.target.value })}>
              <option value="morador">Morador</option><option value="porteiro">Porteiro</option><option value="gestor">Gestor</option>
            </select>
          </Field>
          {form.role === 'morador' && (
            <Field label="Unidade">
              <select required value={form.unitId} onChange={(e) => setForm({ ...form, unitId: e.target.value })}>
                <option value="">Escolha</option>
                {units.data.map((u) => <option key={u.id} value={u.id}>{u.block} {u.number}</option>)}
              </select>
            </Field>
          )}
        </div>
        {error && <Notice>{error}</Notice>}
        {created && (
          <Notice kind="ok">
            {created.temporaryPassword ? <>Acesso criado. Senha temporária de {created.email}: <code>{created.temporaryPassword}</code>. Ela aparece só agora.</> : <>Acesso liberado para {created.email}, que usa a senha atual.</>}
          </Notice>
        )}
        <button className="primary" disabled={busy}>{busy ? 'Criando…' : 'Criar acesso'}</button>
      </form>
      <div className="table-box">
        <table>
          <thead><tr><th>Nome</th><th>E-mail</th><th>Perfil</th><th>Unidade</th></tr></thead>
          <tbody>
            {members.data.map((m) => (
              <tr key={m.id}><td>{m.name}</td><td>{m.email}</td><td>{ROLE_LABEL[m.role]}</td><td>{m.number ? `${m.block} ${m.number}` : ''}</td></tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  );
}

function Visitors({ condominium, role }: { condominium: any; role: string }) {
  const passes = useLoad(() => api<any[]>('/condo/visitors'), []);
  const staff = role !== 'morador';
  const units = useLoad(() => (staff ? api<any[]>('/condo/units') : Promise.resolve([])), []);
  const [name, setName] = useState('');
  const [unitId, setUnitId] = useState('');
  const [created, setCreated] = useState<any>(null);
  const [code, setCode] = useState('');
  const [entered, setEntered] = useState<any>(null);
  const create = useAction();
  const entry = useAction();
  const canCheckIn = condominium.has_concierge ? staff : true;
  if (!passes.data) return <Loading error={passes.error} />;
  return (
    <>
      <h1>Visitantes</h1>
      <p className="muted">
        {condominium.has_concierge
          ? 'O morador autoriza e a portaria confere o código na chegada.'
          : 'Sem portaria: o morador autoriza e registra a entrada com o código.'}
      </p>
      <div className="split">
        {role !== 'porteiro' && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              void create.run(async () => {
                setCreated(await api('/condo/visitors', { method: 'POST', body: { visitorName: name, unitId: unitId || null, validHours: 24 } }));
                setName('');
                void passes.reload();
              });
            }}
          >
            <h2>Autorizar visitante</h2>
            <Field label="Nome do visitante"><input required value={name} onChange={(e) => setName(e.target.value)} /></Field>
            {staff && (
              <Field label="Unidade">
                <select required value={unitId} onChange={(e) => setUnitId(e.target.value)}>
                  <option value="">Escolha</option>
                  {(units.data ?? []).map((u: any) => <option key={u.id} value={u.id}>{u.block} {u.number}</option>)}
                </select>
              </Field>
            )}
            {create.error && <Notice>{create.error}</Notice>}
            {created && <Notice kind="ok">Código de {created.visitor_name}: <code>{created.code}</code>, válido por 24 horas.</Notice>}
            <button className="primary" disabled={create.busy}>Gerar código</button>
          </form>
        )}
        {canCheckIn && (
          <form
            onSubmit={(event) => {
              event.preventDefault();
              setEntered(null);
              void entry.run(async () => {
                setEntered(await api('/condo/visitors/check-in', { method: 'POST', body: { code } }));
                setCode('');
                void passes.reload();
              });
            }}
          >
            <h2>Registrar entrada</h2>
            <Field label="Código de 6 dígitos"><input required inputMode="numeric" pattern="\d{6}" className="code-input" value={code} onChange={(e) => setCode(e.target.value)} /></Field>
            {entry.error && <Notice>{entry.error}</Notice>}
            {entered && <Notice kind="ok">Entrada de {entered.visitor_name} registrada.</Notice>}
            <button className="primary" disabled={entry.busy}>Registrar entrada</button>
          </form>
        )}
      </div>
      <h2>Últimos 30 dias</h2>
      {passes.data.length === 0 ? <p className="empty">Nenhum visitante autorizado ainda.</p> : (
        <div className="table-box">
          <table>
            <thead><tr><th>Visitante</th><th>Unidade</th><th>Código</th><th>Situação</th></tr></thead>
            <tbody>
              {passes.data.map((p) => (
                <tr key={p.id}>
                  <td>{p.visitor_name}</td><td>{p.block} {p.number}</td><td><code>{p.code}</code></td>
                  <td>{p.status === 'entrou' ? `Entrou em ${dateBr(p.checked_in_at)}` : p.expired ? 'Venceu' : p.status === 'cancelado' ? 'Cancelado' : 'Autorizado'}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

function MyCharges() {
  const { data, error } = useLoad(() => api<any[]>('/condo/my-charges'), []);
  if (!data) return <Loading error={error} />;
  return (
    <>
      <h1>Minhas cobranças</h1>
      {data.length === 0 ? <p className="empty">Suas cobranças aparecem aqui assim que forem emitidas.</p> : (
        <div className="table-box">
          <table>
            <thead><tr><th>Descrição</th><th>Vencimento</th><th className="num">Valor</th><th>Situação</th><th /></tr></thead>
            <tbody>
              {data.map((c) => (
                <tr key={c.id}>
                  <td>{c.description}</td><td>{dateBr(c.due_date)}</td><td className="num">{money(c.value_cents)}</td>
                  <td><span className={`pill pill-charge-${c.status}`}>{CHARGE_LABEL[c.status]}</span></td>
                  <td>{c.invoice_url && !['paga', 'confirmada'].includes(c.status) && <a className="button" href={c.invoice_url} target="_blank" rel="noreferrer">Pagar</a>}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}
