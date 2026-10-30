import { describe, expect, it } from 'vitest';
import { hubPaths } from './paths.js';

describe('hubPaths', () => {
  it('keeps everything in AIRSHIP_DATA when it is set', () => {
    expect(hubPaths({ AIRSHIP_DATA: '/data' })).toEqual({
      db: '/data/airship.db',
      nodes: '/data/nodes.json',
      tokens: '/data/access-tokens.json',
      vapid: '/data/vapid.json',
      backups: '/data/backups',
    });
  });

  it('lets a single path override it', () => {
    expect(hubPaths({ AIRSHIP_DATA: '/data', AIRSHIP_DB: '/fast/hub.db' }).db).toBe('/fast/hub.db');
  });

  it('keeps today-s behaviour with no AIRSHIP_DATA: node tokens stay opt-in, the rest beside the database', () => {
    expect(hubPaths({ AIRSHIP_DB: '/var/lib/airship/airship.db' })).toEqual({
      db: '/var/lib/airship/airship.db',
      nodes: undefined,
      tokens: '/var/lib/airship/access-tokens.json',
      vapid: '/var/lib/airship/vapid.json',
      backups: './backups',
    });
    expect(hubPaths({}).db).toBe('./airship.db');
  });
});
