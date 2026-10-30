# Crystal Bridge

A hub to start, watch and approve coding-agent sessions across machines. It runs in daily use and is being prepared
for a public release.

**Maintainer notes.** If `.private/HANDOFF.md` exists, read it first for the current state and next tasks. In a git
worktree the folder isn't checked out; look in the main checkout instead (`$(git rev-parse --git-common-dir)/..`).
Other contributors won't have it: the issues and the docs in `docs/` cover the product.

## Rules

- **Run the unmodified `claude` binary under the machine's own login.** Never pass `--bare` (it needs an API key),
  never read, copy or relay anything from Claude's credential files or keychain. Anthropic's terms allow a user's
  own subscription only through the unmodified CLI; the Agent SDK requires an API key.
- **Permission prompts use the documented `--permission-prompt-tool mcp__crystal__approve`**, not the SDK-internal
  `stdio` form.
- **The hub stores raw engine output (Claude stream-json lines) inside an engine-neutral envelope.** Nothing
  engine-specific becomes a table column.
- **No Claude model names anywhere in the repo:** code, comments, fixtures, docs, commit messages. Re-recorded
  fixtures go through the scrub in `apps/crystal/scripts/capture.ts`, which also strips home paths, emails and
  rate-limit usage.
- **This repository is public.** Everything committed is published, including commit metadata: keep secrets, host
  names, tailnet names, identities and home paths out (the git hooks and CI scan for them).
- **Commits:** the author is the noreply identity set in the repo-local git config, with no AI attribution or
  Co-Authored-By lines, and conventional messages (`feat(crystal): ...`). Work on a branch; never push to `main`
  directly.
- **Test first.** Each change starts with a failing test, then the fix. Before calling anything done, run
  `pnpm format`, `pnpm test`, `pnpm typecheck` and, for anything touching the runtime path, `pnpm smoke` against a
  running `pnpm dev`, and show the output.
- **Docs ship with the change.** If a change affects anything the README or `docs/` describe, update them in the same
  PR, not in a later pass.
- **The system is in daily use.** Follow `docs/OPERATIONS.md`: deploy only the pushed `main`, keep the node protocol
  additive, never edit a shipped migration, and prefer a deploy that waits over `--force`.
- **Build for anyone, not just one homelab.** Keep it harness-agnostic: a Kingdom may run no harness or any popular
  one, so never depend on a particular plugin, hook or skill being installed. Keep host names, tailnet names and
  identities out of code and UI (config, args and docs only). Prefer seams a fork can swap: one module for theme
  words, one stylesheet for theme tokens, data-driven rules (e.g. Hero Classes) over hard-coded ones, and the
  engine/adapter boundaries already in the protocol.
- **Formatting is Prettier** (`.prettierrc.json`). Don't hand-format; run `pnpm format`, and `pnpm format:check`
  must pass.

## Layout

- `packages/protocol` holds the Zod message schemas shared by everything.
- `apps/crystal` is the node agent. It runs `claude` (`src/session.ts`, and `src/interactive.ts` for the interactive
  engine), the MCP permission tool (`src/permissions.ts`) and the link to the hub (`src/node.ts`). Recorded real CLI
  output and what it taught us are in `test/fixtures/` and its README.
- `apps/airship` is the hub: a SQLite store (`src/store.ts`) and the Fastify/WebSocket server (`src/server.ts`).
- `apps/web` is the React client. `src/model.ts` turns events into view items and `src/hub.ts` is the WebSocket.
- `scripts/` holds the tools check (`preflight.sh`), the deploy scripts and the end-to-end smoke test (`smoke.ts`).
- `docs/` holds the operations guide (`OPERATIONS.md`) and the theme (`THEME.md`).
