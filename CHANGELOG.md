# Changelog

Notable changes, newest first. Versions follow [semantic versioning](https://semver.org) once releases start; until
then, everything is in Unreleased.

## Unreleased

### Added

- A Quest's Stats fit every plan: HP is the shortest limit the plan has, a new Stamina bar shows a longer one when
  there is one, a bar's tooltip names its limit, and a bar warns when its limit says it's nearly out.
- Windows Kingdoms: `join` and `leave` work there through a sign-in task that needs no administrator, which restarts
  Crystal after a crash, and both engines run Quests, whether `claude` came from the native or the npm install.
- The Castle offers Update Claude Code when a Kingdom's CLI is behind, running the CLI's own update while no Quest
  there is busy.
- A Quest's tab shows its project under the title.
- Split View's picker shows each Quest's project beside its Kingdom, except for a Discreet Kingdom.
- A docs site built from `docs/` with VitePress, and a configuration reference that a test holds to the code.
- Cmd+Enter (Ctrl+Enter off a Mac) starts a Quest from the New Quest prompt.
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

- Choose the colour of your own prompts in Config. The default is a muted purple, so blue only ever means "look here".

- The hub comes as a container image for amd64 and arm64, with token login on by default.
- The hub builds into an installable package, `@crystal-bridge/airship`, with the web app inside. `AIRSHIP_HOST` sets the address it listens on and `AIRSHIP_DATA` keeps everything in one folder.
- `pnpm demo` runs the app with a scripted world in it, with no `claude` and nothing kept.
- The Tavern knows what's waiting after a reload or on a new device.

### Changed

- The Settings button uses a gear-and-hammer from the icon set, in place of a hand-drawn pixel gear.
- Theme words: Gold for cost; Wizard, Cleric and Rogue Classes; a finished turn reads "Battle won".

### Fixed

- Background subagents stay in the Party until they finish, on both engines, and count as Side Quests on battle cards.
  A Quest whose only work is a background agent no longer idles out.

### Security

- `AIRSHIP_AUTH=token` is the hub's own login, with long-lived access tokens. It ignores identity headers, so a hub can sit behind any proxy.
- Node tokens take effect without a hub restart, and revoking one cuts that Kingdom's connection at once.
- The hub refuses to start without an allow list and node tokens, unless it is a development hub.
- `docs/SECURITY-MODEL.md` documents the trust boundaries and the identity header's limits.
