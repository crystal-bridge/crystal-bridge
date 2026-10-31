import { createHash } from 'node:crypto';
import { RELEASE_REPO, kingdomTarballName } from '@crystal-bridge/protocol';

/**
 * Proves a downloaded Kingdom release came from this project's own release workflow, at that version's tag. The hub
 * only says which version to run and takes no part in this: a hub that was taken over can't get its own code run on a
 * Kingdom, because the proof comes from Sigstore's keys and a statement only that workflow can get signed.
 */
const OIDC_ISSUER = 'https://token.actions.githubusercontent.com';
const PROVENANCE = 'https://slsa.dev/provenance/v1';
const ATTESTATIONS_TIMEOUT_MS = 30_000;

export interface ProvenanceDeps {
  fetch: typeof fetch;
  /** Sigstore's root of trust, fetched through TUF in production. Only its type is known here. */
  trustedRoot: () => Promise<unknown>;
}

interface Statement {
  predicateType?: unknown;
  subject?: { name?: unknown; digest?: { sha256?: unknown } }[];
}

/** The release file holding its attestations, in the same shape as GitHub's API answers. `release.yml` writes it. */
export function attestationsName(version: string): string {
  return `crystal-bridge-attestations-${version}.json`;
}

/** One statement can cover the release's every file, so it's the name beside the digest that says what this file is. */
export function statementCovers(statement: unknown, version: string, digest: string): boolean {
  const { predicateType, subject } = (statement ?? {}) as Statement;
  if (predicateType !== PROVENANCE || !Array.isArray(subject)) return false;
  return subject.some((item) => item.name === kingdomTarballName(version) && item.digest?.sha256 === digest);
}

/**
 * Who may have signed a release: the release workflow at that version's own tag. A regular expression because Sigstore
 * treats its policy as one even when given a string, which left unanchored would let `1.2.0` match `v1.2.0-rc.1`.
 */
export function releaseIdentity(version: string): RegExp {
  const identity = `https://github.com/${RELEASE_REPO}/.github/workflows/release.yml@refs/tags/v${version}`;
  return new RegExp(`^${identity.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&')}$`);
}

function refused(version: string, why: string): Error {
  return new Error(`release ${version} failed its provenance check: ${why}`);
}

/**
 * A release's attestations: from the release itself, which has no rate limit, else from GitHub's API, which allows 60
 * anonymous calls an hour per address, for releases from before they carried the file. Where they come from adds no
 * trust, so nothing is lost by the fallback: the proof is Sigstore's signature.
 */
async function fetchAttestations(version: string, digest: string, deps: ProvenanceDeps): Promise<Response> {
  const signal = (): AbortSignal => AbortSignal.timeout(ATTESTATIONS_TIMEOUT_MS);
  const asset = `https://github.com/${RELEASE_REPO}/releases/download/v${version}/${attestationsName(version)}`;
  const carried = await deps.fetch(asset, { signal: signal() }).catch(() => undefined);
  if (carried?.ok) return carried;
  return deps.fetch(`https://api.github.com/repos/${RELEASE_REPO}/attestations/sha256:${digest}`, {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'crystal-bridge-kingdom' },
    signal: signal(),
  });
}

/** Throws unless a signed attestation names this exact file, built by the release workflow at this version's tag. */
export async function verifyRelease(tarball: Uint8Array, version: string, deps: ProvenanceDeps): Promise<void> {
  const digest = createHash('sha256').update(tarball).digest('hex');
  const response = await fetchAttestations(version, digest, deps);
  if (!response.ok) throw refused(version, `GitHub answered ${response.status}`);
  const { attestations } = (await response.json()) as { attestations?: { bundle?: unknown }[] };
  if (!attestations?.length) throw refused(version, 'it has no attestation');

  // Loaded here so an ordinary start doesn't pay for the crypto.
  const [{ Verifier, toSignedEntity, toTrustMaterial }, { bundleFromJSON }] = await Promise.all([
    import('@sigstore/verify'),
    import('@sigstore/bundle'),
  ]);
  const root = await deps.trustedRoot();
  const verifier = new Verifier(toTrustMaterial(root as Parameters<typeof toTrustMaterial>[0]));
  const policy = {
    subjectAlternativeName: releaseIdentity(version),
    extensions: { issuer: OIDC_ISSUER },
  };

  let why = 'no attestation covers this file';
  for (const { bundle } of attestations) {
    try {
      const parsed = bundleFromJSON(bundle);
      verifier.verify(toSignedEntity(parsed), policy);
      const envelope = parsed.content.$case === 'dsseEnvelope' ? parsed.content.dsseEnvelope : undefined;
      if (envelope && statementCovers(JSON.parse(envelope.payload.toString()), version, digest)) return;
    } catch (error) {
      why = error instanceof Error ? error.message : String(error);
    }
  }
  throw refused(version, why);
}
