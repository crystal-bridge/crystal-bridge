/** What the hub said went wrong, for a call the user made and should hear about. */
export async function refusal(response: Response): Promise<Error> {
  const body = (await response.json().catch(() => ({}))) as { error?: string };
  return new Error(body.error ?? `The hub answered ${response.status}`);
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
