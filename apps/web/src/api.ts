/** What the hub said went wrong, for a call the user made and should hear about. */
export async function refusal(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `The hub answered ${response.status}`);
}

/** What to say when a call never reached the hub, so there's no answer to read. */
export const UNREACHABLE = "Couldn't reach the hub. Check the connection and try again.";

let checking = false;

/**
 * A refused call may mean this browser's login was revoked or ran out. The socket can't tell: a refused upgrade looks
 * the same as a lost link, so the tab would show "Lost the connection" for good. If the hub has a login page and no
 * longer knows this browser, reloads into it, as logging out does. A burst of refusals asks once.
 */
export function checkLogin(): void {
  if (checking) return;
  checking = true;
  void fetch('/api/me')
    .then(async (response) => (await response.json()) as { login: string | null; canLogIn: boolean })
    .then(({ login, canLogIn }) => {
      if (login === null && canLogIn) window.location.reload();
    })
    .catch(() => {})
    .finally(() => {
      checking = false;
    });
}

/** What a Quest could use in a folder (a blank one is the Kingdom's home), asked of the Kingdom itself. */
export async function fetchInventory(
  node: string,
  cwd: string,
  signal: AbortSignal,
): Promise<{ engine: string; raw: unknown }[]> {
  const query = cwd ? `?cwd=${encodeURIComponent(cwd)}` : '';
  const response = await fetch(`/api/nodes/${encodeURIComponent(node)}/inventory${query}`, { signal });
  if (!response.ok) throw await refusal(response);
  const { events } = (await response.json()) as { events?: { engine: string; raw: unknown }[] };
  if (!Array.isArray(events)) throw new Error('The hub sent no list');
  return events;
}

export async function createJoinCode(node: string): Promise<{ code: string; expiresAt: number }> {
  const response = await fetch('/api/join-codes', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ node }),
  });
  if (!response.ok) throw await refusal(response);
  return (await response.json()) as { code: string; expiresAt: number };
}

export async function saveHubName(name: string): Promise<void> {
  const response = await fetch('/api/hub', {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  if (!response.ok) throw await refusal(response);
}
