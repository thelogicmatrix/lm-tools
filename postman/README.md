# postman: the ultimate email manager

Twelve venues to email, forty applications, or one reply that has to land on the right thread. postman sends them from your own mailbox, and it is built around what it refuses to send.

## What it is

postman is a skill and a command-line tool. You write one markdown file per batch, one block per recipient. postman checks it, shows you exactly what will go, and sends only when you say so.

- **The batch file.** Each block holds the recipient, the subject, where the address came from, and the body. The full grammar is in [SKILL.md](skills/postman/SKILL.md).
- **Identities.** One per mailbox you send from, each with its own address, signature and voice.
- **A read path.** `inbox` pulls a window of a mailbox into a file a model can read. `search` finds one email or link with Gmail's own search.

It is not a mail client, and it is not a mailing-list tool. Every recipient is a block you wrote by hand, on purpose. If you want a thousand of them, you want a different category of software and probably a different consent story. It has nothing to do with Postman the API client.

## How it keeps a batch safe

Most mail tooling is built to get the message out. postman is built around the four ways a real batch goes wrong.

- **An address nobody sourced.** A cold email needs a `Source:` line: the page the address came from and the date you read it, within the last 30 days. The page must be on the recipient's own domain, or a `Third-party:` line must say why not. Every address, cold or reply, has its domain's mail servers (MX) checked. The paid address check (Hunter) runs only when you ask for it.
- **A reply that starts a new conversation.** postman finds each reply's thread in your mailbox at send time, and never trusts a message ID typed into the file. It checks every reply before the first email leaves. If any reply cannot find its thread, **nothing sends at all**.
- **A signature that looks nearly right.** Your HTML signature is an exact copy of one from a real email you sent. postman attaches it as is and never rebuilds it.
- **A body that reads like a machine wrote it.** A banned-phrase list, which you own, stops the build if a phrase appears in the subject or the body.

Nothing sends without a mode flag that says so. As each email leaves, postman writes a `Sent:` line into the batch file, so a batch that dies at recipient 7 resumes at 7 when you run it again. A send whose outcome was lost (the connection dropped after the server had the message) stops the batch, and the rerun will not send that one again until Sent Mail shows whether it went. Close the file in your editor before sending, because an editor saving an old copy erases those lines and the next run sends everything twice.

On the read side, `inbox` accounts for every message in the window, and its header prints the sums that prove it. Two caps keep the file small enough for a model to read. When either cuts something, a `TRIMMED:` line says so at the top, because a trimmed file that reads as whole is the real danger.

## Install

Add the logical-tools marketplace as the [root README](../README.md) shows, then:

```
/plugin install postman@logical-tools        # Claude Code
codex plugin add postman@logical-tools       # Codex
```

You need Python 3.9 or newer and a Gmail account with an app password. Install the two dependencies with `pip install -r skills/postman/requirements.txt`.

## First run

postman ships with no mailbox of its own. Give it one:

1. Copy the plugin's `.postman/identities.example.json` to `~/.postman/identities.json`. postman reads only that folder, or the one `POSTMAN_HOME` names, and never a config from the folder you are standing in. Keep it out of the plugin folder, which an update can wipe. If an earlier version of these instructions put it there, move it.
2. Fill in one identity: the address it sends as (`sender`), a folder for its signature (`assets`), and a folder for its inbox files (`store`). An identity missing any of these is refused by name.
3. Put `SIGNATURE.txt` in the `assets` folder. For an HTML signature, set `html_sig` to true and add `SIGNATURE.html` and the logo. Keep these files out of git.
4. Copy `skills/postman/VOICE.md` to `~/.postman/VOICE.md` and write your own patterns into it. It must sit beside `identities.json`. Anywhere else it is ignored and the shipped default is used.

## Commands

Say "send these emails", "reply to the recruiter" or "what's in the inbox" and the skill fires. It is also a plain CLI, run from `skills/postman/`:

```
python postman.py --verify BATCH        check every address, print the table, send nothing
python postman.py --test BATCH          first email only, to the identity's test_to
python postman.py --draft BATCH         every email as a Gmail draft, sends nothing
python postman.py --send BATCH          sends, stamping the file as each one leaves
python postman.py --as NAME             override the batch file's Identity: line
python postman.py --bounces NAME DAYS   bounce sweep for one identity
python postman.py --drafts NAME [MATCH] list drafts, read-only. --purge trashes them
python postman.py inbox NAME [--days N] [--all] [--from ADDR] [--json]
python postman.py search NAME "QUERY"   Gmail search server-side, prints hits and URLs only
python postman.py --selftest            the built-in checks
python preflight.py BATCH               gates, voice, threading and reply status, read-only
```

`--verify` and `preflight.py` cost nothing and send nothing, so run them first. `--draft` and `--send` cannot be combined.

## Extend it

Add an identity per mailbox, each with its own signature, voice and password. postman never stores a password. Each identity names any command that prints one, so `pass`, Bitwarden, 1Password or your own vault script all work. The identity fields, the password rules and why postman never searches for its config are in [extending.md](skills/postman/references/extending.md).

## Details

- Replies set both `In-Reply-To` and `References`, because Outlook threads on the second.
- The HTML signature's inline logo is attached under the Content-ID the HTML already names.
- `--selftest` asserts that no default path can reach Hunter.
- `markdown` renders the body and `dnspython` does the MX check. Developed on Python 3.14. CI runs 3.12.
