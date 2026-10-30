# Engines and the protocol

An **engine** is how a Kingdom runs Claude Code. The **protocol** is what Kingdoms, the hub and browsers say to each
other. Both are seams: the hub and the web app share one protocol whichever engine produced an event.

## Engines

The engines are the `Engine` type in [`commands.ts`](../packages/protocol/src/commands.ts), each run by one file:

| Engine | Runs | Code |
| --- | --- | --- |
| `stream` | `claude` in its documented stream-json mode. The default, always on | [`session.ts`](../apps/crystal/src/session.ts) |
| `interactive` | The real interactive `claude` in a pseudo-terminal. Experimental; turn it on with `CRYSTAL_ENGINES` | [`interactive.ts`](../apps/crystal/src/interactive.ts) |

[Operations](./OPERATIONS.md#deploying) says what the interactive engine adds and lacks, and the README says why a CLI
update [can break it](../README.md#good-to-know). What the real CLI's output looks like, recorded, is in the
[fixtures' README](../apps/crystal/test/fixtures/README.md).

## The protocol

Every message is a Zod schema in [`packages/protocol`](../packages/protocol/src/index.ts):

- [`envelope.ts`](../packages/protocol/src/envelope.ts): the event envelope, its event types and the usage report.
- [`commands.ts`](../packages/protocol/src/commands.ts): commands to a node, the frames of the node link and
  `PROTOCOL_VERSION`.

The hub stores an engine's raw output inside the envelope, so nothing engine-specific becomes a table column.

[Compatibility](./OPERATIONS.md#compatibility) says which hubs and Kingdoms work together and when the version changes.
The rules for changing the protocol are in [Contributing](./CONTRIBUTING.md#ground-rules).
