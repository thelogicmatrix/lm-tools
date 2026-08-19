---
name: postman
description: >-
  Real outbound email from your own mailboxes, one identity per address. Cold outbound and replies onto an existing thread, byte-exact signature, recipient verification, live thread resolution, per-identity voice, and a read path that pulls a mailbox window down for a model to read. Use when asked to "send these emails", "reply to the recruiter", or "what's in the inbox". Proactively suggest when outreach has been drafted but nothing has verified the addresses. Nothing to do with Postman the API client.
---

# Postman

Real email from a batch file. Nothing sends without a mode flag saying so.

Run everything from this skill's own directory.

**First run:** postman reads its identities from `.postman/identities.json`, in
`POSTMAN_HOME` if set and `~/.postman` otherwise. Those are the only two locations, and
the working directory is never searched. Copy the plugin's
`.postman/identities.example.json` to `~/.postman/identities.json` and put your own
mailbox in it before anything else - not into the plugin's own directory, which updates
overwrite. The README covers the fields.

The reason there is no search: `pw_cmd` is **executed**, and the same file names an
`assets` directory that is concatenated into outbound mail. A config found by standing in
a directory is not a config anyone chose.

## The batch file

One file per batch, authored by hand, stored outside git next to the work it belongs
to. `---` on its own line separates recipients.

```
Identity: branded

# Brief
Scratch notes, the shortlist, what I am trying to get. Never sent.

---

## @grandhall | Dana R. <enquiry@grandhall.example>
Subject: Private client dinner for 100 - September availability
Source: grandhall.example/corporate-dinner-dance/, read 2026-08-05
Attach: brief.pdf, floorplan.png

Hi Dana,

Body in markdown.
```

**`@` is what marks a recipient.** A heading is an email only as
`## @slug | Display Name <address>`, so prose headings can never be mistaken for one.
That mattered: a real batch mixed prose sections and recipients under a plain `## ` and
parsed correctly only because the `---` separators happened to fall right. A `## @`
heading that does not fit the shape is a hard error rather than a skipped block, and the
marker count is reconciled against the parsed count, so nothing can be silently dropped.

The preamble above the first recipient is optional and holds two things. `Identity: NAME`
picks the mailbox, naming one of the identities in your `identities.json`. A line that says
`Identity:` and does not parse is a hard error, never a fallback, because the fallback would
be which mailbox the batch sends from. `--as NAME` beats the file's line, which beats the
identity marked `"default": true` (or the only one you have), and the file-less modes take
the identity positionally instead. `# Brief` is working notes for you and is never part of
any email.

Whether an identity sends an HTML signature is **declared** per identity as `html_sig`,
never sniffed from whether an asset file happens to exist. The examples throughout this
file use two: `branded`, which sends HTML with an inline logo, and `plain`, which is plain
text. Those are also the two the selftest fixture builds, so an example here and a failing
assertion are talking about the same thing.

An identity used only to *read* a mailbox is worth having on its own. The Gmail MCP
truncates threads with no marker, so a mailbox postman has no identity for is a mailbox
with no honest reader at all.

Per-block headers:

| Header | |
|---|---|
| `Subject:` | Required on **every** block. Threading disambiguates by subject, so a missing one is not a cosmetic gap. |
| `Source:` | URL plus read date. Required on cold outbound, **rejected** on a reply - the resolved thread is the provenance there. |
| `To:` | Optional, overrides the heading address. This is how a multi-address reply works: the heading holds exactly one, IMAP SEARCH needs them split. |
| `Cc:` | Optional. |
| `Third-party:` | Why the address does not match the source domain. |
| `Attach:` | Comma-separated for several files, one line only. Paths resolve against the batch file's own directory. |
| `Sent:` | Written by the tool, never by hand. |

A repeated `Attach:` line is a hard error - a repeat would silently overwrite the first,
and the send would look normal. A repeated `Sent:` is the one exception: both stamps mean
the same thing, so the first is kept and a warning goes to stderr rather than failing the
parse, which used to block resuming every other recipient in the file.

