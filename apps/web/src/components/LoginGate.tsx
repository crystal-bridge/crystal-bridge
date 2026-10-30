import { type FormEvent, type ReactNode, useEffect, useState } from 'react';
import { createJoinCode, refusal, saveHubName } from '../api.js';
import { FirstRunSteps } from './FirstRunSteps.js';

const FORM = 'w-full max-w-sm space-y-3';
const SUBMIT = 'rounded-md bg-blue-600 px-4 py-2 text-sm font-bold text-white hover:bg-blue-700';

function Page({ children }: { children: ReactNode }) {
  return (
    <main className="flex h-dvh items-center justify-center bg-neutral-100 p-4 text-neutral-900 dark:bg-neutral-950 dark:text-neutral-100">
      {children}
    </main>
  );
}

function Refusal({ error }: { error: string | null }) {
  if (!error) return null;
  return (
    <p role="alert" className="text-sm text-red-600 dark:text-red-400">
      {error}
    </p>
  );
}

/** A new hub's first login, made with the one-time code from its logs. */
function FirstLogin({ onMade }: { onMade: (token: string) => void }) {
  const [code, setCode] = useState('');
  const [name, setName] = useState('me');
  const [error, setError] = useState<string | null>(null);

  async function submit(event: FormEvent): Promise<void> {
    event.preventDefault();
    setError(null);
    const response = await fetch('/api/setup', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ code, name }),
    });
    if (response.ok) onMade(((await response.json()) as { token: string }).token);
    else setError((await refusal(response)).message);
  }

  return (
    <form onSubmit={(event) => void submit(event)} className={FORM}>
      <h1 className="cb-display text-4xl leading-none">Crystal Bridge</h1>
      <p className="text-sm">
        This hub has no logins yet. Its logs show a one-time setup code; enter it to make yours.
      </p>
      <input
        aria-label="Setup code"
        placeholder="Setup code"
        autoComplete="off"
        value={code}
        onChange={(event) => setCode(event.target.value)}
        className="cb-field w-full"
      />
      <input
        aria-label="Your login name"
        placeholder="Your login name"
        autoComplete="off"
        value={name}
        onChange={(event) => setName(event.target.value)}
        className="cb-field w-full"
      />
      <button type="submit" className={SUBMIT}>
        Create login
      </button>
      <Refusal error={error} />
    </form>
  );
}

/** The new login's token, which the hub keeps only as a hash, so this is the one time anyone can see it. */
function ShowToken({ token, onDone }: { token: string; onDone: () => void }) {
  return (
    <div className={FORM}>
      <h1 className="cb-display text-4xl leading-none">Crystal Bridge</h1>
      <p className="text-sm">
        This browser is logged in. Save this token somewhere safe: it logs you in on other devices, and it won&apos;t be
        shown again.
      </p>
      <input
        readOnly
        aria-label="Your access token"
        value={token}
        onFocus={(event) => event.target.select()}
        className="cb-field w-full font-mono text-xs"
      />
      <button type="button" onClick={onDone} className={SUBMIT}>
        I saved it
      </button>
    </div>
  );
}

/** Shows the app to anyone the hub knows, or to anyone at all on a hub with no login page; asks everyone else in. */
export function LoginGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<'checking' | 'in' | 'out' | 'setup' | 'steps'>('checking');
  const [newToken, setNewToken] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    fetch('/api/me')
      .then(async (response) => (await response.json()) as { login: string | null; canLogIn: boolean; setup?: boolean })
      .then(({ login, canLogIn, setup }) => setState(setup ? 'setup' : login === null && canLogIn ? 'out' : 'in'))
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
    if (response.ok) setState('in');
    else setError((await refusal(response)).message);
  }

  if (newToken) {
    return (
      <Page>
        <ShowToken
          token={newToken}
          onDone={() => {
            setNewToken(null);
            setState('steps');
          }}
        />
      </Page>
    );
  }
  if (state === 'in') return children;
  if (state === 'checking') return null;
  if (state === 'steps') {
    return (
      <Page>
        <FirstRunSteps onName={saveHubName} onCreateJoinCode={createJoinCode} onDone={() => setState('in')} />
      </Page>
    );
  }
  if (state === 'setup') {
    return (
      <Page>
        <FirstLogin onMade={setNewToken} />
      </Page>
    );
  }
  return (
    <Page>
      <form onSubmit={(event) => void submit(event)} className={FORM}>
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
        <button type="submit" className={SUBMIT}>
          Log in
        </button>
        <Refusal error={error} />
      </form>
    </Page>
  );
}
