import { cleanup, render, screen, within } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import type { FleetRow } from '../fleet.js';
import { logAttention, ShipsLog, type HubStatus } from './ShipsLog.js';

const DAY = 86_400_000;
const NOW = 100 * DAY;
const status: HubStatus = {
  release: '1.0.0',
  protocol: 4,
  uptimeMs: 2 * DAY,
  databaseBytes: 3_000_000,
  lastBackupAt: NOW - DAY,
};
const fleet: FleetRow[] = [
  { id: 'a', name: 'Alpha', connected: true, release: '1.0.0' },
  { id: 'b', name: 'Beta', connected: true, release: '1.0.0' },
];
const update = { version: '1.1.0', url: 'https://example.invalid/r', notes: 'What changed' };

const log = () => screen.getByRole('region', { name: "Ship's Log" });

describe('ShipsLog', () => {
  afterEach(() => cleanup());

  it('is one quiet line when all is well', () => {
    render(<ShipsLog status={status} fleet={fleet} now={NOW} />);
    expect(log().textContent).toContain('1.0.0');
    expect(log().textContent).toContain('2 Kingdoms on course');
    expect(log().querySelector('details')?.open).toBe(false);
  });

  it('keeps the health figures one click away', () => {
    render(<ShipsLog status={status} fleet={fleet} now={NOW} />);
    const details = within(log()).getByText('Details').closest('details')!;
    expect(details.textContent).toContain('Protocol 4');
    expect(details.textContent).toContain('2d');
    expect(details.textContent).toContain('3 MB');
    expect(details.textContent).toContain('1d ago');
    expect(details.textContent).toContain('Alpha');
  });

  it('leaves out what the hub can’t report', () => {
    render(<ShipsLog status={{ release: 'dev', protocol: 4, uptimeMs: 1000 }} fleet={[]} now={NOW} />);
    expect(log().textContent).not.toContain('Database');
    expect(log().textContent).not.toContain('Backup');
    expect(log().textContent).not.toContain('Mirror');
  });

  it('grows when an update is out: its notes, a link to them, and how to take it', () => {
    render(<ShipsLog status={{ ...status, update }} fleet={fleet} now={NOW} />);
    expect(log().textContent).toContain('1.1.0 is out');
    expect(log().textContent).toContain('What changed');
    expect(within(log()).getByRole('link', { name: 'Release notes' }).getAttribute('href')).toBe(update.url);
    expect(log().textContent).toContain('ghcr.io/crystal-bridge/airship:1.1.0');
    expect(log().textContent).toContain('deploy-airship-package.sh hub-host 1.1.0');
  });

  it('opens by itself when a Kingdom needs a look, and names it', () => {
    const behind = [fleet[0]!, { ...fleet[1]!, release: '0.9.0' }];
    render(<ShipsLog status={status} fleet={behind} now={NOW} />);
    expect(log().querySelector('details')?.open).toBe(true);
    expect(log().textContent).toContain('1 Kingdom needs a look');
    expect(log().textContent).toContain('0.9.0, behind 1.0.0');
  });

  it('says when the backup mirror has gone quiet', () => {
    render(<ShipsLog status={{ ...status, lastMirrorAt: NOW - 5 * DAY }} fleet={fleet} now={NOW} />);
    expect(log().querySelector('details')?.open).toBe(true);
    expect(log().textContent).toContain('Mirror 5d ago');
  });

  it('shows nothing until the hub has answered', () => {
    render(<ShipsLog fleet={fleet} now={NOW} />);
    expect(screen.queryByRole('region', { name: "Ship's Log" })).toBeNull();
  });
});

describe('logAttention', () => {
  it('counts an update, for the badge on the logo', () => {
    expect(logAttention(undefined)).toBe(0);
    expect(logAttention(status)).toBe(0);
    expect(logAttention({ ...status, update })).toBe(1);
  });
});
