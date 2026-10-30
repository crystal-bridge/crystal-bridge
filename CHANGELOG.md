# Changelog

Notable changes, newest first. Versions follow [semantic versioning](https://semver.org) once releases start; until
then, everything is in Unreleased.

## Unreleased

### Added

- Kingdoms, Quests, approvals and question cards, Split View, Web Push, found-session adoption, the Airship home.
- The interactive engine (experimental), with recovery when the terminal swallows a typed message.
- Theme words for each kind of step on the Party card; shell mode in the prompt box; toolbar icons; in-app Credits.
- `scripts/deploy-all.sh` with a deploy config outside the repo; deploys say why a Quest counts as busy.
- Git hooks and CI: formatting, types, tests, the repo scrub and a secret scan.
- The Kingdom agent builds into one installable package, `@crystal-bridge/kingdom`, and a `v*` tag publishes its
  tarball to a GitHub Release with build provenance.

- The Castle warns when a Kingdom's version is older than the hub's, and a refused Kingdom logs why.
- The Castle shows each Kingdom's Claude Code version and when an update is available.
- `docs/OPERATIONS.md` states which hub and Kingdom releases work together.

- The hub makes one-time join codes that trade for a new Kingdom's token, and a Kingdom can give up its own token.

- Add Kingdom in Config gives one command to run on a new machine, and Remove on a Castle takes a Kingdom away.
- `crystal-bridge-kingdom join` and `leave` turn a Linux or macOS machine into a Kingdom and back, with one command.

### Changed

- Theme words: Gold for cost; Wizard, Cleric and Rogue Classes; a finished turn reads "Battle won".

### Security

- Node tokens take effect without a hub restart, and revoking one cuts that Kingdom's connection at once.
- The hub refuses to start without an allow list and node tokens, unless it is a development hub.
- `docs/SECURITY-MODEL.md` documents the trust boundaries and the identity header's limits.
