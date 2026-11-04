import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { ApiError } from './lib.ts';

export function navigate(path: string) {
  history.pushState(null, '', path);
  window.dispatchEvent(new PopStateEvent('popstate'));
}

export function usePath() {
  const [path, setPath] = useState(location.pathname);
  useEffect(() => {
    const listener = () => setPath(location.pathname);
    window.addEventListener('popstate', listener);
    return () => window.removeEventListener('popstate', listener);
  }, []);
  return path;
}

export function useLoad<T>(load: () => Promise<T>, deps: unknown[]) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<string | null>(null);
  const latest = useRef(0);
  const reload = useCallback(() => {
    // Só a resposta mais recente vale: trocar de mês rápido não pode mostrar dados do mês anterior.
    const request = ++latest.current;
    setError(null);
    return load()
      .then((value) => { if (request === latest.current) setData(value); })
      .catch((e: Error) => { if (request === latest.current) setError(e.message); });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);
  useEffect(() => {
    void reload();
  }, [reload]);
  return { data, error, reload };
}

export function Link({ to, children, className }: { to: string; children: ReactNode; className?: string }) {
  return (
    <a
      href={to}
      className={className}
      onClick={(event) => {
        if (event.metaKey || event.ctrlKey) return;
        event.preventDefault();
        navigate(to);
      }}
    >
      {children}
    </a>
  );
}

export function Notice({ kind = 'error', children }: { kind?: 'error' | 'ok' | 'info'; children: ReactNode }) {
  return <p className={`notice notice-${kind}`} role={kind === 'error' ? 'alert' : 'status'}>{children}</p>;
}

export function Field({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <label className="field">
      <span className="field-label">{label}</span>
      {children}
      {hint && <span className="field-hint">{hint}</span>}
    </label>
  );
}

/** Botão que mostra o progresso e o erro de uma ação assíncrona. */
export function useAction() {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useCallback(async <T,>(fn: () => Promise<T>): Promise<T | undefined> => {
    setBusy(true);
    setError(null);
    try {
      return await fn();
    } catch (e) {
      setError(e instanceof ApiError || e instanceof Error ? e.message : 'Não foi possível concluir.');
      return undefined;
    } finally {
      setBusy(false);
    }
  }, []);
  return { busy, error, run, setError };
}

export function Loading({ error }: { error?: string | null }) {
  if (error) return <Notice>{error}</Notice>;
  return <p className="muted" aria-live="polite">Carregando…</p>;
}

export function Tabs({ items }: { items: Array<{ to: string; label: string; active: boolean }> }) {
  return (
    <nav className="tabs" aria-label="Principal">
      {items.map((item) => (
        <Link key={item.to} to={item.to} className={item.active ? 'tab tab-active' : 'tab'}>{item.label}</Link>
      ))}
    </nav>
  );
}
