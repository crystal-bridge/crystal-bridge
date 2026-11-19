# GitHub Scout

A Scout that fills a projects Board from GitHub: every open pull request and issue in the repositories you maintain,
your own in the ones you contribute to, and why each one needs you. How Scouts work is in
[Scouts and Boards](../../../docs/SCOUTS.md).

## Set it up

It needs a hub and Kingdom with the `projects` view (commit 207ed45 or later). An older hub fails the Scout with
"needs a newer hub", so update the hub and the Kingdom first. An installed copy keeps the old list view until you
replace its files.

1. Log in with the GitHub CLI on the Kingdom, as the account whose work you want listed: `gh auth login`. The Scout
   uses that login and stores no token.
2. Copy this folder to the Kingdom's Scouts folder, without the test:
   `~/.crystal-bridge/scouts/github/` (or `CRYSTAL_SCOUTS_DIR`).
3. In `scout.json`, set `schedule.timezone` to yours. Every 15 minutes is the default.
4. The Quest buttons start in `~/code/<repository name>`. If your clones live elsewhere, change each action's `project`.

Run one per GitHub account, on one Kingdom: GitHub's rate limits are per account.

## What it lists

- **Repositories you maintain**, in full: every open pull request and issue, up to `perProject` of each, newest
  first. A repository counts when your permission is admin or maintain, it belongs to you or one of your orgs, it isn't
  archived, and it was pushed within `activeDays`. A fork counts only when it takes issues of its own. Their sections
  wear a crown.
- **Repositories you contribute to**: only your items. These are your pull requests, review requests, issues assigned
  to you, and issues you opened once someone else has the last word. Their sections wear a handshake and say "showing
  your items".

The Board has two modes, switched beside Run now. **Projects** has a section per repository, with the items that need
you in the Needs-you window beside it. **Tiles** has a tile per repository with its recent activity and top items.

Each row shows its kind (pull request, draft, issue, bug), its checks and review state, labels, comments, size, age and
author, with a gold edge on your own. The banner counts pull requests, issues and failing checks.

An item needs you for one of these reasons. Its card in the Needs-you window offers the button.

| Reason            | When                                                                         | Button            |
| ----------------- | ---------------------------------------------------------------------------- | ----------------- |
| Review requested  | Someone asked for your review.                                               | Review (a link)   |
| Checks failing    | Your pull request's checks failed.                                           | Fix the checks    |
| Changes requested | A review on your pull request asks for changes.                              | Answer the review |
| Reply owed        | Someone else has the last word on your pull request, or on your issue.       | Answer, or Triage |
| Ready to merge    | GitHub would merge your pull request now. Drafts never are.                  | Merge (a link)    |
| Assigned to you   | Someone else opened an issue and it is assigned to you; no reply is owed.     | Triage            |

Other items in a repository you maintain have no reason. They show in their section but not in the window.

Who has the last word counts people only: comments, reviews and pushes by bots are left out, and so is an approval,
which asks nothing of you. A reply from someone without write access is listed, and Answer the review stays on the
row, but it isn't suggested, since anyone can comment on a public pull request. An item comes back as new when its
reason changes, when someone else acts on it, or when your pull request's failing checks change. Edits, labels and
bot comments in a busy repository don't bring it back.

## Buttons

- **Fix the checks** starts a Quest in a worktree with the failing checks' names, to fix and push.
- **Answer the review** starts a Quest in a worktree to work through the feedback; it shows you the diff and its draft
  replies, and commits, pushes and posts nothing until you say so.
- **Triage** starts a Quest that reads the issue and the code and reports back, changing nothing.
- **Review** and **Merge** open the pull request on GitHub. Merge doesn't merge by itself.
- **Open**, **Later** (a day) and **Done** need no Quest.

Each Quest first checks that its folder is a clone of the item's repository (`git remote -v`) and stops if it isn't, so
two repositories with the same name can't mix. A Kingdom set to auto mode runs them without asking for approvals.

The prompts are `fix.md`, `answer.md` and `triage.md`; edit them to suit.

## Settings

Copy `settings.example.json` to `settings.json` beside `scout.json` to change:

- `include`: more repositories to list in full, as `"owner/repo"`, such as one you maintain under someone else's
  account.
- `exclude`: repositories to leave out entirely, as `"owner/repo"`, even your own items in them.
- `activeDays` (90): how recently a repository you maintain must have been pushed to be listed in full.
- `perProject` (50, at most 100): how many open pull requests, and how many issues, to list per maintained repository.
- `discussions`: also list your unanswered Discussions.
- `refreshMinutes` (60): how old a kept list may get. Between runs, the collector asks GitHub's notifications API
  whether anything changed, by ETag, and a "not modified" reply costs no rate limit. A check finishing makes no
  notification, and neither does anything you do yourself (merging, pushing, replying), so the list is read again at
  least this often.

A `settings.json` that isn't JSON, names an unknown setting or gives one the wrong type fails the run, with the reason
on the Board, rather than being ignored.

A full read is one GraphQL call for your repositories and searches, then one call per five maintained repositories.
A repository the login can't read is skipped with a note in the run's stderr. A rate-limit error fails the run with
its reason, and the Board keeps its last list. A Board takes 1,000 items: past that, the items that need you stay,
then the newest.

The kept list and ETag are in the Scout's `state` folder.
