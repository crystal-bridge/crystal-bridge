# Security

## Reporting a vulnerability

Please report security problems privately, not in a public issue: use GitHub's "Report a vulnerability" (private
advisories) on this repository. Include what you found, how to reproduce it, and what an attacker could do with it.
You'll get an acknowledgement within a week.

## What Crystal Bridge trusts, and what it doesn't

- **It runs Claude Code on your machines with your login.** Anyone who can use the web app can start sessions that
  read, write and run code on every connected machine, within each session's permission mode. Treat access to the hub
  like SSH access to those machines.
- **The hub is meant for a private network.** The supported setup puts it behind `tailscale serve` with
  `AIRSHIP_ALLOWED_USERS` set to your tailnet login(s), and gives each node its own token (`AIRSHIP_NODES`). The hub
  refuses to start without both, unless it is a development hub (`pnpm dev`), which has no authentication at all and
  must stay on `127.0.0.1`. Put no other proxy in front of it: it trusts the `Tailscale-User-Login` header.
- **Node tokens** are stored on the hub only as SHA-256 hashes, are written to each node's env file with mode 0600,
  and are kept out of the environment of the sessions Crystal starts.
- **Credentials are never touched.** Crystal never reads, copies or relays Claude's credential files, keychain items
  or tokens; `claude` uses its own login.
- **Event history is stored in plain SQLite** on the hub (prompts, replies, tool inputs and outputs). Protect the hub's
  disk and backups accordingly.
- **Web Push** payloads are encrypted end to end to each browser; Discreet levels keep session titles out of pushes.

The full threat model (boundaries, what each compromise gives an attacker, a hardening checklist) is in
`docs/SECURITY-MODEL.md`.

## Supported versions

Only the latest `main` is supported.
