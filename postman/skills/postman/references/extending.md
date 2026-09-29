# Extending postman

Your tier is a `.postman/` folder. The plugin only reads it, so an update never touches it. It holds `identities.json` and, optionally, your own `VOICE.md`.

## Where `.postman/` is found

Exactly two places, and the first one wins:

1. the folder named by the `POSTMAN_HOME` environment variable
2. `~/.postman/`

Both are resolved, so a symlinked home or a relative override cannot make one folder read as two. The working directory and its parents are never searched. A repo that wants its own outbound identity sets `POSTMAN_HOME`.

Never keep your real config inside the plugin folder. A plugin update, or a `git clean` in the marketplace checkout, would take it with them.

### Why there is no search

`pw_cmd` is executed, which is why postman never searches for its config. An earlier version took the nearest `.postman/` found by walking up from the working directory, so a repo could carry its own identity. That meant cloning a repo and reading your mail from inside it ran the repo author's command. The credential resolves on `inbox`, `--drafts` and `preflight.py` too, not only on a send.

Allowing identities but not commands was not enough either. The same file names an `assets` folder whose signature is concatenated into your outbound mail, a `store` postman writes to, and which of your exported variables holds the password. Standing in a folder is not consent, so pointing `POSTMAN_HOME` at one is the only way to use a config that is not in your home.

## `identities.json`

A JSON object of identity name to identity. The shipped `.postman/identities.example.json` has two: `branded` (HTML signature with an inline logo) and `plain` (plain text).

| Field | | |
|---|---|---|
| `sender` | required | the address mail goes out as |
| `assets` | required | folder holding `SIGNATURE.txt`, `SIGNATURE.html` and the logo |
| `store` | required | where `inbox.md`, `seen.json` and `registry.json` live |
| `html_sig` | | `true` sends multipart HTML with the inline logo, `false` sends genuine text/plain. **Declared, never sniffed.** Inferring it from whether a file exists means a typo'd `assets` path silently downgrades a branded email and sends it anyway |
| `default` | | the identity used when nothing names one. Exactly one may set it |
| `logo` | | the inline image the HTML signature references, `logo.png` by default |
| `test_to` | | where `--test` sends. `POSTMAN_TEST_TO` overrides |
| `pw_env` | | the env var holding the app password, `POSTMAN_PW_<NAME>` by default, with the identity name in capitals |
| `pw_cmd` | | a command that prints the app password (below) |
| `imap_host` | | the IMAP server every read connects to, `imap.gmail.com` by default. Sent, All Mail and Drafts are found by their SPECIAL-USE flags, so a mailbox in another language works. There is no `smtp_host` yet: sends always go through `smtp.gmail.com`, and an identity that sets one is refused |

An identity missing a required field is refused by name rather than half-loaded. More than one `"default": true` is refused too. With no default and more than one identity, a batch with no `Identity:` line and no `--as` is refused rather than guessed.

## Bring your own secret store

postman never stores a password and never asks you to paste one. Each identity resolves its own app password in this order:

1. the environment variable named by `pw_env`, which is `POSTMAN_PW_<NAME>` unless overridden
2. the identity's `pw_cmd`

A `pw_cmd` is **any command that prints exactly one secret to stdout.**

```json
"pw_cmd": "pass show email/work"
"pw_cmd": "bw get password work-gmail-app-password"
"pw_cmd": "op read op://Private/work-gmail/app-password"
```

That is the whole contract, so `pass`, Bitwarden, 1Password, a hundred-line vault client and a three-line shell script are all equally supported, and postman never learns which you use. The command's output is captured, never inherited. A failure reports its stderr only, and a command still running after 120 seconds is stopped.

A `pw_cmd` may also be a JSON list (`["pass", "show", "email/work"]`), which skips shell-word splitting entirely. Prefer the list on Windows, where the string form keeps quote characters in the token and a path with a space breaks confusingly.

An exported variable still wins over `pw_cmd`, because an export is the only thing that works when the secret store itself is down. `POSTMAN_NO_VAULT=1` turns the `pw_cmd` fallback off, so a missing credential fails fast instead of shelling out. The selftest sets it.

## `VOICE.md`

Put your own copy at `.postman/VOICE.md`, beside `identities.json`. postman reads it when it is there and the shipped default otherwise. A `VOICE.md` anywhere else is ignored.

Only its `## Banned` section is enforced: a banned phrase in a subject or body refuses the build. The `## Patterns - <identity>` sections, one per identity, are guidance for whoever drafts the mail. The shipped file explains how to write them.