Attachment existence and the 25 MB cap are checked offline before anything sends, because
a missing file discovered at recipient 7 leaves 1 to 6 already gone. The cap is **per
message and measured base64-encoded** (4 bytes out per 3 in), which is what Gmail limits:
a 12-recipient batch carrying 3 MB each is fine, and one 20 MB attachment is not.

A reply's quoted context goes in a fenced `quoted` block at the top of the body, and that
block is structurally excluded from what sends:

~~~
## @grandhall | Dana R. <dana.r@venuegroup.example>
Subject: RE: Private client dinner for 100 - September availability

```quoted
> Thanks for your enquiry. The 12th is free, minimum spend is $8,000.
```

Hi Dana,

The 12th works for us.
~~~

A fence, not a convention about blank lines: a trim
that dropped a marker would put the counterparty's words out under your name and look
completely normal in the file. One fence, at the top, closed - a second or misplaced one
is an error. A reply is the fence **and** an `RE:` subject, and the two must agree. Either
signal alone is a hard error, because a `RE:` subject with no fence otherwise falls into
the cold-outbound branch and the natural unblock is a rubber-stamped `Source:` line.

`Sent:` stamps are written into the file after each successful send, so a re-run skips the
blocks already stamped and a half-failed batch is resumed by re-running it. Never
hand-write one.

Bodies are written unwrapped, one line per paragraph: a newline in the body is a real
line break in the email, so a labelled block (`Guests: 100` / `Dates: flexible`) stays a
block instead of collapsing into prose.

**Never put `---` on its own line inside a body.** It is the recipient separator, so everything under it silently detaches from the block and reads as an ignorable notes chunk - the body sends truncated and looks complete. Use a different divider in prose (or nothing).

## Modes

| Command | What it does |
|---|---|
| `--verify BATCH` | Layers 1 and 2, prints the table. Sends nothing, spends nothing, asks nothing. |
| `--test BATCH` | Sends the first email to the identity's `test_to` address (`POSTMAN_TEST_TO` overrides) with `[TEST]` prefixed. A real send. |
| `--draft BATCH` | Every email as a Gmail draft. **Not part of the ritual** - a draft nobody opens is a review step that did not happen while looking like one, so review happens in chat instead. Kept for when you ask for a draft by name. Drafts are never stamped and `--send` does not consume them: hand-sending a lingering draft and then running `--send` is a double-send, so purge with `--drafts IDENTITY MATCH --purge` before sending the same batch. |
| `--drafts IDENTITY [MATCH]` | List drafts, optionally filtered by a substring against the To and Subject headers. **Read-only.** This is how the "delete leftover drafts" instruction is actually carried out, which until now the tool gave no way to do. |
| `--purge` | With `--drafts` only, refused on its own. Moves the listed drafts to Trash by setting Gmail's `\Trash` label, so they survive 30 days and a wrong `MATCH` costs a restore rather than the draft. `--selftest` asserts it cannot run without `--drafts`. |
| `--send BATCH` | Sends the batch. Only after you explicitly say send. |
| `--as NAME` | Overrides the batch file's `Identity:` line. Refused alongside `--bounces`. |
| `--bounces IDENTITY DAYS` | Layer 4: bounces for IDENTITY in the last N days. `--bounces branded 0` means today only. Searches All Mail and always prints a count line, so a clean sweep is distinguishable from one that never ran. |
| `--hunter ADDR…` | Layer 3. One credit each. Only for addresses that failed layer 2, only after asking. |
| `inbox IDENTITY [--days N] [--all] [--json] [--from ADDR] [--attachments DIR]` | Read path: pulls the mailbox window into `inbox.md` with every message accounted for. `--from` narrows the IMAP SEARCH to one sender or domain **server-side**, which is the difference between seconds and hours on a big mailbox: the fetch loop is one round trip per message, and a full window on a large mailbox was headed for over two hours when the question was "what has this one counterparty sent me" and the answer was 13 messages. A `--from` run is a **slice, not a window**, so it prints to stdout, writes neither `inbox.md` nor `seen.json`, and says so on its last line. Marking a slice seen would suppress every other new message from the next full pull. In exchange it drops the 800-char fence cap and fences every message in each thread rather than the latest alone, because a slice is small by construction and is asked for in order to read it. `--attachments DIR` writes every fenced message's real attachments into DIR as `<sender-domain>__<filename>`, off the fence fetch that already pulled the whole MIME tree, so it costs no extra round trip. Documents are always kept; images only above 500 KB, because every corporate signature carries a logo. It names each saved path on stdout rather than a bare count, since the point is to open them afterwards. Pair it with `--from` to sweep one counterparty's whole thread. This is what retired the per-event `pull_replies.py` scripts, which had forked postman's IMAP, threading and quote-stripping into each event folder and drifted out of step with the batch grammar twice. `--json` emits a per-message inbound stream for an external tracker to consume (read-only). Both paths read All Mail, never INBOX alone: an archived thread has left INBOX, so an INBOX read cannot tell "they never replied" from "I archived it". Identity is positional, never defaulted. |
| `--selftest` | The built-in checks. |

