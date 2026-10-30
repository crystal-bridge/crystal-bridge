# What Crystal Bridge stores

The hub keeps every Quest's full history, for as long as the hub exists. That includes everything typed or pasted
into a chat, every reply, and every tool's input and output. Plan for it like you would for a password store.

## Where data lives

| Where | What | Kept for |
| --- | --- | --- |
| Hub database (`AIRSHIP_DB`, SQLite) | `events`: every event of every Quest (prompts, replies, tool calls and results, approvals); `sessions`: each Quest's id, Kingdom, folder, title and status; `push_subscriptions`: each browser's push endpoint and notification levels; `appearance`: each user's Kingdom icons and colours; `relay`: bytes sent to browsers per Quest | Until deleted by hand. Nothing expires. |
| Hub backups (`AIRSHIP_BACKUP_DIR`) | A full copy of the database, taken nightly and before each schema migration | The newest `AIRSHIP_BACKUP_KEEP` (default 14). |
| Off-box backup mirror (optional, `AIRSHIP_BACKUP_SSH`) | The same backup folder, mirrored | The same count as the hub's folder. |
| Hub keys | `nodes.json` (only SHA-256 hashes of node tokens), `vapid.json` (Web Push keys) | Until replaced. |
| Each Kingdom | Crystal keeps nothing on disk beyond its config; unsent events wait in memory. Claude Code keeps its own session files under `~/.claude` | Claude Code's own retention setting. |
| Each browser | Unsent drafts, the current view, notification levels, in local storage | Until cleared in the browser. |

Web Push messages pass through each browser vendor's push service, encrypted end to end; at the Discreet and Off
levels they carry no Quest titles or text.

## Deleting data

- **One Quest:** there's no delete button yet. With the hub stopped, delete that Quest's rows from `events` and
  `sessions` (by its session id) with any SQLite tool, then start the hub. Its copies in the backups expire as the
  backups rotate.
- **Everything:** stop the hub, then delete the database file (and its `-wal` and `-shm` files), the backup folder
  and the off-box mirror.
- **A secret pasted into a chat:** rotate the secret. Deleting the Quest still leaves it in backups until they
  rotate out, and in Claude Code's own session files on the Kingdom.

## Backups and restore

The procedure is in `docs/OPERATIONS.md` ("Backups and restore"). A restore loses only what happened after that
backup; Kingdoms resend events the hub never acknowledged.
