import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LoginGate } from './LoginGate.js';

const app = <p>the app</p>;

function hub(routes: Record<string, () => Response>) {
  const calls = vi.fn(async (url: string) => routes[url]?.() ?? new Response('{}', { status: 404 }));
  vi.stubGlobal('fetch', calls);
  return calls;
}
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

describe('LoginGate', () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it('asks a new hub for its setup code, then shows the login once before going in', async () => {
    const calls = hub({
      '/api/me': () => json({ login: null, canLogIn: true, setup: true }),
      '/api/setup': () => json({ login: 'me', token: 'the-new-token' }),
    });
    render(<LoginGate>{app}</LoginGate>);
    fireEvent.change(await screen.findByLabelText('Setup code'), { target: { value: 'code-from-logs' } });
    fireEvent.change(screen.getByLabelText('Your login name'), { target: { value: 'me' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create login' }));

    expect(((await screen.findByLabelText('Your access token')) as HTMLInputElement).value).toBe('the-new-token');
    expect(screen.queryByText('the app')).toBeNull();
    const [, init] = calls.mock.calls.find(([url]) => url === '/api/setup') as unknown as [string, RequestInit];
    expect(JSON.parse(init.body as string)).toEqual({ code: 'code-from-logs', name: 'me' });

    fireEvent.click(screen.getByRole('button', { name: 'I saved it' }));
    expect(await screen.findByText('the app')).toBeTruthy();
  });

  it('shows why a setup code was refused', async () => {
    hub({
      '/api/me': () => json({ login: null, canLogIn: true, setup: true }),
      '/api/setup': () => json({ error: 'that setup code is wrong' }, 401),
    });
    render(<LoginGate>{app}</LoginGate>);
    fireEvent.change(await screen.findByLabelText('Setup code'), { target: { value: 'x' } });
    fireEvent.click(screen.getByRole('button', { name: 'Create login' }));
    expect((await screen.findByRole('alert')).textContent).toContain('wrong');
  });

  it('shows the app to someone logged in', async () => {
    hub({ '/api/me': () => json({ login: 'laptop', canLogIn: true }) });
    render(<LoginGate>{app}</LoginGate>);
    expect(await screen.findByText('the app')).toBeTruthy();
  });

  it('shows the app when the hub has no login page', async () => {
    hub({ '/api/me': () => json({ login: null, canLogIn: false }) });
    render(<LoginGate>{app}</LoginGate>);
    expect(await screen.findByText('the app')).toBeTruthy();
  });

  it('shows the app when the hub cannot be reached, which has its own banner', async () => {
    vi.stubGlobal('fetch', async () => Promise.reject(new TypeError('Failed to fetch')));
    render(<LoginGate>{app}</LoginGate>);
    expect(await screen.findByText('the app')).toBeTruthy();
  });

  it('asks for a token, then shows the app', async () => {
    hub({
      '/api/me': () => json({ login: null, canLogIn: true }),
      '/api/login': () => json({ login: 'laptop' }),
    });
    render(<LoginGate>{app}</LoginGate>);
    fireEvent.change(await screen.findByLabelText('Access token'), { target: { value: 'good' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    expect(await screen.findByText('the app')).toBeTruthy();
  });

  it('says so when the token is refused', async () => {
    hub({
      '/api/me': () => json({ login: null, canLogIn: true }),
      '/api/login': () => json({ error: 'that token is not valid' }, 401),
    });
    render(<LoginGate>{app}</LoginGate>);
    fireEvent.change(await screen.findByLabelText('Access token'), { target: { value: 'bad' } });
    fireEvent.click(screen.getByRole('button', { name: 'Log in' }));
    await waitFor(() => expect(screen.getByRole('alert').textContent).toContain('not valid'));
    expect(screen.queryByText('the app')).toBeNull();
  });
});