`--draft` and `--send` are mutually exclusive, and there is no bare-path default: a mode
flag or the `inbox` subcommand is always required. Passing both used to take the send
branch silently.

## Verification, in one paragraph

Layer 2 is the gate on **cold outbound**: the address must come from the venue's own site,
with a read date inside 30 days. A reply is not held to that, because there is nothing to
source - the resolved thread is the provenance, and the verdict reads `threaded` instead of
`sourced`. Both verdicts clear. Layer 1 (MX) catches dead domains and runs on every address
either way. Neither layer costs anything. Hunter is layer 3 and it is an **ask** - it runs only for addresses that
failed layer 2, and only after you agree to spend the credit. Never batch-verify.
The rule came from a real batch: every own-site address survived verification, and the
only address that would have bounced came from a third-party directory.

`accept_all` from Hunter means cannot-be-disproved, not confirmed. Report it verbatim.

The selftest asserts that no default path names `hunter_verify` or `hunter_key`, so the
ask stays an ask by construction rather than by anyone remembering to be careful.

## Replies thread onto the existing conversation

A reply is two signals that have to agree: a `quoted` fence at the top of the body, and a
reply prefix on the subject (`RE:`, `Re: Fwd:`, and so on). Either one alone is a hard
error, so beyond those two there is no extra flag and no extra batch field. The prefix is
what drives the threading lookup below. The fence is what gates `Source:`, which is
rejected on a reply because the resolved thread is the provenance.

For those, Message-IDs are resolved live from the mailbox over IMAP and never taken from
the batch file, because a hand-typed Message-ID that is subtly wrong threads nowhere and
looks identical to one that worked. The lookup prefers the venue's own latest message in
the thread and falls back to our sent one, so a venue that never replied still threads
onto the original enquiry instead of arriving as a second conversation.

A `To:` carrying several addresses is tried one address at a time, each quoted, because
IMAP SEARCH takes exactly one address per key. Joining them into one atom is not a bad
thread, it is `BAD Could not parse command` and the whole draft dies (7 Aug 2026, three
addresses on one reply). The first address is not necessarily the one who wrote in
the thread, so all of them are candidates, INBOX before All Mail before SENT. An archived
reply has left INBOX entirely, and archiving your inbox is normal behaviour, so All Mail
is searched too. Autoresponders are skipped, since threading onto one files the reply
under "Automatic reply:" in their client.

**The subject is never part of the IMAP search.** IMAP matches a `HEADER SUBJECT` atom
against the raw header bytes, and RFC 5322 lets any mailer fold a long header across
lines, so a subject over roughly 66 characters arrives as `availability &\r\n quote`
while the atom asks for `availability & quote`. No such search can ever match, and the
failure is silent: the send succeeds, unthreaded. On 11 Aug 2026 this unthreaded 9 of 11
venue replies, and it hit the SENT fallback too because our own outbound folds
identically. The two that survived had short subjects. So IMAP narrows on the address,
which never folds, and the subject is matched here on the unfolded, encoded-word-decoded
header. `--selftest` carries the real folded bytes from that mailbox as a regression test.

Both `In-Reply-To` and `References` are set. Outlook threads on `References` and venue
sales teams run Outlook, so setting only one threads for us and not for them.

