# Gmail Scout

A Scout that lists the threads in your Gmail inbox on a Kingdom's Board, ranks them and suggests what to do with each:
archive, filter, spam, follow up, or done for a to-do you handle somewhere else. How Scouts work is in
[Scouts and Boards](../../../docs/SCOUTS.md).

The Google sign-in is most of the setup. You make your own OAuth client, so no one else's app holds your mail.

## Set it up

1. **A Google Cloud project of your own.** In the [Google Cloud console](https://console.cloud.google.com/), create a
   project and enable the **Gmail API** for it.
2. **The app.** Open **Google Auth Platform** and press **Get started**: give the app a name, your email as support
   and contact, and choose **External** for a personal account or **Internal** for your own Workspace. Then under
   **Data Access**, press **Add or remove scopes** and add `gmail.modify` and `gmail.settings.basic`.
3. **Publish it** (External only; an Internal app has no publishing status). Under **Audience**, press **Publish app**
   so its status is **In production**, and leave it unverified: Google's verification is for apps others use. In
   **Testing**, its sign-in expires every seven days, which breaks an unattended Scout each week.
4. **A Desktop client.** Under **Clients**, press **Create client**, choose **Desktop app**, and download the JSON from
   the dialog that follows. Google shows the client's secret only then; if you lose it, add a new secret to the
   client.
5. **Copy this folder** to the Kingdom's Scouts folder, without the test: `~/.crystal-bridge/scouts/gmail/` (or
   `CRYSTAL_SCOUTS_DIR`). Save the downloaded JSON in it as `client_secret.json`.
6. **Sign in, once, on the Kingdom:** `node sign-in.mjs` in that folder. It prints an address; open it and choose your
   account. An unverified External app shows "Google hasn't verified this app": press **Advanced**, then **Go to**
   your app. Tick both permissions (Filter sender needs the second), allow, and the page says you're signed in.
7. In `scout.json`, set `schedule.timezone` to yours. Every 15 minutes is the default; use Run now on the Board for the
   first list.

The sign-in address answers on the Kingdom's `127.0.0.1`. On a Kingdom you reach over SSH, give it a port and forward
that port from your own machine: `ssh -L 8765:127.0.0.1:8765 <kingdom>`, then `node sign-in.mjs --port 8765` there, and
open the address in your own browser.

On a Workspace account, an admin may block apps the organization hasn't allowed, or these scopes. Google then shows why
in the browser and never returns to the sign-in, which gives up after five minutes.

The refresh token is in `state/token.json`, readable by your user only (on Windows, by the folder's own access). It
isn't a Claude credential and never leaves the Kingdom. To revoke it, remove the app under **Third-party apps &
services** in your Google Account.

When the sign-in expires or is revoked, each run fails with "sign in again" on the Board, and after three the Scout
pauses. Run `node sign-in.mjs` again, then Run now.

## What it lists

One item per thread in the inbox, from its latest message, under Gmail's own categories: Primary, Updates, Social,
Forums and Promotions. Your drafts, and messages in Trash or Spam, don't count. A new message in a thread brings it
back as new; reading it elsewhere doesn't. A thread you archive in Gmail leaves the Board on the next run, and the next
one down takes its place.

The Board holds the newest inbox threads (100 by default). The first run reads them all. Later runs ask Gmail's history
what changed since the last one, which is cheap and needs no public address, and fetch only those threads. The inbox is
read in full again when Google says the saved position is too old, when history names more threads than the Board
holds (after you mark a few thousand read at once, say), or when you sign in as another account.

## What the model sees

The synthesis step and a Follow up Quest see, for each thread: the sender's name and address, the subject, the
category, whether it's from a mailing list, the start of the latest message (600 characters by default), and the
thread's Gmail link, which names your address. Before any of it leaves Gmail's answer:

- attachments, quoted replies, signatures after `-- `, HTML styles and scripts, and invisible characters are dropped;
- a link keeps only its host, which drops sign-in tokens and tracking;
- numbers of nine digits or more (accounts, cards, phone numbers) and IBAN-like strings are hidden;
- in mail that talks about a code, a PIN or a password, short codes are hidden too, including ones split in two
  (`123 456`).

The redaction is a pattern match, not a guarantee. A code made of letters and digits (`K7Q2XZ`), a temporary
password, a link written without `https://`, or a code in mail that never says "code" gets through. The same text is
what the hub stores and the Board shows.

## Buttons

- **Archive** takes the thread out of the inbox.
- **Filter sender** asks first, then creates a Gmail filter that skips the inbox for mail from that address (shown
  beside the sender's name), and archives the threads. A filter that already exists counts as made. A sender address
  with anything a Gmail search would read as an operator, such as a leading `-`, gets no Filter button.
- **Spam** asks first, then moves the thread to Spam by adding Gmail's `SPAM` label. Google doesn't document whether
  that teaches Gmail's spam filter the way its **Report spam** button does, so for a sender that keeps getting through,
  use Report spam in Gmail itself.
- **Follow up** starts a Quest in your home folder that says what the mail wants and drafts a reply for you to send,
  or lists the steps for a to-do. Its prompt tells it to use no files, commands or web, and to treat the mail as data,
  but nothing enforces that: it's an ordinary Quest, and a Kingdom set to auto mode runs it without asking for
  approvals. Mail is written by others, so read what it did before you act on it.
- **Open** opens the thread in Gmail, as the signed-in account. **Later** (a day) and **Done** need no script: Done is
  for a to-do you finished elsewhere, such as a bill you paid.

Archive, Filter sender and Spam each get a batch button above a group, such as "Archive all 12", when several of its
threads offer them. Filter sender and Spam ask before they go, and say how many.

The synthesis step suggests one of these per thread, and may add an item such as "A filter on news@example.com would
archive these 6 promotions". That item offers only Later, Done and Dismiss; press Filter sender on the threads
themselves.

The prompts are `synthesize.md` and `follow-up.md`; edit them to suit.

## Settings

Copy `settings.example.json` to `settings.json` beside `scout.json` to change:

- `maxThreads` (100, at most 500): how many of the newest inbox threads the Board holds. Changing it reads the inbox
  again.
- `bodyChars` (600, at most 2000): how much of the latest message the model sees. Changing it reads the inbox again.

A `settings.json` that isn't JSON fails the run, with the reason on the Board, rather than being ignored.

The saved position and list are in `state/inbox.json`.
