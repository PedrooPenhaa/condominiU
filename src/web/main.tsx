import { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { AdminApp } from './admin.tsx';
import { api } from './lib.ts';
import { TenantApp } from './tenant.tsx';
import { Field, Loading, Notice, useAction } from './ui.tsx';

function Login({ context, onDone }: { context: any; onDone: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const { busy, error, run } = useAction();
  const title = context.host === 'platform' ? 'Administração' : context.condominium?.name ?? context.brand;
  return (
    <main className="login">
      <div className="login-panel" aria-hidden="true" />
      <form
        className="login-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await api('/auth/login', { method: 'POST', body: { email, password } });
            onDone();
          });
        }}
      >
        <p className="muted">{context.brand}</p>
        <h1>{title}</h1>
        {error && <Notice>{error}</Notice>}
        <Field label="E-mail">
          <input type="email" autoComplete="username" required value={email} onChange={(e) => setEmail(e.target.value)} />
        </Field>
        <Field label="Senha">
          <input type="password" autoComplete="current-password" required value={password} onChange={(e) => setPassword(e.target.value)} />
        </Field>
        <button className="primary" disabled={busy}>{busy ? 'Entrando…' : 'Entrar'}</button>
      </form>
    </main>
  );
}

function ChangePassword({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState('');
  const [next, setNext] = useState('');
  const { busy, error, run } = useAction();
  return (
    <main className="login">
      <div className="login-panel" aria-hidden="true" />
      <form
        className="login-form"
        onSubmit={(event) => {
          event.preventDefault();
          void run(async () => {
            await api('/auth/change-password', { method: 'POST', body: { current, next } });
            onDone();
          });
        }}
      >
        <h1>Crie sua senha</h1>
        <p>A senha que você recebeu é temporária. Escolha uma nova para continuar.</p>
        {error && <Notice>{error}</Notice>}
        <Field label="Senha temporária">
          <input type="password" autoComplete="current-password" required value={current} onChange={(e) => setCurrent(e.target.value)} />
        </Field>
        <Field label="Nova senha" hint="Use ao menos 10 caracteres.">
          <input type="password" autoComplete="new-password" required minLength={10} value={next} onChange={(e) => setNext(e.target.value)} />
        </Field>
        <button className="primary" disabled={busy}>{busy ? 'Salvando…' : 'Salvar nova senha'}</button>
      </form>
    </main>
  );
}

function App() {
  const [context, setContext] = useState<any>(null);
  const [me, setMe] = useState<any>(undefined);
  const [error, setError] = useState<string | null>(null);

  const loadMe = () =>
    api('/me').then(setMe).catch((e) => {
      if (e.status === 401) setMe(null);
      else setError(e.message);
    });

  useEffect(() => {
    api('/context')
      .then((data) => {
        setContext(data);
        document.title = data.condominium?.name ?? (data.host === 'platform' ? `Administração: ${data.brand}` : data.brand);
        return loadMe();
      })
      .catch((e) => setError(e.message));
  }, []);

  const logout = async () => {
    await api('/auth/logout', { method: 'POST' }).catch(() => undefined);
    setMe(null);
  };

  if (error) {
    return <main className="center"><h1>Endereço indisponível</h1><Notice>{error}</Notice></main>;
  }
  if (!context || me === undefined) return <main className="center"><Loading /></main>;
  if (context.host === 'root' || context.host === 'api') {
    return (
      <main className="center">
        <h1>{context.brand}</h1>
        <p>Entre pelo endereço do seu condomínio, no formato seucondominio.{context.base_domain}.</p>
      </main>
    );
  }
  if (!me) return <Login context={context} onDone={loadMe} />;
  if (me.user.must_change_password) return <ChangePassword onDone={loadMe} />;
  if (context.host === 'platform') return <AdminApp me={me} brand={context.brand} baseDomain={context.base_domain} onLogout={logout} />;
  return <TenantApp me={me} context={context} onLogout={logout} />;
}

createRoot(document.getElementById('root')!).render(<App />);
