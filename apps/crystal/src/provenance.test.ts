import { readFileSync } from 'node:fs';
import { TrustedRoot } from '@sigstore/protobuf-specs';
import { describe, expect, it, vi } from 'vitest';
import { releaseIdentity, statementCovers, verifyRelease } from './provenance.js';

/** The real, public v0.2.0-alpha.1 tarball, its attestation from GitHub, and Sigstore's root, so this runs offline. */
const fixture = (name: string) => new URL(`../test/fixtures/provenance/${name}`, import.meta.url);
const VERSION = '0.2.0-alpha.1';
const tarball = readFileSync(fixture(`crystal-bridge-kingdom-${VERSION}.tgz`));
const attestations = JSON.parse(readFileSync(fixture('attestations.json'), 'utf8')) as { attestations: unknown[] };
const trustedRoot = async () => TrustedRoot.fromJSON(JSON.parse(readFileSync(fixture('trusted_root.json'), 'utf8')));

const answering = (body: unknown, status = 200) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;

describe('verifyRelease', () => {
  it('accepts a release built by this repository’s release workflow at its own tag', async () => {
    const fetch = answering(attestations);
    await expect(verifyRelease(tarball, VERSION, { fetch, trustedRoot })).resolves.toBeUndefined();
    expect(vi.mocked(fetch).mock.calls[0]?.[0]).toBe(
      'https://api.github.com/repos/crystal-bridge/crystal-bridge/attestations/sha256:34ddcdd06023611d73dfdb5af84bc7e5a54d94742b20211600c76b995215f2f0',
    );
  });

  it('refuses a changed tarball', async () => {
    const changed = Buffer.from(tarball);
    changed[100] = changed[100]! ^ 1;
    await expect(verifyRelease(changed, VERSION, { fetch: answering(attestations), trustedRoot })).rejects.toThrow(
      /provenance/,
    );
  });

  it('refuses a real release offered as another version, so an old one can’t pass as new', async () => {
    await expect(verifyRelease(tarball, '0.2.0', { fetch: answering(attestations), trustedRoot })).rejects.toThrow(
      /provenance/,
    );
  });

  it('refuses a tampered statement, whatever it claims', async () => {
    const [attestation] = attestations.attestations as { bundle: { dsseEnvelope: { payload: string } } }[];
    const payload = Buffer.from(attestation!.bundle.dsseEnvelope.payload, 'base64');
    payload[10] = payload[10]! ^ 1;
    const forged = structuredClone(attestations) as typeof attestations;
    (forged.attestations[0] as typeof attestation)!.bundle.dsseEnvelope.payload = payload.toString('base64');
    await expect(verifyRelease(tarball, VERSION, { fetch: answering(forged), trustedRoot })).rejects.toThrow(
      /provenance/,
    );
  });

  it('refuses a release with no attestation', async () => {
    await expect(
      verifyRelease(tarball, VERSION, { fetch: answering({ attestations: [] }), trustedRoot }),
    ).rejects.toThrow(/provenance/);
    await expect(
      verifyRelease(tarball, VERSION, { fetch: answering({ message: 'Not Found' }, 404), trustedRoot }),
    ).rejects.toThrow(/provenance/);
  });
});

describe('releaseIdentity', () => {
  const workflow = 'https://github.com/crystal-bridge/crystal-bridge/.github/workflows/release.yml';

  it('matches the release workflow at exactly that tag', () => {
    expect(releaseIdentity('1.2.0').test(`${workflow}@refs/tags/v1.2.0`)).toBe(true);
    expect(releaseIdentity('1.2.0-rc.1').test(`${workflow}@refs/tags/v1.2.0-rc.1`)).toBe(true);
  });

  it.each([
    ['a longer tag', `${workflow}@refs/tags/v1.2.0-rc.1`],
    ['a dot matched as a wildcard', `${workflow}@refs/tags/v1x2x0`],
    ['a branch', `${workflow}@refs/heads/v1.2.0`],
    ['another workflow', `${workflow.replace('release', 'other')}@refs/tags/v1.2.0`],
    ['another repository’s text around it', `https://evil.example/${workflow}@refs/tags/v1.2.0`],
  ])('refuses %s', (_, identity) => {
    expect(releaseIdentity('1.2.0').test(identity)).toBe(false);
  });
});

describe('statementCovers', () => {
  const digest = 'ab'.repeat(32);
  const statement = {
    predicateType: 'https://slsa.dev/provenance/v1',
    subject: [
      { name: 'crystal-bridge-airship-1.0.0.tgz', digest: { sha256: 'cd'.repeat(32) } },
      { name: 'crystal-bridge-kingdom-1.0.0.tgz', digest: { sha256: digest } },
    ],
  };

  it('finds the tarball among the release’s files', () => {
    expect(statementCovers(statement, '1.0.0', digest)).toBe(true);
  });

  it('refuses the hub package, which the same statement also covers', () => {
    expect(statementCovers(statement, '1.0.0', 'cd'.repeat(32))).toBe(false);
  });

  it('refuses a name for another version, and anything that isn’t build provenance', () => {
    expect(statementCovers(statement, '1.0.1', digest)).toBe(false);
    expect(statementCovers({ ...statement, predicateType: 'https://example.com/other' }, '1.0.0', digest)).toBe(false);
    expect(statementCovers({}, '1.0.0', digest)).toBe(false);
    expect(statementCovers(null, '1.0.0', digest)).toBe(false);
  });
});