**Changing an ask they have not answered yet is a writing problem, not a sending one.** On
2026-08-13 a round-3 batch went to 11 venues at 14:01 and a round-4 batch reached the same
11 at 16:22 with different dates, and every venue was left working out which mail counted.
The mistake was not that a second mail went out. It was that the second was written as a
fresh ask with the numbers changed, rather than as an amendment to the one still sitting
unanswered in their inbox.

So there is no send block for this. `preflight.py` prints a **reply status** line per
recipient: `AWAITING since <when>` if our last mail on that thread has had no answer, or
`nothing of ours awaiting` if it has. When a block reads AWAITING and you are changing what
you asked for, say so in the body ("ignore the dates in my last mail") instead of restating
the ask cleanly. `awaiting_reply()` reads All Mail rather than INBOX, because an archived
reply has left INBOX and archiving is normal, and it skips autoresponders, because an
out-of-office answers nothing.

The block-the-send version existed for one day and was removed on 2026-08-14. "Same subject
inside 24h" is a proxy for a supersede that also matches every ordinary next turn in a
conversation: it refused 9 of 10 follow-ups that existed *because* those 9 had written
back. A guard that fires hardest on the most legitimate case teaches you to pass the
override flag by reflex, which protects nothing.

**An unresolvable thread is a HOLD, and nothing sends.** `--send` resolves the thread for
every pending reply in the batch *before* it sends the first one. If any of them has no
thread, the run stops there and no email has gone out yet. The batch either sends whole or
not at all. Sending unthreaded is not an option the code offers, because on 11 Aug 2026 the
old post-hoc warning put 9 of 11 venue emails into new conversations and a warning about
mail that has already left is not a decision. A `[thread]` mark on a `draft`/`sent` line is
the positive case.

**Run `preflight.py <batch.md>` before any send.** `--verify` covers MX and provenance but
says nothing about whether a reply will thread, and a HOLD in the middle of `--send` costs a
round trip. Preflight runs the gates, the voice check, the same threading lookup and the
reply status read-only, and exits non-zero if any reply would start a new conversation. Cold
blocks print nothing in the threading section, since a first email to a venue has no thread
to find. The reply status never changes the exit code, because what it reports is a
correction to the body, not a reason to hold the batch. An anomaly in an outbound step is a
stop-and-ask, not a line in the send log.

## The inbox (read path)

`python postman.py inbox NAME` pulls the last 30 days into `inbox.md` in that identity's `store` directory, which the identity declares in `identities.json`. The file is generated and disposable - Gmail stays the archive. Every message is accounted for: own outbound first, then thread membership, then the registry, and the header line proves it (`messages = own + inbound`, `inbound = attributed + unaccounted + ignored`). A non-zero `unaccounted` names each message.

"New" is postman's own notion, tracked in `seen.json` - Gmail's read flags are deliberately ignored, because reading mail on a phone must not hide it from the next pull. By default only threads with something new render; `--all` renders the whole window.

**`inbox.md` is read by a model, so its size is a context budget.** Two caps bound it: at most `FENCE_LIMIT` (150) threads carry a quoted body, and the unaccounted tail stops at `UNACCOUNTED_LIMIT` (200) lines. Past either, nothing vanishes - a trimmed thread keeps its heading, subject and message roll-up and loses only the quote - and a `TRIMMED:` line goes into the header, because a trimmed file that reads as whole is the failure mode. Seeing it means register the noisy senders, or narrow the pull with `--from`.

**A new identity has no `registry.json`, and the guesser cannot seed one.** The domain guess infers an owner from *other* registry entries, so at zero entries there are no owners, every message lands `unaccounted` with no attribution, and `suggest_registrations` writes nothing back - an empty registry can never bootstrap itself. Write the first entries by hand. In one real run, a store that had never had a registry rendered **4.3 MB (~1.07M tokens)**: `ignored` sat at 0, every message counted as new, and each got a fence. A second mailbox on the same code the same day, with a registry, rendered **189 bytes**. The registry is the whole difference, so seed one before the first pull on a new identity.

