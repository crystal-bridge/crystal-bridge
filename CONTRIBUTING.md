# Contributing

Thanks for wanting to help. A few things keep Crystal Bridge working for everyone who runs it:

## Ground rules

- **Unmodified CLI, user's own login.** Crystal runs the real `claude` binary under the machine's own login. Changes
  must not pass `--bare`, read or relay credentials, use the Agent SDK with a subscription login, or work around
  Claude Code's permission prompts. See "Terms of use" in the README.
- **Harness-agnostic.** A node may run no Claude Code plugins, hooks or skills, or any popular set. Don't depend on a
  particular one being installed.
- **Engine-neutral hub.** The hub stores raw engine lines inside an envelope; nothing engine-specific becomes a table
  column.
- **Additive protocol.** New optional fields and event types are fine; anything an older peer can't handle needs a
  `PROTOCOL_VERSION` bump.
- **Never edit a shipped migration;** append a new one.
- **No model names** in code, comments, fixtures or docs.
- **Themes are pluggable.** User-facing words go through `apps/web/src/theme/words.ts` (with a Classic equivalent),
  colours and fonts through `apps/web/src/theme/theme.css`.

## Workflow

1. Open an issue first for anything bigger than a small fix.
2. Write a failing test, then the change.
3. Run `pnpm format`, `pnpm test`, `pnpm typecheck`, and for anything on the runtime path `pnpm smoke` against a
   running `pnpm dev`.
4. Open a pull request with what changed, why, and how you checked it.

### Git hooks

`pnpm install` installs the repo's git hooks (`simple-git-hooks`, configured in `package.json`). They run the same
checks as CI, so they apply whatever editor or agent you use:

- **pre-commit:** Prettier on the staged files; the repo scrub (`scripts/repo-checks.ts`), which rejects model ids,
  home paths and email addresses other than noreply and example ones; and `gitleaks` on the staged changes when it
  is installed.
- **commit-msg:** a conventional subject (`feat(web): ...`), a noreply author email (set `user.email` in the repo's
  git config to your GitHub noreply address), and no attribution trailers.
- **pre-push:** `pnpm typecheck` and `pnpm test`.

To keep your own names out of the repo too (host names, other identities), list them one per line in
`~/.config/crystal-bridge/deny-list`. The scrub checks every staged file against that list, and the list itself never
enters the repo. `pnpm checks` runs the scrub over every tracked file. In an emergency `SKIP_SIMPLE_GIT_HOOKS=1`
skips the hooks; CI runs the same checks either way.

## Licensing of contributions

Contributions are accepted under the repository's licence (see `LICENSE`). Art in `apps/web/public/heroes` follows
its own licences (`LICENSE-ART.md`); new art must come with credits and a compatible licence.
