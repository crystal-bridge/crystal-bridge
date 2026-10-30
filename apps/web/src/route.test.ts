import { describe, expect, it } from 'vitest';
import { formatRoute, parseRoute, type Route } from './route.js';

describe('route', () => {
  const routes: [Route, string][] = [
    [{ page: 'airship' }, '#/airship'],
    [{ page: 'castle', node: 'node-a' }, '#/k/node-a'],
    [{ page: 'new', node: 'node-a' }, '#/k/node-a/new'],
    [{ page: 'quest', node: 'node a/b', session: 'q-1' }, '#/k/node%20a%2Fb/q/q-1'],
  ];

  it('writes where the user is as a hash, and reads it back', () => {
    for (const [route, hash] of routes) {
      expect(formatRoute(route)).toBe(hash);
      expect(parseRoute(hash)).toEqual(route);
    }
  });

  it('reads nothing from an empty or unknown hash', () => {
    for (const hash of ['', '#', '#/', '#/k', '#/k/a/zzz', '#/other', '#/k/a/q/']) expect(parseRoute(hash)).toBeNull();
  });
});
