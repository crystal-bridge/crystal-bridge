/** Where the user is in the app, kept in the URL's hash so a reload (or a shared link on the same device) returns there. */
export type Route =
  | { page: 'airship' }
  | { page: 'castle'; node: string }
  | { page: 'new'; node: string }
  | { page: 'quest'; node: string; session: string };

export function formatRoute(route: Route): string {
  if (route.page === 'airship') return '#/airship';
  const base = `#/k/${encodeURIComponent(route.node)}`;
  if (route.page === 'new') return `${base}/new`;
  if (route.page === 'quest') return `${base}/q/${encodeURIComponent(route.session)}`;
  return base;
}

export function parseRoute(hash: string): Route | null {
  const parts = hash.replace(/^#\/?/, '').split('/');
  try {
    if (parts.length === 1 && parts[0] === 'airship') return { page: 'airship' };
    if (parts[0] !== 'k' || !parts[1]) return null;
    const node = decodeURIComponent(parts[1]);
    if (parts.length === 2) return { page: 'castle', node };
    if (parts.length === 3 && parts[2] === 'new') return { page: 'new', node };
    if (parts.length === 4 && parts[2] === 'q' && parts[3]) {
      return { page: 'quest', node, session: decodeURIComponent(parts[3]) };
    }
  } catch {
    // A malformed escape: treat it as no route.
  }
  return null;
}
