# postman - real outbound email, from a file you can read

You have twelve venues to email, or forty applications, or one reply that has to land on
the right thread. Doing it by hand is an afternoon. Handing it to a model that speaks
"send an email" is how a half-finished draft reaches a real person under your name.

`postman` sits in between. You write one batch file, in markdown, one block per recipient.
The tool parses it, verifies every address, shows you exactly what will send, and only
sends when you say so, writing a `Sent:` stamp back into the file as each one leaves, so
a batch that dies at recipient 7 resumes at 7 rather than starting over.

**The differentiator is what it refuses to do.** Most mail tooling optimises for getting
the message out. This one is built around the four ways a real batch goes wrong:

- **An address nobody sourced.** Cold outbound needs a `Source:` line, a URL plus a read
  date inside 30 days, and it has to be the recipient's own domain. MX is checked on every
  address either way. The paid lookup (Hunter) is an ask, never automatic, and the selftest
  asserts no default path can reach it.
- **A reply that starts a new conversation.** Message-IDs are resolved live against your
  mailbox over IMAP, never taken from the batch file, and both `In-Reply-To` and
  `References` are set because Outlook threads on the second. If any reply in the batch
  cannot find its thread, **nothing sends at all**. A warning about mail that has already
  left is not a decision.
- **A signature that looks nearly right.** `SIGNATURE.html` is a verbatim slice of a real
  sent message of yours. It is concatenated, never regenerated, and the inline logo is
  attached under the Content-ID the HTML already names.
- **A body that reads like a machine wrote it.** A banned-phrase list you own refuses the
  build, in the subject as well as the body.

There is a read path too: `inbox` pulls a mailbox window into a generated `inbox.md` where
every message is accounted for, and the header prints the arithmetic that proves it. Two
caps bound the file, because it is read by a model and its size is a context budget. When
either bites, a `TRIMMED:` line goes into that header, since a trimmed file that reads as
whole is the actual failure mode.

## Install

```
/plugin marketplace add thelogicmatrix/lm-tools
/plugin install postman@lm-tools
```

Python 3.9 or newer. Two dependencies:

```
pip install markdown dnspython
```

`markdown` renders the body, `dnspython` does the MX check. Gmail over SMTP and IMAP,
using an app password. Developed on 3.14; CI runs 3.12.

## First run

postman ships with no mailbox of its own. Give it one:

1. Copy the plugin's `.postman/identities.example.json` to **`~/.postman/identities.json`**.
   Those are the only two places postman reads: `POSTMAN_HOME` if it is set, otherwise
   `~/.postman`. There is deliberately no search of the current directory or its parents
   (see below). A repo that wants its own outbound identity sets `POSTMAN_HOME`.
   **Do not put your real config inside the plugin directory** - a plugin update or a
   `git clean` in the marketplace checkout would take it with them. If you followed an
   earlier version of these instructions and did, move it to `~/.postman/`.
2. Fill in one identity. `sender`, `assets` and `store` are required, and a
   half-configured identity is refused by name rather than half-loaded.
3. Put `SIGNATURE.txt` (and `SIGNATURE.html` plus the logo, if `html_sig` is true) in that
   identity's `assets` directory. These live outside git on purpose.
4. Copy `skills/postman/VOICE.md` to **`~/.postman/VOICE.md`** and write your own patterns
   into it. It must sit beside `identities.json`: a `VOICE.md` anywhere else is silently
   ignored and the shipped default is used instead. postman reads yours when it is there and the shipped default otherwise.

| Field | | |
|---|---|---|
| `sender` | required | the address mail goes out as |
| `assets` | required | directory holding `SIGNATURE.txt`, `SIGNATURE.html`, the logo |
| `store` | required | where `inbox.md`, `seen.json` and `registry.json` live |
| `html_sig` | | `true` sends multipart HTML with the inline logo, `false` sends genuine text/plain. **Declared, never sniffed**. Inferring it from whether a file exists means a typo'd `assets` path silently downgrades a branded email and sends it anyway |
| `default` | | the identity used when nothing names one. Exactly one may set it |
| `logo` | | the inline image the HTML signature references, `logo.png` by default |
| `test_to` | | where `--test` sends. `POSTMAN_TEST_TO` overrides |
| `pw_env` | | the env var holding the app password, `POSTMAN_PW_<NAME>` by default |
| `pw_cmd` | | see below |

## Bring your own secret store

postman never stores a password and never asks you to paste one. An identity declares
`pw_cmd`: **any command that prints exactly one secret to stdout.**

```json
"pw_cmd": "pass show email/work"
"pw_cmd": "bw get password work-gmail-app-password"
"pw_cmd": "op read op://Private/work-gmail/app-password"
```

That is the whole contract, so `pass`, Bitwarden, 1Password, a hundred-line vault client
and a three-line shell script are all equally supported and postman never learns which you
use. The command's output is captured, never inherited, and a failure reports its stderr only.

**`pw_cmd` is executed, which is why postman never searches for its config.** It reads
`POSTMAN_HOME` or `~/.postman` and nothing else. An earlier version took the nearest
`.postman/` found by walking up from the working directory, so a repo could carry its own
identity - but that meant cloning a repo and reading your mail from inside it ran its
author's command, and the credential resolves on `inbox`, `--drafts` and `preflight.py`
too, not only on a send. Allowing identities-but-not-commands was not enough either: the
same file names an `assets` directory whose signature is concatenated into your outbound
mail, a `store` it writes to, and which of your exported variables holds the password.
Standing in a directory is not consent, so pointing `POSTMAN_HOME` at one is the only way
to use a config that is not in your home.

A `pw_cmd` may also be a JSON list (`["pass", "show", "email/work"]`), which skips shell-word
splitting entirely. Prefer the list on Windows, where the string form keeps quote characters
in the token and a path with a space breaks confusingly.
An exported `POSTMAN_PW_<NAME>` still wins, because an export is the only thing that works
when the secret store itself is down. `POSTMAN_NO_VAULT=1` turns the fallback off so a
missing credential fails fast instead of shelling out.

## Use

Say "send these emails", "reply to the recruiter" or "what's in the inbox" and the skill
fires. It is also a plain CLI:

```
python postman.py --verify BATCH        layers 1 and 2, prints the table, sends nothing
python postman.py --test BATCH          first email only, to the identity's test_to
python postman.py --draft BATCH         every email as a Gmail draft, sends nothing
python postman.py --send BATCH          sends, stamping the file as each one leaves
python postman.py --as NAME             override the batch file's Identity: line
python postman.py --bounces NAME DAYS   bounce sweep for one identity
python postman.py --drafts NAME [MATCH] list drafts, read-only. --purge trashes them
python postman.py inbox NAME [--days N] [--all] [--from ADDR] [--json]
python postman.py --selftest            the built-in checks
python preflight.py BATCH               gates, voice, threading and reply status, read-only
```

`--verify` and `preflight.py` cost nothing and send nothing. Run them first. Neither
`--draft` nor `--send` has a bare-path default: a mode flag is always required.

The batch grammar, the reply rules and the full ritual live in
[`skills/postman/SKILL.md`](skills/postman/SKILL.md).

## Not

- Not a mail client. It sends batches and reads a window. It does not manage your mailbox.
- Not a mailing-list tool. Every recipient is a block you wrote by hand, on purpose. If you
  want a thousand of them, you want a different category of software and probably a
  different consent story.
- Nothing to do with Postman the API client.