`registry.json` maps addresses to an owner and label (`{"owner": "autumn-gala", "label": "grandhall"}`). `"owner": "ignore"` suppresses a sender into the `ignored` count - newsletters and job-board noise. A key written `"@example.com"` covers **every** address at that domain, and an exact address still overrides its own domain, so one real human at an otherwise-ignored vendor stays visible. Prefer the domain form for vendors and SaaS: they send from `no-reply@`, `billing@` and `notifications@` in turn, so an address list is stale by the next invoice, which is how a real mailbox ended up with most of its inbound unaccounted and `ignored` at zero. Postman guesses cold inbound from the domain, writes the guess back flagged `"suggested": true`, and never overwrites an existing entry; confirm a guess by deleting the flag (and setting the label, which a domain guess never picks). All three store files carry counterparty addresses: they live outside git and stay there.

## The signature is never regenerated

**`html_sig` identities only.** `SIGNATURE.html` is a verbatim slice of a real sent message
of yours, living outside git with the logo, in the identity's `assets` directory. Postman
concatenates it and attaches the logo under the Content-ID the HTML already names. Anything
that rewrites it produces something that looks close and is not. A plain-text identity has
neither, so it requires `SIGNATURE.txt` alone and asking it for an HTML signature would make
it unusable.

## Voice

`VOICE.md` holds the rules and the banned-phrase list, and is the only home for that
list. A hit refuses the build, in the **subject as well as the body** - the subject is
written last and least carefully, so it is the likelier offender. Short, labelled
logistics lines, no numbered question lists, no AI register.

The patterns are split per identity, one `## Patterns - <identity>` section each. Read the
one matching the batch's identity. The banned list is shared and applies to all of them.
Postman reads your own `.postman/VOICE.md` when it is there and the shipped default
otherwise, and the shipped default is a template: write your own patterns into it.

## The ritual

0. Ask first, draft second. Batch the clarifying questions up front and gather the
   context before a word of body text exists: which identity, who exactly, what the ask
   is, what has already been said to them, what the deadline or date is, whether anything
   is attached. Guessing any of that produces a draft that reads fine and is wrong about
   the one thing that matters, and every later step in this list only checks the drafts it
   was given.
1. `--verify` and read the table.
2. `preflight.py <batch.md>`, which runs the gates, the voice check, the threading lookup
   and the reply status read-only.
3. **Show the author the body text in chat and wait.** Not a Gmail draft. A draft the
   author never opens is a review step that did not happen while looking like one. The
   batch file plus the message in chat is the review surface, so paste what will actually
   send.
4. Only after they say send: `--send`.

   **Close `batch.md` in the editor before `--send`, and reload it afterwards.** Every send
   writes a `Sent:` stamp straight into the file, and those stamps are the only record of
   which recipients are done. An editor holding the pre-send version of the file will write
   all of them away the next time it saves, and the re-run then reads a clean batch and
   sends the whole thing a second time. Never save a buffer that was opened before the send
   over a stamped file. If it has already happened, reconstruct the stamps from the send log
   before re-running.

5. `--bounces NAME 1` half an hour later. The identity is positional here, because there
   is no batch file to read it from.

## Credentials

App passwords are per identity, and postman never stores one. Each identity resolves its
own, in this order:

1. The environment variable `POSTMAN_PW_<NAME>`, or whatever the identity declares as
   `pw_env`. The name is derived from the identity unless overridden, so two identities
   can never collide on one variable.
2. The identity's `pw_cmd`: **any command that prints exactly one secret to stdout.** That
   contract is the whole extension point. A `pass` one-liner, a `bw get`, an `op read` or a
   hundred-line vault client all satisfy it, and postman never learns which you use. The
   command is captured, never inherited, and a failure reports its stderr only.

**Nothing needs exporting by hand** once `pw_cmd` is set. Every mode resolves its own
credential through the same function. This used to live in one caller, so the other modes
each needed the password exported first and every caller wrote its own copy of the
bootstrap, which is precisely where a secret leaks into a transcript.

`POSTMAN_NO_VAULT=1` disables the `pw_cmd` fallback, so a missing credential fails fast
instead of shelling out. The selftest sets it. Without it, the offline missing-credential
assertion resolves a real password and performs a live mailbox pull.

`POSTMAN_HUNTER_KEY` is the Hunter API key, shared across identities, and has no `pw_cmd`
fallback. Export it yourself.

Never paste a secret into chat, for any identity. If one has rotated, hand the author a
fill-in-the-blank scratchpad file to fill in outside the transcript.
