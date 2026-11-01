# Getting started on one machine

This puts the hub, one Kingdom and the web app on your own computer. These steps live in the
[README](../README.md#one-machine), which also says what the app does.

## Can I use this on one machine?

Yes. One machine is a normal setup: one hub, one Kingdom, one tab. You still get Quests in the browser, approval cards, the
Tavern, Split View, notifications, Recruit for your terminal sessions, and Summons through the built-in `here` target
(not on Windows). What you don't get is the point of several Kingdoms: one app across several machines or accounts.

What to do next depends on what you want:

| You want | Do this |
|---|---|
| To look at it, with no setup of your own | `pnpm demo` in a checkout: the whole app with invented machines. No `claude` runs and nothing is kept |
| To try it on your own work | [Try it](#try-it), below |
| To keep it running on this computer | [Not ready yet](#keep-it-running-on-this-computer) |
| To reach it from a phone or another computer | [Use the several-machines setup](#reach-it-from-another-device) |

## Try it

<!--@include: ../README.md#one-machine-->

A few things to expect from `pnpm dev`:

- **It's a development server.** It runs in your terminal with no login, and closing the terminal stops it. Ctrl-C stops
  it too. To update, stop it, `git pull`, `pnpm install` and start it again. Your data stays in `apps/airship`.
- **It looks for projects in `~/code`.** If your repositories are somewhere else, say so when you start it, since
  `crystal.env` isn't read here: `CRYSTAL_PROJECT_ROOTS=~/work pnpm dev`.
- **It asks about every action.** New Quests start in the "ask every time" mode, unlike a joined Kingdom's auto mode. You
  can choose another mode for each Quest.

## Keep it running on this computer

This route isn't ready yet. `pnpm dev` stops with its terminal, and the packaged hub is a foreground process with nothing
to restart it: the deploy scripts are for Linux servers over SSH, and there's no recipe yet for keeping one running on a
Mac or a desktop. A packaged hub with a Kingdom joined to it on the same computer should work, but nobody has tested it
from start to finish, so we aren't giving steps for it.

## Reach it from another device

The app has to come from a hub your other device can reach, and `pnpm dev` is only on localhost with no login. So use
[Several machines](./SEVERAL-MACHINES.md). Nothing there needs a second computer in principle, since the hub host and the
Kingdom can be the same machine, but that machine has to stay awake, and the same untested caveat applies as
[above](#keep-it-running-on-this-computer). Read the [security model](./SECURITY-MODEL.md) before you expose it beyond
your own private network.

## On Windows

One Windows PC can't be the whole setup. The hub runs on Linux and macOS, and `pnpm dev` needs a `bash` for its checks. A
Windows PC can be a Kingdom or a Summon, so if you have a hub on another machine, [add it from the
app](./SEVERAL-MACHINES.md). A hub in a container on Windows is untested.

## Next

- Learn the words the app uses: [How it fits together](./CONCEPTS.md).
- Put the hub on an always-on host and connect more machines: [Several machines](./SEVERAL-MACHINES.md).
- Change a setting: the [configuration reference](./CONFIGURATION.md).
