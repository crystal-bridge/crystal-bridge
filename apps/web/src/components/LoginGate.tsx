import { type FormEvent, type ReactNode, useEffect, useState } from 'react';

/** Shows the app to anyone the hub knows, or to anyone at all on a hub with no login page; asks everyone else in. */
export function LoginGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'in' | 'out'>('checking');
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/me')
      .then(async (response) => (await response.json()) as { login: string | null; canLogIn: boolean })
      .then(({ login, canLogIn }) => setState(login === null && canLogIn ? 'out' : 'in'))
      // No answer isn't a refusal: the app has its own banner for a hub it can't reach.
      .catch(() => setState('in'));
  }, []);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const response = await fetch('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token }),
    });
    if (response.ok) {
      setState('in');
    } else {
      const body = (await response.json().catch(() => ({}))) as { error?: string };
      setError(body.error ?? `The hub answered ${response.status}`);
    }
  }

  if (state === 'in') return children;
  if (state === 'checking') return null;
  return (
    <main className="flex h-dvh items-center justify-center bg-neutral-100 p-4 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      <form onSubmit={(event) => void submit(event)} className="w-full max-w-sm space-y-3">
        <h1 className="cb-display text-4xl leading-none">Crystal Bridge</h1>
        <input
          type="password"
          aria-label="Access token"
          placeholder="Access token"
          autoComplete="current-password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          className="cb-field w-full"
        />
        <button
          type="submit"
          className="rounded-md bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700"
        >
          Log in
        </button>
        {error && (
          <p role="alert" className="text-sm text-red-600 dark:text-red-400">
            {error}
          </p>
        )}
      </form>
    </main>
  );
}
