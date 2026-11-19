# GitHub Scout

A Scout that lists the pull requests and issues that want you on GitHub, for a Kingdom's Board. How Scouts work is in
[Scouts and Boards](../../../docs/SCOUTS.md).

## Set it up

1. Log in with the GitHub CLI on the Kingdom, as the account whose work you want listed: `gh auth login`. The Scout
   uses that login and stores no token.
2. Copy this folder to the Kingdom's Scouts folder, without the test:
   `~/.crystal-bridge/scouts/github/` (or `CRYSTAL_SCOUTS_DIR`).
3. In `scout.json`, set `schedule.timezone` to yours. Every 15 minutes is the default.
4. The Quest buttons start in `~/code/<repository name>`. If your clones live elsewhere, change each action's `project`.

Run one per GitHub account, on one Kingdom: GitHub's rate limits are per account.

## What it lists

| Group                  | What lands there                                                                                    |
| ---------------------- | --------------------------------------------------------------------------------------------------- |
| Needs your review      | Pull requests that ask for your review.                                                             |
| Needs a fix            | Your pull requests with failing checks, a review asking for changes, or someone else's last word.   |
| Ready to merge         | Your pull requests GitHub would merge now, drafts aside.                                             |
| Waiting on others      | Your other open pull requests.                                                                      |
| Your issues            | Issues assigned to you, and issues you opened once someone else replied last.                       |
| Unanswered discussions | Discussions you started with no answer yet, when `settings.json` asks for them.                     |

Who has the last word counts people only: comments, reviews and pushes by bots are left out, and so is an approval,
which asks nothing of you. A reply from someone without write access is listed but suggests no Quest, since anyone can
comment on a public pull request. An item comes back as new when it changes group, when someone acts on it, or when its
failing checks change.

On the Board, each row starts with its author (`show` in `scout.json`), and the banner counts the items with failing
checks (`summary`). Counsel beside the list gathers the suggested Quests under each button.

## Buttons

- **Fix the checks** starts a Quest in a worktree with the failing checks' names, to fix and push.
- **Answer the review** starts a Quest in a worktree to work through the feedback; it shows you the diff and its draft
  replies, and commits, pushes and posts nothing until you say so.
- **Triage** starts a Quest that reads the issue and the code and reports back, changing nothing.
- **Open**, **Later** (a day) and **Done** need no Quest.

Each Quest first checks that its folder is a clone of the item's repository (`git remote -v`) and stops if it isn't, so
two repositories with the same name can't mix. A Kingdom set to auto mode runs them without asking for approvals.

The prompts are `fix.md`, `answer.md` and `triage.md`; edit them to suit.

## Settings

Copy `settings.example.json` to `settings.json` beside `scout.json` to change:

- `discussions`: also list your unanswered Discussions.
- `refreshMinutes` (60): how old a kept list may get. Between searches, the collector asks GitHub's notifications API
  whether anything changed, by ETag, and a "not modified" reply costs no rate limit. A check finishing makes no
  notification, and neither does anything you do yourself (merging, pushing, replying), so the list is searched again
  at least this often.

A `settings.json` that isn't JSON fails the run, with the reason on the Board, rather than being ignored.

The kept list and ETag are in the Scout's `state` folder.
