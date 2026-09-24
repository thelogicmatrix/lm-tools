#!/usr/bin/env python3
"""Postman - outbound work email from a batch file. See SKILL.md."""
import argparse
import contextlib
import imaplib
import json
import mimetypes
import os
import re
import smtplib
import ssl
import sys
import time
from datetime import date, datetime, timedelta, timezone
import email
import email.header                             # not implied by `import email`
import email.utils                              # nor is this
from email.message import EmailMessage
from pathlib import Path

import markdown

def config_dir():
    """Your tier: a `.postman/` directory this plugin only ever reads.

    `POSTMAN_HOME` if set, otherwise `~/.postman`. Both are resolved, so a symlinked home
    or a relative override cannot make the same directory read as two different places.

    **There is deliberately no walk-up from the working directory.** An earlier version
    took the nearest `.postman/identities.json` found by walking up, so a repo could carry
    its own outbound identity. That is a pleasant feature attached to a config file whose
    `pw_cmd` field is EXECUTED and whose `assets` field is concatenated into your outbound
    mail: cloning a repo and reading your mail from inside it was enough to run its
    author's command, and a partial-trust model that allowed identities-but-not-commands
    still left `assets`, `store` and `pw_env` under the repo's control. Two review passes
    found holes in it. A repo that genuinely wants its own identity sets POSTMAN_HOME,
    which is an act, not an accident.
    """
    override = os.environ.get("POSTMAN_HOME")
    if override:
        return Path(override).expanduser().resolve()
    return Path("~/.postman").expanduser().resolve()


REQUIRED_IDENTITY_KEYS = ("sender", "assets", "store")


def load_identities():
    """identities.json -> the dict the rest of this file expects.

    Read per call, never cached at import: the selftest repoints POSTMAN_HOME at a
    fixture, and a module-level constant would have frozen the real config before the
    fixture existed - the test would then pass against the wrong identities.
    """
    path = config_dir() / "identities.json"
    if not path.exists():
        raise SystemExit(
            f"no identities at {path}. Copy identities.example.json there and put your "
            f"own mailbox in it - see the plugin README.")
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as e:
        raise SystemExit(f"{path} is not valid JSON: {e}")
    if not isinstance(raw, dict) or not raw:
        raise SystemExit(f"{path} must be a non-empty object of name -> identity.")
    out = {}
    for name, d in raw.items():
        if not isinstance(d, dict):
            raise SystemExit(f"{path}: identity {name!r} must be an object.")
        missing = [k for k in REQUIRED_IDENTITY_KEYS if not d.get(k)]
        if missing:
            raise SystemExit(
                f"{path}: identity {name!r} is missing {', '.join(missing)}.")
        # html_sig is declared, never sniffed from the filesystem: inferring it from
        # "does SIGNATURE.html exist" means a typo'd assets path silently downgrades a
        # branded email to plain text and sends it anyway
        out[name] = dict(d,
                         assets=Path(d["assets"]).expanduser(),
                         store=Path(d["store"]).expanduser(),
                         html_sig=bool(d.get("html_sig")))
    return out


def default_identity(identities):
    """The one marked default, or the only one there is - never merely the first key.
    Key order is the order someone happened to type them in, which is not a fact to
    choose a sending mailbox on."""
    marked = sorted(n for n, d in identities.items() if d.get("default"))
    if len(marked) > 1:
        raise SystemExit(
            f"more than one identity is marked default: {', '.join(marked)}")
    if marked:
        return marked[0]
    if len(identities) == 1:
        return next(iter(identities))
    return None


def resolve_identity(cli_as, from_file):
    """--as beats the file, the file beats the default identity."""
    identities = load_identities()
    name = cli_as or from_file or default_identity(identities)
    if name is None:
        raise SystemExit(
            f'no identity given and none is marked "default": true, so there is no '
            f'safe fallback. Pass --as <name>. '
            f"Known: {', '.join(sorted(identities))}")
    if name not in identities:
        raise SystemExit(
            f"unknown identity {name!r}. Known: {', '.join(sorted(identities))}")
    return identities[name] | {"name": name}


def logo_name(ident):
    """The inline image the HTML signature references. Named per identity because a
    signature is branded and the file is not always called logo.png."""
    return ident.get("logo", "logo.png")


CID_RE = re.compile(r'src="cid:([^"]+)"')


def voice_md():
    """Your voice file if you have one, the shipped default otherwise. The banned list
    is content, not code - it belongs in your tier, next to your identities."""
    mine = config_dir() / "VOICE.md"
    return (mine if mine.exists() else Path(__file__).parent / "VOICE.md").resolve()
REQUIRED_HEADERS = ("subject",)  # 'source' is conditional: see _parse_block's fence logic
HEADER_RE = re.compile(r"^(To|Cc|Source|Third-party|Subject|Attach|Sent):\s*(.+)$")

# '@' is what separates an email from a heading. A real batch mixed prose sections
# and recipients under a plain '## ', and parsed correctly only because the '---'
# separators happened to fall right: 5 headings, 2 emails.
# re.M so finditer can count the markers in a whole batch; a one-line match is unaffected.
RECIPIENT_RE = re.compile(
    r"^## @(?P<slug>[\w-]+)\s*\|\s*(?P<display>.+?)\s*"
    r"<(?P<addr>[^<>@\s]+@[^<>\s]+)>\s*$", re.M)
# A fenced block, not a convention about blank lines. A trim that removes a marker
# would otherwise put the counterparty's words out under the sender's name, and that would
# look completely normal in the file.
QUOTED_RE = re.compile(r"^```quoted\s*$(?P<quoted>.*?)^```\s*$", re.M | re.S)
IDENTITY_RE = re.compile(r"^Identity:\s*(\S+)\s*$", re.M)
BRIEF_RE = re.compile(r"^# Brief\s*$(?P<brief>.*)", re.M | re.S)


class BatchError(Exception):
    """The batch file is malformed. Always names the offending block."""


def _parse_block(block):
    """One '## @slug | Name <addr>' block into a recipient dict, or None if it is notes."""
    lines = block.strip().splitlines()
    if not lines:
        return None
    m = RECIPIENT_RE.match(lines[0])
    if not m:
        if lines[0].startswith("## @"):
            raise BatchError(
                f"malformed recipient heading: {lines[0]!r} - expected "
                f"'## @slug | Display Name <address>'")
        return None
    rec = {"slug": m.group("slug"), "display": m.group("display"),
           "to": m.group("addr"), "cc": None, "third_party": None, "sent": None}
    end = len(lines)
    seen_headers = set()
    for i, line in enumerate(lines[1:], start=1):
        if not line.strip():
            end = i
            break
        h = HEADER_RE.match(line)
        if not h:
            raise BatchError(f"{rec['slug']}: unrecognised header line {line!r}")
        # a To: field overwrites the heading address, which is how the multi-address
        # case survives: the heading holds exactly one, IMAP SEARCH needs them split
        key = h.group(1).lower().replace("-", "_")
        if key in seen_headers:
            if key == "sent":
                # A second Sent: is over-determined in the SAFE direction: both stamps
                # mean 'already sent', so the block is skipped either way. Failing the
                # PARSE here made the whole file unreadable, which blocked resuming every
                # OTHER recipient until the extra line was hand-deleted - a worse outcome
                # than the ambiguity it was preventing. Loud, and still resumable.
                print(f"postman: {rec['slug']}: repeated 'Sent:' - treating the block as "
                      f"sent and keeping the first stamp. Delete the extra line when "
                      f"convenient.", file=sys.stderr)
                continue
            raise BatchError(
                f"{rec['slug']}: repeated '{h.group(1)}:' - a repeat would silently "
                f"overwrite the first. One line per header; Attach: takes a "
                f"comma-separated list.")
        seen_headers.add(key)
        if not h.group(2).strip():
            raise BatchError(
                f"{rec['slug']}: empty value on '{h.group(1)}:' - a whitespace-only "
                f"Sent: would read as unstamped and re-send silently.")
        rec[key] = h.group(2).strip()
    else:
        raise BatchError(f"{rec['slug']}: headers with no blank line and no body")
    missing = [h for h in REQUIRED_HEADERS if not rec.get(h)]
    if missing:
        raise BatchError(f"{rec['slug']}: missing header(s): {', '.join(missing)}")
    body = "\n".join(lines[end + 1:]).strip()
    if body.lstrip().startswith("```quoted"):
        q = QUOTED_RE.match(body.lstrip())
        if not q:
            raise BatchError(
                f"{rec['slug']}: unclosed 'quoted' fence. Never guessing where the "
                f"body starts - close it with ``` on its own line.")
        rec["quoted"] = q.group("quoted").strip()
        body = body.lstrip()[q.end():].strip()
    else:
        rec["quoted"] = ""
    # No fence line may survive into the body, wherever it came from. QUOTED_RE is
    # non-greedy, so a bare ``` line INSIDE the quote closes the fence early and the rest
    # of the counterparty's words become body_md: their words, out under the sender's name,
    # looking completely normal in the file. A misplaced second fence is the same harm
    # from the other end. your emails never contain code fences, so any ``` line is a
    # hard error rather than something to reason about.
    if "```quoted" in body or any(ln.strip().startswith("```")
                                  for ln in body.splitlines()):
        raise BatchError(
            f"{rec['slug']}: a ``` fence line in the body. One 'quoted' fence at the very "
            f"top and no other fence anywhere - a ``` inside the quote closes it early and "
            f"puts the rest of their words out as the sender's own.")
    rec["is_reply_block"] = bool(rec["quoted"])
    if rec["is_reply_block"]:
        if rec.get("source"):
            raise BatchError(
                f"{rec['slug']}: 'Source:' is rejected on a reply - the resolved thread "
                f"is the provenance. All 11 on 2026-08-11 were rubber-stamped domains.")
        if not is_reply(rec):
            raise BatchError(
                f"{rec['slug']}: has a 'quoted' fence but the subject is not a reply. "
                f"The fence gates Source:, the RE: prefix drives threading, and they "
                f"must agree.")
    elif is_reply(rec):
        # the same agreement, enforced from the other side. Without this a RE: subject with
        # no fence falls into the cold-outbound branch and demands Source:, and the natural
        # unblock is a bare own-domain line that check_provenance accepts as 'sourced' - the
        # exact 2026-08-11 pattern. A reply always has something to quote: what it answers.
        raise BatchError(
            f"{rec['slug']}: the subject is a reply but there is no 'quoted' fence. Add one "
            f"holding the counterparty's words, or fix the subject if this is not a reply.")
    elif not rec.get("source"):
        raise BatchError(f"{rec['slug']}: missing header(s): source")
    rec["body_md"] = body
    if not rec["body_md"]:
        raise BatchError(f"{rec['slug']}: empty body")
    return rec


def parse_batch(text):
    """(identity, brief, recs). Recipients in file order.

    The preamble is peeled by finding the first recipient marker, NOT by relying on
    _parse_block returning None for a non-recipient chunk: a preamble written with no
    '---' under it shares a chunk with the first recipient, and that path would drop
    both. Eight blocks in, seven sent, success reported.
    """
    first = re.search(r"^## @", text, re.M)
    if not first:
        raise BatchError(
            "no recipients found - every email needs a '## @slug | Name <addr>' line")
    preamble, body = text[:first.start()], text[first.start():]
    # A line that says Identity: and does not parse must NOT fall through to None, because
    # None means "no preamble" and resolves to the work sender: the silent fallback would be
    # which mailbox the batch sends from.
    bad = [ln for ln in preamble.splitlines()
           if ln.strip().lower().startswith("identity:") and not IDENTITY_RE.match(ln)]
    if bad:
        raise BatchError(
            f"malformed Identity: line {bad[0]!r} - expected 'Identity: <name>' with one "
            f"name and no spaces in it")
    # ...and two that both parse are the same stake from the other side: first-wins means
    # the losing line is a mailbox nobody chose, and the file reads as if it were honoured
    ids = IDENTITY_RE.findall(preamble)
    if len(ids) > 1:
        raise BatchError(
            f"{len(ids)} Identity: lines in the preamble ({', '.join(ids)}) - one batch, "
            f"one mailbox. Delete the one that is wrong; the first would have won silently.")
    identity = ids[0] if ids else None
    b = BRIEF_RE.search(preamble)
    brief = b.group("brief").strip() if b else ""

    recs = [r for r in (_parse_block(blk) for blk in body.split("\n---\n")) if r]
    declared = len(re.findall(r"^## @", text, re.M))
    if len(recs) != declared:
        got = {r["slug"] for r in recs}
        lost = [mm.group("slug") for mm in RECIPIENT_RE.finditer(text)
                if mm.group("slug") not in got]
        raise BatchError(
            f"{declared} recipient marker(s) in the file but {len(recs)} parsed"
            + (f" - lost: {', '.join(lost)}" if lost else ""))
    slugs = [r["slug"] for r in recs]
    dupes = {s for s in slugs if slugs.count(s) > 1}
    if dupes:
        raise BatchError(f"duplicate slug(s): {', '.join(sorted(dupes))}")
    return identity, brief, recs


def banned_phrases():
    """The banned list, read from VOICE.md's '## Banned' section - its only home."""
    out, inside = [], False
    path = voice_md()
    for line in path.read_text(encoding="utf-8").splitlines():
        if line.startswith("## "):
            inside = line.strip().lower() == "## banned"
        elif inside and line.startswith("- "):
            out.append(line[2:].strip())
    if not out:
        raise SystemExit(f"no banned phrases parsed from {path}")
    return out


def check_voice(body_md):
    """Phrases found in the body. Empty list means clean."""
    low = body_md.lower()
    return [p for p in banned_phrases() if p.lower() in low]


FRESH_DAYS = 30
SOURCE_RE = re.compile(r"^(?P<url>\S+?),\s*read\s+(?P<date>\d{4}-\d{2}-\d{2})$")
# The layer 2 verdicts that clear. One tuple, because the gate and the human table
# disagreeing is how a reply gets flagged "needing attention" and still sent.
CLEARED = ("sourced", "threaded")


def source_host(url):
    """The hostname of a Source: URL, scheme optional, www. stripped, lowercased."""
    host = url.split("//")[-1].split("/")[0].lower()
    return host[4:] if host.startswith("www.") else host


def check_provenance(rec, today):
    """Layer 2. Returns (verdict, reason). verdict: sourced | threaded | stale | unsourced.

    Official means the Source: URL is on the recipient's own domain, or a
    Third-party: line records why it is not. A directory listing is neither, which
    is exactly the case that would have bounced on 2026-08-05.
    """
    if rec.get("is_reply_block"):
        return "threaded", "reply, provenance is the resolved thread"
    m = SOURCE_RE.match(rec.get("source", "") or "")
    if not m:
        raise BatchError(
            f"{rec['slug']}: Source: must read '<url>, read YYYY-MM-DD', got "
            f"{rec.get('source')!r}")
    host = source_host(m.group("url"))
    addr_domain = rec["to"].rsplit("@", 1)[-1].lower()
    own_site = host == addr_domain or host.endswith("." + addr_domain)
    if not (own_site or rec.get("third_party")):
        return "unsourced", (f"source host {host} is not {addr_domain} and there is no "
                             f"Third-party: line")
    age = (today - date.fromisoformat(m.group("date"))).days
    if age > FRESH_DAYS:
        return "stale", f"read {age} days ago, over the {FRESH_DAYS} day window, re-read it"
    if age < 0:
        raise BatchError(f"{rec['slug']}: read date is in the future")
    return "sourced", f"{host}, read {age}d ago"


MAX_ATTACH_BYTES = 25 * 1024 * 1024  # Gmail's limit


def attach_paths(rec, base_dir):
    """Declared attachments, resolved against the batch file's own directory.
    'Attach: -' and an absent line both mean none."""
    raw = (rec.get("attach") or "").strip()
    if not raw or raw == "-":
        return []
    return [Path(base_dir) / p.strip() for p in raw.split(",") if p.strip()]


def check_attachments(recs, base_dir):
    """Offline, before anything sends. A missing file discovered at recipient 7
    leaves 1 to 6 already gone.

    The cap is PER MESSAGE and measured on the encoded size, which is what Gmail
    actually limits. This used to sum raw bytes across the whole batch: a 12 recipient
    batch carrying 3 MB each failed at 36 MB when every message was fine, and a single
    20 MB attachment passed at 20 MB raw when it leaves as ~26.7 MB on the wire.
    """
    for rec in recs:
        total = 0
        for p in attach_paths(rec, base_dir):
            if not p.is_file():
                raise BatchError(f"{rec['slug']}: attachment not found: {p}")
            total += p.stat().st_size
        # base64 is 4 bytes out per 3 in. Line breaks and MIME headers add a little more,
        # so this is the floor of the wire size, not an estimate of it.
        wire = total * 4 // 3
        if wire > MAX_ATTACH_BYTES:
            raise BatchError(
                f"{rec['slug']}: attachments are {total / 1e6:.1f} MB raw, about "
                f"{wire / 1e6:.1f} MB base64-encoded on the wire, over Gmail's 25 MB "
                f"per-message limit")


def has_mx(domain):
    """Layer 1. False on any resolver failure - a domain we cannot check is not usable."""
    import dns.resolver
    try:
        return bool(dns.resolver.resolve(domain, "MX"))
    except Exception:
        return False


def body_to_html(body_md):
    """Convert a batch body to html. nl2br: in a hand-written email body a newline
    always means a line break, so the batch bodies are written unwrapped, one line
    per paragraph. Without this the Guests/Dates/Budget block collapses into prose.
    """
    return markdown.markdown(body_md, extensions=["nl2br"])


def gate_voice(rec):
    """Refuse a record whose body OR subject carries a banned phrase.

    Both are prose you send, so both are gated. The subject is the likelier
    offender, being written last and least carefully.
    """
    found = check_voice(rec["body_md"] + "\n" + rec["subject"])
    if found:
        raise BatchError(
            f"{rec['slug']}: banned phrase(s) in body or subject: {', '.join(found)}")


def verify(recs, today=None):
    """Layers 1 and 2 over every recipient. Spends no credits and asks nothing."""
    today = today or date.today()
    rows = []
    for rec in recs:
        layer2, reason = check_provenance(rec, today)
        gate_voice(rec)
        domain = rec["to"].rsplit("@", 1)[-1]
        # a reply carries no Source: by rule, so the source columns come from the thread
        m = SOURCE_RE.match(rec.get("source") or "")
        rows.append({
            "slug": rec["slug"], "to": rec["to"],
            "host": source_host(m.group("url")) if m else "(thread)",
            "read": m.group("date") if m else "",
            "mx": has_mx(domain), "layer2": layer2, "reason": reason,
        })
    return rows


def print_table(rows):
    """The human gate. One row per recipient, nothing rounded up to a tick."""
    w = max((len(r["slug"]) for r in rows), default=4)
    for r in rows:
        mx = "MX" if r["mx"] else "NO-MX"
        print(f"{r['slug']:<{w}}  {r['to']:<38} {mx:<6} {r['layer2']:<9} {r['reason']}")
    bad = [r for r in rows if not r["mx"] or r["layer2"] not in CLEARED]
    print(f"\n{len(rows)} recipient(s), {len(bad)} needing attention.")
    if bad:
        print("Unsourced or stale addresses do not send. Layer 3 (Hunter) is an ask - "
              "see --hunter.")


def signature_cid(ident):
    """The Content-ID the signature HTML already references. Never invented."""
    found = CID_RE.findall((ident["assets"] / "SIGNATURE.html").read_text(encoding="utf-8"))
    if len(found) != 1:
        raise SystemExit(
            f"SIGNATURE.html must reference exactly one cid: image, found {len(found)}")
    return found[0]


def require_assets(ident):
    """Exactly the files this identity declares. A plain-text identity has no HTML
    signature and no logo, and demanding them would make it unusable."""
    names = ["SIGNATURE.txt"] + (["SIGNATURE.html", logo_name(ident)]
                                 if ident["html_sig"] else [])
    missing = [n for n in names if not (ident["assets"] / n).exists()]
    if missing:
        raise SystemExit(
            # .get: only resolve_identity stamps 'name', and a hand-built identity dict
            # would raise KeyError here - reporting a crash instead of the missing files
            f"{ident.get('name', ident['sender'])}: assets missing from "
            f"{ident['assets']}: {', '.join(missing)}")


def test_to(ident):
    """Where --test sends. Declared per identity, because the address that proves a
    branded signature renders is not always the one that proves a plain one does.

    POSTMAN_TEST_TO OVERRIDES the identity, it is not a fallback. Redirecting one test
    send to yourself is exactly what an export is for, and the old order made that export
    silently do nothing whenever the identity already declared an address - on a flag that
    performs a real send, to whoever the config happened to name.
    """
    addr = os.environ.get("POSTMAN_TEST_TO") or ident.get("test_to")
    if not addr:
        raise SystemExit(
            f"{ident['name']}: --test needs somewhere to send. Add \"test_to\" to the "
            f"identity in identities.json, or export POSTMAN_TEST_TO.")
    return addr


def pw_env(ident):
    """The env var holding this identity's app password. Derived from the name unless
    the identity overrides it, so two identities can never collide on one variable."""
    return ident.get("pw_env") or f"POSTMAN_PW_{ident['name'].upper()}"


def vault_password(ident):
    """The identity's app password, out of your secret store. Nothing reaches stdout.

    The store itself is yours, not this plugin's: an identity names a helper script and
    the item to open, and the helper prints exactly one secret to stdout. That contract
    is the whole extension point - a `pass` one-liner, a `bw get`, an op read, or a
    hundred-line vault client all satisfy it.

    Centralised here because every caller used to re-implement it, and a hand-rolled
    copy is where a secret leaks into a transcript (2026-08-13: two throwaway wrappers
    in one session). The identity already declares its own item, so which item to open
    was never the caller's decision to make.

    This RUNS a command out of a config file, which is why config_dir has no walk-up: the
    only two places a config is read from are POSTMAN_HOME and ~/.postman, both of which
    you set. See config_dir for the vector that removed.
    """
    import shlex
    import subprocess
    cmd = ident.get("pw_cmd")
    if not (cmd and str(cmd).strip()):
        raise SystemExit(
            f"{ident['name']}: no \"pw_cmd\" in identities.json, so there is nowhere to "
            f"read the password from. Either add one (a command printing the app "
            f"password on stdout) or export {pw_env(ident)}.")
    argv = cmd if isinstance(cmd, list) else shlex.split(cmd, posix=os.name != "nt")
    # capture, never inherit: a helper that writes the secret to the terminal would put
    # it in the transcript, which is the exact failure this function exists to prevent
    try:
        out = subprocess.run(argv, capture_output=True, text=True, timeout=120)
    except subprocess.TimeoutExpired:
        # never interpolate the exception: TimeoutExpired.__str__ embeds the whole argv,
        # and a pw_cmd that passes a session token as an argument would leak it here
        raise SystemExit(f"{ident['name']}: pw_cmd timed out after 120s.")
    if out.returncode != 0:
        # stderr only. A helper that fails mid-print could otherwise put a partial
        # secret in the exception text
        raise SystemExit(
            f"{ident['name']}: pw_cmd exited {out.returncode}: "
            f"{out.stderr.strip()[:400] or '(no stderr)'}")
    return out.stdout.strip()


def gmail_password(ident):
    """Environment first, helper second. The export stays supported because it is the
    only thing that works when the secret store itself is down."""
    pw = os.environ.get(pw_env(ident))
    if pw:
        return pw
    if os.environ.get("POSTMAN_NO_VAULT"):
        # the offline escape. The selftest asserts the missing-credential exit code, and
        # without this the helper fallback SUCCEEDS there and the "offline" test performs
        # a live mailbox pull and prints it to stdout - which is how a login token from a
        # real mailbox reached a transcript on 2026-08-13. Also the right switch for any
        # caller that must not block on the secret store.
        raise SystemExit(
            f"{pw_env(ident)} is not set and POSTMAN_NO_VAULT is set, so pw_cmd was not "
            f"run. Export {pw_env(ident)} in this shell - do not paste it into chat.")
    try:
        pw = vault_password(ident)
    except SystemExit:
        raise
    except Exception as e:
        # a store failure and a missing export want different messages: the first is an
        # outage to fix, the second is one export away
        raise SystemExit(
            f"{pw_env(ident)} is not set and pw_cmd failed "
            f"({type(e).__name__}: {e}). Resolve the app password yourself and export "
            f"it in this shell - do not paste it into chat.")
    if not pw:
        raise SystemExit(
            f"{ident['name']}: pw_cmd printed nothing. Check the command, or export "
            f"{pw_env(ident)} in this shell instead.")
    return pw


def build_message(rec, ident, to=None, subject_prefix="", in_reply_to=None,
                  references=None, base_dir=None):
    """Concatenate, never regenerate. See the design note this replaced for why.

    For an html_sig identity: htmlBody = converted body + SIGNATURE.html, and the logo
    rides as an inline part whose Content-ID matches the cid: already in the signature
    HTML, so the signature is never rewritten to suit the attachment.

    in_reply_to/references thread the message onto an existing conversation. Both come
    from thread_headers, never from the batch file: a hand-typed Message-ID that is
    subtly wrong threads nowhere and looks exactly like one that worked.
    """
    require_assets(ident)
    gate_voice(rec)

    msg = EmailMessage()
    msg["From"] = ident["sender"]
    msg["To"] = to or rec["to"]
    msg["Subject"] = subject_prefix + rec["subject"]
    if rec.get("cc") and not to:
        msg["Cc"] = rec["cc"]
    if in_reply_to:
        msg["In-Reply-To"] = in_reply_to
        # Outlook threads on References, Gmail mostly on In-Reply-To. Set both or the
        # reply threads for us and not for the venue, which is the case that matters.
        msg["References"] = references or in_reply_to

    sig_txt = (ident["assets"] / "SIGNATURE.txt").read_text(encoding="utf-8")
    msg.set_content(rec["body_md"] + "\n\n" + sig_txt)
    # a plain identity stays a genuine text/plain, not HTML with the logo removed - and
    # with attachments it becomes multipart/mixed whose only non-attachment part is that
    # text/plain, never an HTML alternative smuggled in by the attach path
    # a caller that forgets base_dir must NOT get a quietly file-less message: declared
    # would be 0 too, so the built-vs-declared reconciliation below would pass and the
    # one check standing between a job application and a missing resume routes around itself
    if base_dir is None and (rec.get("attach") or "").strip() not in ("", "-"):
        raise BatchError(
            f"{rec['slug']}: declares Attach: but build_message got no base_dir")
    files = attach_paths(rec, base_dir) if base_dir else []
    if ident["html_sig"]:
        sig_html = (ident["assets"] / "SIGNATURE.html").read_text(encoding="utf-8")
        msg.add_alternative(body_to_html(rec["body_md"]) + sig_html, subtype="html")
        html_part = msg.get_payload()[-1]
        logo = ident["assets"] / logo_name(ident)
        subtype = (mimetypes.guess_type(logo.name)[0] or "image/png").partition("/")[2]
        html_part.add_related(logo.read_bytes(), maintype="image", subtype=subtype,
                              cid=f"<{signature_cid(ident)}>")
    for p in files:
        ctype, _ = mimetypes.guess_type(p.name)
        # mimetypes has no .ics entry, so an invitation would go out as
        # application/octet-stream and Gmail would offer a download instead of the
        # invitation UI. That needs text/calendar, the METHOD the file declares, and
        # the CRLF endings RFC 5545 mandates - a .ics checked out with LF is not one.
        data, params = p.read_bytes(), {}
        if p.suffix.lower() == ".ics":
            ctype = "text/calendar"
            data = data.replace(b"\r\n", b"\n").replace(b"\n", b"\r\n")
            m = re.search(br"^METHOD:([A-Za-z]+)", data, re.M)
            params = {"method": (m.group(1).decode() if m else "REQUEST"),
                      "charset": "utf-8"}
        maintype, _, subtype = (ctype or "application/octet-stream").partition("/")
        msg.add_attachment(data, maintype=maintype, subtype=subtype,
                           filename=p.name, params=params)
    # verify the BUILT message, not the intent: "add_attachment did not throw" is not
    # evidence that a file is attached
    built = len(list(msg.iter_attachments()))
    if built != len(files):
        raise BatchError(
            f"{rec['slug']}: declared {len(files)} attachment(s), built {built}")
    return msg


def smtp_send(msg, password, conn=None):
    """Send one message. Pass conn to reuse an open session across a batch."""
    if conn is not None:
        conn.send_message(msg)
        return
    # the login address is the one on the message, so a message built for one identity
    # can never leave over the other identity's authenticated session
    with smtp_session(password, msg["From"]) as s:
        s.send_message(msg)


@contextlib.contextmanager
def smtp_session(password, sender):
    """One authenticated SMTP session for a whole batch. A connect/login per
    recipient is 12 login cycles in a few seconds on the real run, which Gmail
    throttles, and a throttle at recipient 7 leaves 1 to 6 already sent.
    """
    s = smtplib.SMTP("smtp.gmail.com", 587)
    try:
        s.starttls(context=ssl.create_default_context())
        s.login(sender, password)
        yield s
    finally:
        s.quit()


IMAP_HOST = "imap.gmail.com"
DRAFTS = '"[Gmail]/Drafts"'
SENT = '"[Gmail]/Sent Mail"'
ALL_MAIL = '"[Gmail]/All Mail"'

SUBJ_PREFIX_RE = re.compile(r"^(?:(?:re|fwd?|aw|antw|automatic reply)\s*:\s*)+", re.I)


def base_subject(subject):
    """Subject with every reply/forward prefix stripped, for thread matching."""
    return SUBJ_PREFIX_RE.sub("", subject).strip()


def is_reply(rec):
    """True when the batch subject carries a reply prefix. That is the whole trigger
    for threading: no new flag, no new batch field, and a draft written as 'RE: ...'
    is already saying what it is.
    """
    return base_subject(rec["subject"]) != rec["subject"].strip()


def _to_addrs(rec):
    """The To line as a list. IMAP SEARCH takes exactly ONE address per key.

    A batch To: may carry several (a real reply carried three), and joining them into one
    bare SEARCH atom is not a near-miss that threads badly, it is `BAD Could not parse
    command` and the whole draft dies. Each address is also quoted at the call site,
    because an unquoted atom breaks on anything IMAP treats as a delimiter.
    """
    return [a.strip() for a in rec["to"].split(",") if a.strip()]


# How far back a thread is worth reading. Venue threads run for weeks, so this is not the
# old 24 hour window: the question is whether our LAST mail was answered, whenever it was.
THREAD_LOOKBACK_DAYS = 90


def _newest_date(M, mailbox, criteria, subj, skip_autoreply=False):
    """When the newest message in `mailbox` matching `criteria` AND thread `subj` was sent.

    The subject stays out of the IMAP criteria for the same reason as _newest_matching: a
    folded header can never match a HEADER SUBJECT atom (2026-08-11). IMAP narrows on the
    address, which never folds, and the subject is decided here on the unfolded header.
    """
    typ, _ = M.select(mailbox, readonly=True)
    if typ != "OK":
        return None
    typ, data = M.search(None, *criteria)
    if typ != "OK":
        return None
    newest = None
    for uid in reversed((data[0] or b"").split()[-SCAN_DEPTH:]):
        typ, d = M.fetch(uid, "(BODY.PEEK[HEADER.FIELDS (SUBJECT DATE)])")
        if typ != "OK" or not d or not isinstance(d[0], tuple):
            continue
        hdrs = email.message_from_bytes(d[0][1])
        if not subject_matches(hdrs, subj):
            continue
        if skip_autoreply and is_autoreply(hdrs):
            continue
        try:
            when = email.utils.parsedate_to_datetime(hdrs.get("Date", ""))
        except (TypeError, ValueError):
            continue
        if when.tzinfo is None:                 # a naive Date is read as UTC
            when = when.replace(tzinfo=timezone.utc)
        if newest is None or when > newest:
            newest = when
    return newest


def awaiting_reply(M, rec):
    """When we last wrote this thread with nothing back since, else None.

    This gates nothing and blocks no send. It answers the one question that decides how
    the next mail is WRITTEN: if our last mail on this thread has not been answered, this
    one has to read as an amendment to it. On 2026-08-13 round 4 instead restated round 3's
    ask with new dates two hours later, and 11 venues were left working out which of the
    two counted. That is a drafting failure, not a sending one, so this reports and the
    writer decides. A guard that refused the send was the wrong layer: it also refused
    every ordinary next turn, which is 9 of 10 recipients on 2026-08-14.

    All Mail for their side, never INBOX alone: an archived reply has left INBOX and
    archiving is normal behaviour, so an INBOX read cannot tell silence from tidiness. An
    autoresponder is skipped, because an out-of-office answers nothing.
    """
    subj = base_subject(rec["subject"])
    since = (datetime.now(timezone.utc)
             - timedelta(days=THREAD_LOOKBACK_DAYS)).strftime("%d-%b-%Y")
    ours = theirs = None
    for addr in _to_addrs(rec):
        mine = _newest_date(M, SENT, ("SINCE", since, "TO", f'"{addr}"'), subj)
        if mine and (ours is None or mine > ours):
            ours = mine
        back = _newest_date(M, ALL_MAIL, ("SINCE", since, "FROM", f'"{addr}"'), subj,
                            skip_autoreply=True)
        if back and (theirs is None or back > theirs):
            theirs = back
    if ours is None:
        return None                             # nothing of ours to amend
    return None if theirs and theirs > ours else ours


def header_subject(hdrs):
    """The Subject as a human reads it: unfolded, encoded-words decoded.

    RFC 5322 lets a mailer wrap a long header over several lines, and email.parser hands
    those back with the CRLF and its leading whitespace intact. Collapsing all runs of
    whitespace is what turns the stored bytes back into the one-line subject.
    """
    raw = hdrs.get("Subject") or ""
    try:
        raw = str(email.header.make_header(email.header.decode_header(raw)))
    except (UnicodeDecodeError, ValueError, LookupError):
        pass                                    # undecodable: match on the raw form
    return " ".join(raw.split())


def subject_matches(hdrs, subj):
    """True when this message belongs to the thread whose base subject is subj."""
    return base_subject(header_subject(hdrs)) == base_subject(subj)


def is_autoreply(hdrs):
    """An autoresponder is in the thread but is not the venue talking to us, and
    threading onto it files our reply under 'Automatic reply:' in their client."""
    return "automatic reply" in header_subject(hdrs).lower()


# How far back to look per address. Their thread is at the end of the mailbox, and a venue
# we have exchanged more than this many messages with has a bigger problem than threading.
SCAN_DEPTH = 30


def _newest_matching(M, mailbox, criteria, subj):
    """Newest (Message-ID, References) from mailbox matching criteria AND subj.

    The subject is deliberately NOT part of the IMAP criteria. A HEADER SUBJECT atom is
    matched against the raw header bytes, so any atom long enough to span a fold can never
    hit (2026-08-11: this silently unthreaded 9 of 11 venue replies). IMAP narrows on the
    address, which never folds, and the subject is decided here on the unfolded header.
    """
    typ, _ = M.select(mailbox, readonly=True)
    if typ != "OK":
        return None
    typ, data = M.search(None, *criteria)
    if typ != "OK":
        return None
    uids = (data[0] or b"").split()
    for uid in reversed(uids[-SCAN_DEPTH:]):
        typ, d = M.fetch(uid, "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID REFERENCES SUBJECT)])")
        if typ != "OK" or not d or not isinstance(d[0], tuple):
            continue
        hdrs = email.message_from_bytes(d[0][1])
        if not subject_matches(hdrs, subj) or is_autoreply(hdrs):
            continue
        mid = (hdrs.get("Message-ID") or "").strip()
        if not mid:
            continue
        return mid, " ".join((hdrs.get("References") or "").split())
    return None


def thread_headers(M, rec):
    """(In-Reply-To, References) threading a reply to rec['to'], or (None, None).

    Prefers the venue's own latest message in the thread, and falls back to our sent
    one so a venue that has NOT replied still threads onto the original enquiry
    instead of arriving as a second conversation.

    A wrong Message-ID is worse than none, so anything uncertain returns (None, None).
    For a reply that is a HOLD, not a fallback: main() resolves every thread before the
    first send and refuses the whole batch rather than starting a new conversation.
    """
    subj = base_subject(rec["subject"])
    # Every To address is tried, INBOX before ALL_MAIL before SENT, so their reply wins over
    # ours and an archived reply still counts. The first address is not necessarily the one
    # who wrote in the thread. ALL_MAIL is included because a reply that has been archived
    # leaves INBOX entirely, and reading the inbox is normal working behaviour.
    candidates = [(mb, key, addr)
                  for mb, key in (("INBOX", "FROM"), (ALL_MAIL, "FROM"), (SENT, "TO"))
                  for addr in _to_addrs(rec)]
    for mailbox, key, addr in candidates:
        hit = _newest_matching(M, mailbox, (key, f'"{addr}"'), subj)
        if not hit:
            continue
        mid, prior = hit
        return mid, (f"{prior} {mid}".strip() if prior else mid)
    return None, None


def gate_or_die(recs, today=None):
    """Layers 1 and 2 over the batch. Exits rather than sending anything doubtful."""
    rows = verify(recs, today)
    print_table(rows)
    blocked = [r for r in rows if r["layer2"] not in CLEARED or not r["mx"]]
    if blocked:
        # The verdict rides in the message. "3 recipients did not clear" tells you
        # nothing he can act on, "cityhotel (unsourced, MX)" tells him what to go fix.
        named = ", ".join(
            f"{r['slug']} ({r['layer2']}, {'MX' if r['mx'] else 'no MX'})"
            for r in blocked)
        raise SystemExit(
            f"{len(blocked)} recipient(s) did not clear layer 2 or have no MX: "
            f"{named}. Fix the source or ask about --hunter. Nothing was sent.")
    return rows


@contextlib.contextmanager
def imap_session(password, sender):
    """One authenticated IMAP session, for the same reason as smtp_session."""
    M = imaplib.IMAP4_SSL(IMAP_HOST)
    try:
        M.login(sender, password)
        yield M
    finally:
        M.logout()


def append_draft(msg, password, conn=None):
    """Append one draft. Pass conn to reuse an open session across a batch."""
    if conn is None:
        with imap_session(password, msg["From"]) as M:
            append_draft(msg, password, conn=M)
        return
    # "\\Draft" so the message is a draft by flag, not only by which mailbox it landed in
    typ, _ = conn.append(DRAFTS, "\\Draft", imaplib.Time2Internaldate(time.time()),
                         msg.as_bytes())
    if typ != "OK":
        raise SystemExit(f"IMAP append failed for {msg['To']}: {typ}")


def stamp_block(path, slug, when):
    """Write 'Sent: <when>' into one block, as an atomic rewrite of the whole file.

    Written after EACH send, not once at the end: smtp_session's docstring names the
    throttle that leaves 1 to 6 already sent, and batching the writes loses every
    stamp in exactly the crash the stamp exists for.
    """
    text = path.read_text(encoding="utf-8", newline="")
    out, hit = [], False
    for line in text.splitlines(keepends=True):
        out.append(line)
        m = RECIPIENT_RE.match(line.rstrip("\n"))
        if m and m.group("slug") == slug:
            out.append(f"Sent: {when}\n")
            hit = True
    if not hit:
        raise BatchError(f"stamp: no block named {slug!r} in {path}")
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text("".join(out), encoding="utf-8", newline="")
    tmp.replace(path)


def bounce_sweep(password, since, sender):
    """Layer 4. Bounce senders seen since a date. The only ground truth available.

    All Mail, not INBOX: a bounce that has been archived has left INBOX entirely, and
    this is the last gate on a batch that has already gone out, so a false clean is the
    one answer it must never give. All Mail excludes only Spam and Trash, and no message
    we sent is FROM mailer-daemon, so the wider scope adds no false positives.
    """
    hits = []
    with imaplib.IMAP4_SSL(IMAP_HOST) as M:
        M.login(sender, password)
        typ, _ = M.select(ALL_MAIL, readonly=True)
        if typ != "OK":
            raise SystemExit(f"--bounces: SELECT {ALL_MAIL} failed: {typ}. Nothing was "
                             f"swept, so this is not a clean result.")
        stamp = since.strftime("%d-%b-%Y")
        for who in ("mailer-daemon", "postmaster"):
            typ, data = M.search(None, "SINCE", stamp, "FROM", who)
            if typ != "OK":
                raise SystemExit(f"--bounces: SEARCH FROM {who} failed: {typ}. Nothing "
                                 f"was swept, so this is not a clean result.")
            for uid in (data[0] or b"").split():
                typ, d = M.fetch(uid, "(BODY[HEADER.FIELDS (SUBJECT FROM)])")
                hits.append(d[0][1].decode("utf-8", "replace").strip())
    return hits


def sweep_drafts(password, sender, match=None, purge=False):
    """List drafts, optionally moving the matched ones to Trash.

    SKILL.md has always said "delete leftover drafts before sending the same batch",
    because --send does not consume a draft and hand-sending one then running --send
    is a double-send. It never said how, and there was no way to do it from here, so
    the instruction was unenforceable by anything but the Gmail UI.

    match is a case-insensitive substring tested against the To and Subject headers
    together. No match means every draft, which is why purge without a match has to
    be a deliberate thing to type.

    Purge sets the Gmail \\Trash label rather than the IMAP \\Deleted flag: the draft
    lands in Trash and is recoverable for 30 days, where an expunge would be final.
    """
    out = []
    with imaplib.IMAP4_SSL(IMAP_HOST) as M:
        M.login(sender, password)
        typ, _ = M.select(DRAFTS, readonly=not purge)
        if typ != "OK":
            raise SystemExit(f"--drafts: SELECT {DRAFTS} failed: {typ}. Nothing was "
                             f"read or changed.")
        typ, data = M.uid("SEARCH", "ALL")
        if typ != "OK":
            raise SystemExit(f"--drafts: SEARCH failed: {typ}. Nothing was changed.")
        for uid in (data[0] or b"").split():
            typ, d = M.uid("FETCH", uid, "(BODY.PEEK[HEADER.FIELDS (TO SUBJECT)])")
            if typ != "OK" or not d or not isinstance(d[0], tuple):
                continue
            hdr = " ".join(d[0][1].decode("utf-8", "replace").split())
            if match and match.lower() not in hdr.lower():
                continue
            out.append((uid.decode(), hdr))
            if purge:
                # Gmail-specific. +X-GM-LABELS (\Trash) moves it; the message survives
                # in Trash, so a wrong match costs a restore rather than the draft.
                # The label is ONE backslash and it is parenthesised. "\\\\Trash" in
                # source emits a literal \\Trash and Gmail answers BAD Could not parse
                # command, the same shape of failure as an unquoted multi-address SEARCH.
                typ, _ = M.uid("STORE", uid, "+X-GM-LABELS", "(\\Trash)")
                if typ != "OK":
                    raise SystemExit(
                        f"--drafts --purge: STORE \\Trash failed on uid {uid.decode()} "
                        f"after {len(out)-1} draft(s) had already been moved. Re-run to "
                        f"see what is left rather than assuming this one moved.")
    return out


HUNTER_URL = "https://api.hunter.io/v2/email-verifier"


def hunter_key():
    key = os.environ.get("POSTMAN_HUNTER_KEY")
    if not key:
        raise SystemExit(
            "POSTMAN_HUNTER_KEY is not set. Export it from wherever you keep it. "
            "Layers 1, 2 and 4 do not need it.")
    return key


def hunter_verify(address, key):
    """Layer 3, on request only. One credit per call. Never called by a default path.

    accept_all means cannot-be-disproved, not confirmed. Reported verbatim.
    """
    import json
    import urllib.parse
    import urllib.request
    q = urllib.parse.urlencode({"email": address, "api_key": key})
    with urllib.request.urlopen(f"{HUNTER_URL}?{q}", timeout=30) as r:
        if r.status == 202:
            raise SystemExit(f"{address}: Hunter still verifying (202), re-run - "
                             f"it bills once")
        return json.load(r)["data"]


# a real 1x1 PNG, not a stub: add_related parses it, and "b'notapng'" would make the
# branded-signature assertions pass against a message no mail client could render
PNG_1PX = ("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8"
           "BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==")


@contextlib.contextmanager
def fixture_home():
    """A throwaway `.postman/` holding two synthetic identities - one branded (HTML
    signature + inline logo), one plain text.

    The selftest runs inside this, which buys two things: it is green on a fresh clone
    with no mailbox configured, and it is the regression check on the config contract
    itself. If identities.json ever stops meaning what the README says it means, this
    fixture stops loading and the suite goes red.
    """
    import base64
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        home, assets = Path(td) / ".postman", Path(td) / "assets"
        home.mkdir()
        assets.mkdir()
        (assets / "SIGNATURE.txt").write_text("Ada Lovelace\n", encoding="utf-8")
        (assets / "SIGNATURE.html").write_text(
            '<p>Ada Lovelace<br><img src="cid:fixture-logo"></p>', encoding="utf-8")
        (assets / "logo.png").write_bytes(base64.b64decode(PNG_1PX))
        (home / "identities.json").write_text(json.dumps({
            "branded": {"sender": "ada@example.com", "assets": str(assets),
                        "store": str(Path(td) / "store"), "html_sig": True,
                        "default": True, "test_to": "ada+test@example.com"},
            "plain": {"sender": "ada.personal@example.com", "assets": str(assets),
                      "store": str(Path(td) / "store2"), "html_sig": False},
        }), encoding="utf-8")
        prev = os.environ.get("POSTMAN_HOME")
        os.environ["POSTMAN_HOME"] = str(home)
        try:
            yield home
        finally:
            if prev is None:
                os.environ.pop("POSTMAN_HOME", None)
            else:
                os.environ["POSTMAN_HOME"] = prev


def selftest():
    """Offline. Runs against fixture_home(), never against your real identities: a
    suite that reads the live config would go red on someone else's machine for
    reasons that have nothing to do with the code."""
    with fixture_home():
        return _selftest()


def _selftest():
    # resolve_identity, not identities()["branded"], so require_assets can name the
    # identity in its error message. Everything below builds against the branded one.
    import tempfile
    work = resolve_identity(None, None)
    sig_html_path = work["assets"] / "SIGNATURE.html"
    sig_txt_path = work["assets"] / "SIGNATURE.txt"
    logo_path = work["assets"] / logo_name(work)

    require_assets(work)
    assert logo_path.stat().st_size > 0, "logo is empty"
    assert sig_txt_path.read_text(encoding="utf-8").strip(), "text signature is empty"
    assert signature_cid(work), "no cid in signature"

    # Task 2: identities
    assert resolve_identity(None, None)["sender"] == "ada@example.com"
    assert resolve_identity(None, "plain")["sender"] == "ada.personal@example.com"
    # --as beats the file
    assert resolve_identity("branded", "plain")["sender"] == "ada@example.com"
    # --purge is destructive and must never fire without --drafts naming a mailbox.
    # Asserted at the arg layer, so the guard cannot be lost to a refactor of main().
    try:
        main(["--purge"])
    except SystemExit as e:
        assert "only applies to --drafts" in str(e), str(e)
    else:
        raise AssertionError("--purge ran without --drafts")

    try:
        resolve_identity("nope", None)
    except SystemExit as e:
        assert "branded" in str(e) and "plain" in str(e), str(e)
    else:
        raise AssertionError("unknown identity did not raise")

    # the default is the one that says so, never whichever key came first
    assert default_identity(load_identities()) == "branded"
    assert default_identity({"only": {"sender": "a@b.example"}}) == "only"
    assert default_identity({"a": {}, "b": {}}) is None, \
        "two identities and no default must force --as, not guess"
    try:
        default_identity({"a": {"default": True}, "b": {"default": True}})
    except SystemExit as e:
        assert "a" in str(e) and "b" in str(e), str(e)
    else:
        raise AssertionError("two defaults did not raise")

    # --test performs a REAL send, so which address wins is a correctness question, not a
    # preference. The export overrides the identity; pinned because the two disagreed
    # silently once and the docs believed the export won.
    _tt = {"name": "tt", "test_to": "declared@example.com"}
    _prior_tt = os.environ.pop("POSTMAN_TEST_TO", None)
    try:
        assert test_to(_tt) == "declared@example.com"
        os.environ["POSTMAN_TEST_TO"] = "exported@example.com"
        assert test_to(_tt) == "exported@example.com", \
            "POSTMAN_TEST_TO must beat the identity, or an export silently sends elsewhere"
        assert test_to({"name": "tt"}) == "exported@example.com"
        del os.environ["POSTMAN_TEST_TO"]
        try:
            test_to({"name": "tt"})
        except SystemExit as e:
            assert "POSTMAN_TEST_TO" in str(e), str(e)
        else:
            raise AssertionError("--test with nowhere to send did not raise")
    finally:
        if _prior_tt is None:
            os.environ.pop("POSTMAN_TEST_TO", None)
        else:
            os.environ["POSTMAN_TEST_TO"] = _prior_tt

    # the shipped example is the first file a new user copies, so it is held to the same
    # loader as a real config. An example that does not load is a first-run failure for
    # everyone, and nothing else would catch it drifting away from REQUIRED_IDENTITY_KEYS.
    example = Path(__file__).resolve().parent.parent.parent / ".postman" / "identities.example.json"
    assert example.exists(), f"shipped example config is missing: {example}"
    with tempfile.TemporaryDirectory() as td:
        home = Path(td) / ".postman"
        home.mkdir()
        (home / "identities.json").write_text(
            example.read_text(encoding="utf-8"), encoding="utf-8")
        prior = os.environ.get("POSTMAN_HOME")
        os.environ["POSTMAN_HOME"] = str(home)
        try:
            shipped = load_identities()
            assert default_identity(shipped), \
                "the example must name a default, or a new user's first send has no mailbox"
        finally:
            if prior is None:
                del os.environ["POSTMAN_HOME"]
            else:
                os.environ["POSTMAN_HOME"] = prior

    # an identity missing a required key is refused at load, naming the key: a config
    # that half-loads sends real email from a half-configured mailbox
    with tempfile.TemporaryDirectory() as td:
        bad = Path(td) / ".postman"
        bad.mkdir()
        (bad / "identities.json").write_text(
            json.dumps({"x": {"sender": "a@b.example"}}), encoding="utf-8")
        prev = os.environ["POSTMAN_HOME"]
        os.environ["POSTMAN_HOME"] = str(bad)
        try:
            load_identities()
        except SystemExit as e:
            assert "assets" in str(e) and "store" in str(e) and "x" in str(e), str(e)
        else:
            raise AssertionError("an incomplete identity did not raise")
        finally:
            os.environ["POSTMAN_HOME"] = prev

    # a plain-text identity builds a genuine single-part text/plain: no cid, no image.
    with tempfile.TemporaryDirectory() as td:
        (Path(td) / "SIGNATURE.txt").write_text("Ada Lovelace\n", encoding="utf-8")
        plain = {"sender": "ada.personal@example.com", "assets": Path(td),
                 "html_sig": False, "name": "plain"}
        rec = {"slug": "x", "to": "a@b.example", "subject": "s", "body_md": "Hi.",
               "cc": None, "display": "A B"}
        msg = build_message(rec, plain)
        assert msg["From"] == "ada.personal@example.com", msg["From"]
        assert not msg.is_multipart(), msg.get_content_type()
        assert msg.get_content_type() == "text/plain", msg.get_content_type()
        assert "cid:" not in msg.get_content()
        assert "Ada Lovelace" in msg.get_content(), \
            "SIGNATURE.txt content must reach the plain-text body"

        # ...and a missing asset is a SystemExit naming the file, even for an identity
        # dict with no 'name' key: a KeyError here would report a crash, not the fault
        empty = Path(td) / "empty"
        empty.mkdir()
        nameless = {k: v for k, v in plain.items() if k != "name"}
        try:
            build_message(rec, nameless | {"assets": empty})
        except SystemExit as e:
            assert "SIGNATURE.txt" in str(e) and "ada.personal@example.com" in str(e), \
                str(e)
        else:
            raise AssertionError("a missing signature did not raise")

    # the branded identity is unchanged: multipart/alternative with the related logo
    work_msg = build_message(
        {"slug": "y", "to": "a@b.example", "subject": "s", "body_md": "Hi.",
         "cc": None, "display": "A B"}, work)
    assert work_msg.get_content_type() == "multipart/alternative", \
        work_msg.get_content_type()
    assert any(p.get_content_type() == "image/png" for p in work_msg.walk())

    # Task 3: attachments
    with tempfile.TemporaryDirectory() as td:
        base = Path(td)
        (base / "SIGNATURE.txt").write_text("Ada Lovelace\n", encoding="utf-8")
        (base / "resume.pdf").write_bytes(b"%PDF-1.4 fake\n")
        plain = {"sender": "ada.personal@example.com", "assets": base,
                 "html_sig": False, "name": "plain"}
        rec = {"slug": "x", "to": "a@b.example", "subject": "s", "body_md": "Hi.",
               "cc": None, "display": "A B", "attach": "resume.pdf"}
        assert attach_paths(rec, base) == [base / "resume.pdf"]
        msg = build_message(rec, plain, base_dir=base)
        # multipart/mixed once something is attached, and the only non-attachment
        # part is still text/plain. This is the PRIMARY plain-identity path, not the
        # bare one.
        assert msg.get_content_type() == "multipart/mixed", msg.get_content_type()
        parts = list(msg.iter_attachments())
        assert len(parts) == 1, len(parts)
        assert len(parts[0].get_payload(decode=True)) > 0
        assert not any(p.get_content_type() == "image/png" for p in msg.walk())

        # the html_sig path reconciles too: the message becomes multipart/mixed wrapping
        # the alternative, and that alternative must NOT count towards the attachment
        # tally, or every real work send with a file attached would raise instead
        wmsg = build_message(dict(rec, slug="y"), work, base_dir=base)
        assert wmsg.get_content_type() == "multipart/mixed", wmsg.get_content_type()
        assert [p.get_content_type() for p in wmsg.iter_attachments()] == \
            ["application/pdf"], [p.get_content_type() for p in wmsg.iter_attachments()]
        assert any(p.get_content_type() == "image/png" for p in wmsg.walk())

        # an .ics goes out as a real invitation: text/calendar with the METHOD the
        # file declares and CRLF endings, not the octet-stream download Gmail used
        # to offer. The source file here is LF-only, as a git checkout leaves it.
        (base / "invite.ics").write_bytes(
            b"BEGIN:VCALENDAR\nMETHOD:CANCEL\nEND:VCALENDAR\n")
        imsg = build_message(dict(rec, slug="i", attach="invite.ics"), plain,
                             base_dir=base)
        ics = list(imsg.iter_attachments())[0]
        assert ics.get_content_type() == "text/calendar", ics.get_content_type()
        assert ics.get_param("method") == "CANCEL", ics.get_param("method")
        assert ics.get_payload(decode=True) == \
            b"BEGIN:VCALENDAR\r\nMETHOD:CANCEL\r\nEND:VCALENDAR\r\n", \
            ics.get_payload(decode=True)

        # a caller that omits base_dir for a rec that declares Attach: must raise, not
        # build a file-less message: declared would be 0 as well, so the reconciliation
        # above would pass and report success on an email with no resume on it
        try:
            build_message(rec, plain)
        except BatchError as e:
            assert "x" in str(e) and "base_dir" in str(e), str(e)
        else:
            raise AssertionError("Attach: with no base_dir did not raise")

        # a declared file that is not on disk is caught before anything sends
        try:
            check_attachments([{"slug": "x", "attach": "gone.pdf"}], base)
        except BatchError as e:
            assert "gone.pdf" in str(e) and "x" in str(e), str(e)
        else:
            raise AssertionError("a missing attachment did not raise")

        # a repeated Attach: is rejected, not last-wins: _parse_block does
        # rec[key] = value, so the first path would vanish silently
        try:
            parse_batch("## @x | A B <a@b.example>\nSource: b.example/c, read 2026-08-13\n"
                        "Subject: s\nAttach: a.pdf\nAttach: b.pdf\n\nHi.\n")
        except BatchError as e:
            assert "Attach" in str(e), str(e)
        else:
            raise AssertionError("a repeated Attach: did not raise")
        # the repeat guard generalises: Subject:/Source:/any header repeated is the
        # same silent last-wins overwrite Attach: was guarded against
        for dup in ("Subject: s2", "Source: b.example/d, read 2026-08-13"):
            try:
                parse_batch("## @x | A B <a@b.example>\n"
                            "Source: b.example/c, read 2026-08-13\n"
                            f"Subject: s\n{dup}\n\nHi.\n")
            except BatchError as e:
                assert "repeated" in str(e).lower(), str(e)
            else:
                raise AssertionError(f"a repeated {dup.split(':')[0]}: did not raise")
        # a header with a whitespace-only value is a hard error, not a falsy field -
        # a whitespace 'Sent:' otherwise reads as unstamped and re-sends silently
        try:
            parse_batch("## @x | A B <a@b.example>\n"
                        "Source: b.example/c, read 2026-08-13\nSubject: s\n"
                        "Sent: \t\n\nHi.\n")
        except BatchError as e:
            assert "empty" in str(e).lower(), str(e)
        else:
            raise AssertionError("a whitespace-only header value did not raise")

    assert attach_paths({"attach": "-"}, Path(".")) == []
    assert attach_paths({}, Path(".")) == []

    # Task 2: batch parsing
    sample = """## @grandhall | Enquiries <enquiry@grandhall.example>
Source: grandhall.example/corporate-dinner-dance/, read 2026-08-05
Subject: Private client dinner for 100

Hi,

Body text here.

---
## @heritagehall | Events <events@heritagehall.example>
Cc: bookings@heritagehall.example
Source: heritagehall.example/contact/, read 2026-08-05
Third-party: Example Events Co operates the hall's events
Subject: Another subject

Hi,

More body.

---
Notes that are not a recipient and must be ignored.
"""
    _, _, recs = parse_batch(sample)
    assert len(recs) == 2, f"expected 2 recipients, got {len(recs)}"
    assert recs[0]["slug"] == "grandhall"
    assert recs[0]["to"] == "enquiry@grandhall.example"

    # Task 1: the @ marker, the heading parser, and the preamble peel
    sample2 = """Identity: plain

# Brief

Budget is hard. Never state our position.

## @grandhall | Dana R. <dana.r@venuegroup.example>
Source: venuegroup.example/events/, read 2026-08-13
Subject: Private client dinner for 100

Hi Dana,

Body.

---
## @bistro | Sales <sales@bistro.example>
Source: bistro.example/private-events/, read 2026-08-13
Subject: Another subject

Hi,

More body.
"""
    ident, brief, recs2 = parse_batch(sample2)
    assert ident == "plain", ident
    assert "Never state our position" in brief, brief
    assert len(recs2) == 2, len(recs2)
    assert recs2[0]["slug"] == "grandhall"
    assert recs2[0]["display"] == "Dana R."
    # BARE address: check_provenance does rec["to"].rsplit("@",1)[-1], and a heading-shaped
    # value yields the domain "venuegroup.example>" with a trailing bracket, which makes
    # own_site false for every recipient and blocks the whole batch.
    assert recs2[0]["to"] == "dana.r@venuegroup.example", recs2[0]["to"]
    assert "<" not in recs2[0]["to"] and ">" not in recs2[0]["to"]

    # no preamble resolves to None, so the caller can fall through to "work"
    ident3, brief3, recs3 = parse_batch(
        "## @x | A B <a@b.example>\nSource: b.example/c, read 2026-08-13\nSubject: s\n\nHi.\n")
    assert ident3 is None and brief3 == "" and len(recs3) == 1

    # ...but a MALFORMED Identity: line must not resolve to None, which is indistinguishable
    # from no preamble and would send the batch from the work mailbox instead
    one_rec = ("## @x | A B <a@b.example>\n"
               "Source: b.example/c, read 2026-08-13\nSubject: s\n\nHi.\n")
    # a lower-case or indented one is caught too: it is the same typo and the same stake
    for bad_line in ("Identity: job hunt", "Identity:", "Identity: ",
                     "  Identity: plain", "identity: plain"):
        try:
            parse_batch(bad_line + "\n\n" + one_rec)
        except BatchError as e:
            assert "Identity" in str(e), str(e)
        else:
            raise AssertionError(f"a malformed {bad_line!r} did not raise")
    # and the valid form still parses, with the preamble line stripped either side
    assert parse_batch("Identity:   plain  \n\n" + one_rec)[0] == "plain"

    # two VALID Identity: lines is first-wins, which is the same wrong-mailbox class the
    # malformed guard above exists to prevent - one batch, one mailbox
    try:
        parse_batch("Identity: plain\nIdentity: branded\n\n" + one_rec)
    except BatchError as e:
        assert "plain" in str(e) and "branded" in str(e), str(e)
    else:
        raise AssertionError("two valid Identity: lines did not raise")

    # a To: field overrides the heading, for the multi-address case (three on one reply)
    _, _, recs4 = parse_batch(
        "## @x | A B <a@b.example>\nTo: a@b.example, c@d.example\n"
        "Source: b.example/c, read 2026-08-13\nSubject: s\n\nHi.\n")
    assert recs4[0]["to"] == "a@b.example, c@d.example", recs4[0]["to"]
    assert _to_addrs(recs4[0]) == ["a@b.example", "c@d.example"]

    # a lost recipient is a hard error naming the slug, never a quiet short batch
    doctored = sample2.replace("\n---\n## @bistro", "\n## @bistro")
    try:
        parse_batch(doctored)
    except BatchError as e:
        assert "bistro" in str(e), str(e)
    else:
        raise AssertionError("a lost recipient block did not raise")

    # a malformed recipient heading is named, not silently treated as prose
    try:
        parse_batch("## @x\nSource: b.example/c, read 2026-08-13\nSubject: s\n\nHi.\n")
    except BatchError as e:
        assert "malformed recipient heading" in str(e), str(e)
    else:
        raise AssertionError("a malformed heading did not raise")

    # a multi-address To must split, because IMAP SEARCH takes one address per key and a
    # joined atom is a BAD-command abort, not a bad thread (three addresses on one reply)
    assert _to_addrs({"to": "a@x.example, b@y.example , c@z.example"}) == ["a@x.example", "b@y.example", "c@z.example"]
    assert _to_addrs({"to": "solo@x.example"}) == ["solo@x.example"]
    assert recs[0]["cc"] is None
    assert recs[0]["body_md"].startswith("Hi,")
    assert recs[1]["cc"] == "bookings@heritagehall.example"
    assert recs[1]["third_party"].startswith("Example Events Co")

    # a block missing a required header is a clear error, not a silent skip
    try:
        parse_batch("## @nosubject | A B <a@b.example>\n"
                    "Source: b.example/x, read 2026-08-05\n\nHi")
    except BatchError as e:
        assert "subject" in str(e).lower(), f"unhelpful error: {e}"
    else:
        raise AssertionError("a block with no Subject: must raise BatchError")

    # no Source: line at all - the load-bearing rule, so it gets its own assertion
    try:
        parse_batch("## @nosource | A B <a@b.example>\nSubject: Hi\n\nHi")
    except BatchError as e:
        assert "source" in str(e).lower(), f"unhelpful error: {e}"
    else:
        raise AssertionError("a block with no Source: must raise BatchError")

    # Task 2: voice gate
    assert check_voice("Hi, thanks for the quick reply. Thank you.") == []
    assert check_voice("I hope this email finds you well.") == ["I hope this email finds you well"]
    assert check_voice("Please reach out if that helps.") == ["reach out"]
    # a plain semicolon is NOT a shipped default - it is a legal English sentence, and the
    # punctuation entries that used to sit in the shipped list were one person's rules
    assert check_voice("Cost is high; the date is free.") == []
    # punctuation still works as an entry for someone who adds it to their own VOICE.md;
    # that is proven in the voice_md override block below, against a real user file

    # Task 3: layer 2
    today = date(2026, 8, 5)

    def rec(to, source, third_party=None):
        return {"slug": "t", "to": to, "source": source, "third_party": third_party}

    v, _ = check_provenance(
        rec("enquiry@grandhall.example",
            "grandhall.example/corporate-dinner-dance/, read 2026-08-05"), today)
    assert v == "sourced", v

    # www. is stripped, and a subdomain of the address domain still counts as own-site
    v, _ = check_provenance(
        rec("events@cityhotel.example", "https://www.cityhotel.example/weddings, read 2026-08-01"),
        today)
    assert v == "sourced", v

    # the real 2026-08-05 failure: a directory listing an address on another domain
    v, why = check_provenance(
        rec("weddings@cityhotel.example",
            "venueblog.example/venues/cityhotel/, read 2026-08-05"), today)
    assert v == "unsourced", v
    assert "venueblog.example" in why and "cityhotel.example" in why, why

    # a Third-party: line is the recorded-decision escape hatch
    v, _ = check_provenance(
        rec("events@heritagehall.example", "heritagehall.example/contact/, read 2026-08-05",
            third_party="Example Events Co operates the hall's events"), today)
    assert v == "sourced", v

    # freshness: 30 days passes, 31 does not
    v, _ = check_provenance(rec("a@b.example", "b.example/x, read 2026-07-06"), today)
    assert v == "sourced", v
    v, why = check_provenance(rec("a@b.example", "b.example/x, read 2026-07-05"), today)
    assert v == "stale", v
    assert "31" in why, why

    # a Source: with no read date is a hard error, not a soft verdict
    try:
        check_provenance(rec("a@b.example", "b.example/x"), today)
    except BatchError as e:
        assert "read" in str(e).lower(), e
    else:
        raise AssertionError("Source: without a read date must raise BatchError")

    assert source_host("https://www.Example.COM/a/b") == "example.com"
    assert source_host("example.com/a") == "example.com"

    # Task 4: replies, the quoted fence, and the header rules
    reply_src = ("## @grandhall | Dana R. <dana.r@venuegroup.example>\n"
                 "Subject: RE: Private client dinner for 100\n\n"
                 "```quoted\nDana R., 11 Aug 14:22\nMinimum spend is $8,000.\n```\n\n"
                 "Hi Dana,\n\n100 guests.\n")
    _, _, rr = parse_batch(reply_src)
    assert rr[0]["is_reply_block"] is True
    assert "8,000" in rr[0]["quoted"]
    # THE fence guarantee: nothing inside it reaches the body that gets sent
    assert "8,000" not in rr[0]["body_md"], rr[0]["body_md"]
    assert rr[0]["body_md"].startswith("Hi Dana,")
    # a reply gets the 'threaded' verdict and gate_or_die accepts it. has_mx is stubbed
    # around the call because '.example' is a reserved TLD that never resolves: layer 1
    # would block this on DNS and the assertion under test is a layer 2 one.
    assert check_provenance(rr[0], date(2026, 8, 13))[0] == "threaded"
    real_has_mx = globals()["has_mx"]
    globals()["has_mx"] = lambda domain: True
    try:
        rows = gate_or_die(rr)
    finally:
        globals()["has_mx"] = real_has_mx
    assert rows[0]["layer2"] == "threaded", rows[0]

    # Source: on a reply is rejected - it cannot be satisfied honestly and on 11 Aug
    # all 11 were rubber-stamped bare domains that verified nothing
    try:
        parse_batch(reply_src.replace("Subject: RE:",
                                      "Source: venuegroup.example, read 2026-08-13\nSubject: RE:"))
    except BatchError as e:
        assert "Source" in str(e) and "grandhall" in str(e), str(e)
    else:
        raise AssertionError("Source: on a reply did not raise")

    # Subject: is required on EVERY block, replies included: thread_headers picks among
    # candidates from one address with subject_matches, and venuegroup runs two
    # deliberate parallel threads
    try:
        parse_batch(reply_src.replace("Subject: RE: Private client dinner for 100\n", ""))
    except BatchError as e:
        assert "subject" in str(e).lower(), str(e)
    else:
        raise AssertionError("a missing Subject: did not raise")

    # an unclosed fence is a hard error, never a fallback to sending the remainder
    try:
        parse_batch(reply_src.replace("Minimum spend is $8,000.\n```", "Minimum spend."))
    except BatchError as e:
        assert "fence" in str(e).lower(), str(e)
    else:
        raise AssertionError("an unclosed quoted fence did not raise")

    # a fence with no body after it never sends an empty message
    try:
        parse_batch("## @x | A B <a@b.example>\nSubject: RE: s\n\n"
                    "```quoted\ntheir words\n```\n")
    except BatchError as e:
        assert "empty body" in str(e) or "no body" in str(e), str(e)
    else:
        raise AssertionError("a fence with no body did not raise")

    # the two reply signals must agree: a fence with no RE: prefix is ambiguous, and
    # is_reply drives threading while the fence drives Source rejection
    try:
        parse_batch(reply_src.replace("Subject: RE: Private", "Subject: Private"))
    except BatchError as e:
        assert "quoted" in str(e).lower(), str(e)
    else:
        raise AssertionError("a fence without a reply subject did not raise")

    # a fence anywhere but the top is rejected too: the leading-fence check alone would
    # send it verbatim, and their words would leave as the sender's own
    for below in ("## @x | A B <a@b.example>\nSubject: RE: s\n\nHi.\n\n"
                  "```quoted\ntheir words\n```\n",
                  reply_src + "\n```quoted\nmore of their words\n```\n"):
        try:
            parse_batch(below)
        except BatchError as e:
            assert "quoted" in str(e).lower(), str(e)
        else:
            raise AssertionError("a fence below the body did not raise")

    # QUOTED_RE is non-greedy, so a bare ``` line INSIDE the quote closes the fence early
    # and the rest of the counterparty's words land in body_md and go out under the sender's
    # name. An inner code block inside the quote, prose after it:
    inner_fence = ("## @x | A B <a@b.example>\nSubject: RE: s\n\n"
                   "```quoted\nDana R., 11 Aug 14:22\nOur booking form asks for:\n"
                   "```\nname, guests, date\n```\n"
                   "Minimum spend is $8,000.\n```\n\nHi Dana,\n\n100 guests.\n")
    try:
        parse_batch(inner_fence)
    except BatchError as e:
        assert "x" in str(e) and "```" in str(e), str(e)
    else:
        raise AssertionError("a ``` line inside the quoted fence did not raise")

    # cold bodies are checked too: they never had a fence to extract, so nothing else in
    # the parser would ever look at a stray ``` in one
    for cold_fence in ("Hi.\n\n```\ncode\n```\n", "Hi.\n\n```python\ncode\n```\n"):
        try:
            parse_batch("## @x | A B <a@b.example>\n"
                        "Source: b.example/c, read 2026-08-13\nSubject: s\n\n" + cold_fence)
        except BatchError as e:
            assert "```" in str(e), str(e)
        else:
            raise AssertionError("a ``` fence in a cold body did not raise")

    # ...and a clean fenced reply is untouched by all of that
    assert parse_batch(reply_src)[2][0]["quoted"].endswith("$8,000."), \
        parse_batch(reply_src)[2][0]["quoted"]

    # the agreement runs both ways: a RE: subject with no fence would otherwise demand
    # Source:, and the natural unblock is a bare own-domain line that reads as 'sourced'
    # and threads anyway - the 2026-08-11 pattern the errors above cite
    try:
        parse_batch("## @x | A B <a@b.example>\nSubject: RE: s\n\nHi.\n")
    except BatchError as e:
        assert "fence" in str(e).lower() and "x" in str(e), str(e)
    else:
        raise AssertionError("a reply subject with no fence did not raise")
    # ...and neither side of the agreement broke: reply-with-fence and cold-without-fence
    assert parse_batch(reply_src)[2][0]["is_reply_block"] is True
    cold = parse_batch("## @x | A B <a@b.example>\n"
                       "Source: b.example/c, read 2026-08-13\nSubject: s\n\nHi.\n")[2][0]
    assert cold["is_reply_block"] is False and cold["quoted"] == ""

    # layer 1: a domain that cannot have mail. Deterministic offline too, since any
    # resolver failure is False by design - which is exactly why this assertion ALONE
    # proves nothing: it passes identically with no DNS at all, and every other MX path in
    # this file is stubbed, so the true branch would never run. The positive case below
    # exercises it where a resolver exists and says so out loud where one does not, rather
    # than going green on a check that never happened.
    assert has_mx("no-such-host.invalid") is False
    # NOT an assertion, and not coverage: it reports. Asserting here would fail the suite
    # on any runner without DNS egress, so layer 1's true branch stays formally untested
    # and this line exists so a green run cannot be mistaken for one that checked it.
    if not has_mx("gmail.com"):
        print("selftest: NO DNS EGRESS - layer 1's true branch was NOT exercised")

    # Task 4: assembly
    built = build_message(parse_batch(sample)[2][0], work)
    assert built["To"] == "enquiry@grandhall.example"
    assert built["From"] == work["sender"]
    assert built.get_content_type() == "multipart/alternative", built.get_content_type()

    html = built.get_body(preferencelist=("html",))
    html_src = html.get_content()
    sig = sig_html_path.read_text(encoding="utf-8")
    # Equality, not endswith: endswith would accept anything injected BETWEEN the body
    # and the signature, which is the regenerated-signature failure this invariant exists
    # to catch. rstrip absorbs only the trailing separator the MIME encoder adds when the
    # body lacks one, so this still holds if SIGNATURE.html later gains a trailing newline.
    expected = body_to_html(parse_batch(sample)[2][0]["body_md"]) + sig
    assert html_src.rstrip("\n") == expected.rstrip("\n"), \
        "html body must be exactly converted-markdown + SIGNATURE.html, concatenated"
    assert "<p>Body text here.</p>" in html_src, "markdown body missing from html part"
    # a newline inside a paragraph is a real line break. Without this the details block
    # (Guests / Dates / Budget / Timing) collapses into one run-on line in the client.
    assert "<br" in body_to_html("Guests: 100\nDates: flexible"), \
        "a newline in a body must survive into the html as a line break"

    plain = built.get_body(preferencelist=("plain",)).get_content()
    assert "Body text here." in plain
    assert sig_txt_path.read_text(encoding="utf-8").strip().splitlines()[0] in plain

    # exactly one cid reference, and the attached part's Content-ID matches it
    cid = signature_cid(work)
    assert html_src.count(f"cid:{cid}") == 1, "signature must reference its cid once"
    images = [p for p in built.walk() if p.get_content_maintype() == "image"]
    assert len(images) == 1, f"expected 1 inline image, got {len(images)}"
    assert images[0]["Content-ID"] == f"<{cid}>", images[0]["Content-ID"]
    assert images[0].get_payload(decode=True) == logo_path.read_bytes(), "logo bytes differ"

    # Task 7: threading. The IMAP lookup needs a live mailbox, so what is checked here
    # is everything that decides WHETHER and WHAT to thread.
    assert base_subject("RE: Dinner for 100") == "Dinner for 100"
    assert base_subject("Re: Fwd: RE:Dinner for 100") == "Dinner for 100"
    assert base_subject("Automatic reply: Dinner for 100") == "Dinner for 100"
    assert base_subject("Dinner for 100") == "Dinner for 100"
    # a subject that merely CONTAINS 're:' is not a reply
    assert base_subject("Venue re: the atrium") == "Venue re: the atrium"

    # A real batch sent most of its venue replies as NEW conversations. Cause was RFC 5322
    # header folding, not the mailbox. Outlook wrapped a 67-char subject, so the raw header
    # held "availability &\r\n quote" while the IMAP atom asked for "availability & quote",
    # and no HEADER SUBJECT search spanning the fold can ever match. Our own SENT copy folds
    # the same way, so the fallback failed with it. These are the real bytes from the mailbox.
    folded = (b"Subject: RE: Private client dinner for 100 - September 2026 availability &\r\n"
              b" quote\r\nMessage-ID: <AAAA00AA0000@mail.example.com>\r\n")
    hdrs = email.message_from_bytes(folded)
    want = "Private client dinner for 100 - September 2026 availability & quote"
    assert hdrs["Subject"] != "RE: " + want, "if this passes, the fold is gone and so is the bug"
    assert header_subject(hdrs) == "RE: " + want, header_subject(hdrs)
    assert subject_matches(hdrs, want), "a folded subject must still match its thread"
    assert base_subject(header_subject(hdrs)) == want

    # MIME encoded-words unfold and decode too, since a venue may send either
    enc = email.message_from_bytes(b"Subject: =?utf-8?q?Dinner_for_100?=\r\n")
    assert subject_matches(enc, "Dinner for 100"), header_subject(enc)
    # and a genuinely different thread still must not match
    assert not subject_matches(hdrs, "Some other enquiry entirely")
    # an autoresponder is in the thread but is not the venue talking to us
    auto = email.message_from_bytes(b"Subject: Automatic reply: " + want.encode() + b"\r\n")
    assert is_autoreply(auto) and not is_autoreply(hdrs)

    first = parse_batch(sample)[2][0]
    assert is_reply(first) is False, "a fresh enquiry must not be threaded"
    assert is_reply(dict(first, subject="RE: " + first["subject"])) is True

    threaded = build_message(first, work, in_reply_to="<abc@example.com>")
    assert threaded["In-Reply-To"] == "<abc@example.com>"
    # References defaults to In-Reply-To rather than being left off: Outlook threads on
    # References, so omitting it breaks threading at the venue but not for us.
    assert threaded["References"] == "<abc@example.com>"
    chained = build_message(first, work, in_reply_to="<b@x>", references="<a@x> <b@x>")
    assert chained["References"] == "<a@x> <b@x>"
    assert build_message(first, work)["In-Reply-To"] is None, \
        "a non-reply must carry no threading headers"

    # a banned phrase refuses the build
    bad = dict(parse_batch(sample)[2][0], body_md="I hope this email finds you well.")
    try:
        build_message(bad, work)
    except BatchError as e:
        assert "finds you well" in str(e), e
    else:
        raise AssertionError("a banned phrase must refuse the build")

    # ...and so does one hiding in the subject, where they are likeliest to appear
    bad = dict(parse_batch(sample)[2][0], subject="Do reach out about availability")
    try:
        build_message(bad, work)
    except BatchError as e:
        assert "subject" in str(e), e
    else:
        raise AssertionError("a banned phrase in the subject must refuse the build")

    try:
        verify([bad], date(2026, 8, 5))
    except BatchError:
        pass
    else:
        raise AssertionError("--verify must refuse a banned phrase in the subject")

    # Task 5: a batch with an unsourced recipient must refuse to send
    directory_batch = """## @cityhotel | Weddings <weddings@cityhotel.example>
Source: venueblog.example/venues/cityhotel/, read 2026-08-05
Subject: Enquiry

Hi,

Body.
"""
    try:
        gate_or_die(parse_batch(directory_batch)[2], date(2026, 8, 5))
    except SystemExit as e:
        assert "unsourced" in str(e), e
    else:
        raise AssertionError("an unsourced recipient must block the send")

    # and the clean batch passes the same gate. has_mx stubbed, not guarded on a live
    # resolver: the fixtures are .example domains that must never resolve, and a suite
    # that asks the network about someone else's domain fails for reasons that have
    # nothing to do with this code.
    real_has_mx = globals()["has_mx"]
    globals()["has_mx"] = lambda domain: True
    try:
        gate_or_die(parse_batch(sample)[2], date(2026, 8, 5))
    finally:
        globals()["has_mx"] = real_has_mx

    # Task 6: no default path may call Hunter. Layer 3 costs a credit per address, so
    # the ask being an ask is a property of the code, not of remembering to be careful.
    # Matched on the two callables, not the word: gate_or_die's error message points
    # you at --hunter, and a substring check reads that hint as a violation.
    import inspect
    for fn in (verify, gate_or_die, build_message, append_draft, thread_headers):
        src = inspect.getsource(fn)
        for callable_name in ("hunter_verify", "hunter_key"):
            assert callable_name not in src, (
                f"{fn.__name__} calls {callable_name} - layer 3 is an ask, never automatic")

    # Task 5: stamping
    with tempfile.TemporaryDirectory() as td:
        bp = Path(td) / "batch.md"
        bp.write_text(
            "## @one | A B <a@b.example>\nSource: b.example/c, read 2026-08-13\n"
            "Subject: s1\n\nHi.\n\n---\n"
            "## @two | C D <c@d.example>\nSource: d.example/c, read 2026-08-13\n"
            "Subject: s2\n\nHi.\n", encoding="utf-8")
        stamp_block(bp, "one", "2026-08-13 09:14")
        _, _, sr = parse_batch(bp.read_text(encoding="utf-8"))
        assert sr[0]["sent"] == "2026-08-13 09:14", sr[0].get("sent")
        assert sr[1]["sent"] is None
        # the stamp survives a re-parse and does not corrupt the block
        assert sr[0]["body_md"] == "Hi."
        assert sr[0]["subject"] == "s1"
        # stamping the second leaves the first alone
        stamp_block(bp, "two", "2026-08-13 09:15")
        _, _, sr2 = parse_batch(bp.read_text(encoding="utf-8"))
        assert [r["sent"] for r in sr2] == ["2026-08-13 09:14", "2026-08-13 09:15"]
        # stamping must not translate the file's line endings: a CRLF batch that gets
        # one stamp must not arrive as a whole-file LF diff
        crlf = Path(td) / "crlf.md"
        crlf.write_bytes(
            b"## @one | A B <a@b.example>\r\nSource: b.example/c, read 2026-08-13\r\n"
            b"Subject: s1\r\n\r\nHi.\r\n")
        stamp_block(crlf, "one", "2026-08-13 09:14")
        raw = crlf.read_bytes()
        assert b"Subject: s1\r\n" in raw, "existing CRLF endings must survive a stamp"
        # ...and the direction that actually breaks on Windows: write_text with the default
        # newline=None translates every \n to os.linesep, so an LF batch stamped here came
        # back a whole-file CRLF diff. The CRLF fixture above cannot catch that - on this
        # platform the old code produced CRLF whatever it was handed, so it passed both ways.
        lf = Path(td) / "lf.md"
        lf.write_bytes(
            b"## @one | A B <a@b.example>\nSource: b.example/c, read 2026-08-13\n"
            b"Subject: s1\n\nHi.\n")
        stamp_block(lf, "one", "2026-08-13 09:14")
        assert lf.read_bytes().count(b"\r\n") == 0, "an LF batch must stay LF after a stamp"

    # Task 5: a stamped block is exempt from the gates, or resuming is impossible. Block
    # one is already sent and carries both faults a resume runs into: a Source: that has
    # since crossed the 30 day window, and an attachment renamed after it went out.
    # Gating every block would refuse to send recipient two for recipient one's sake.
    resume_src = ("## @one | A B <a@b.example>\n"
                  "Source: b.example/c, read 2026-06-01\nAttach: gone.pdf\n"
                  "Subject: s1\nSent: 2026-08-13 09:14\n\nHi.\n\n---\n"
                  "## @two | C D <c@d.example>\n"
                  "Source: d.example/c, read 2026-08-13\nSubject: s2\n\nHi.\n")
    _, _, rs = parse_batch(resume_src)
    rs_pending = [r for r in rs if not r["sent"]]
    assert [r["slug"] for r in rs_pending] == ["two"], rs_pending
    # has_mx stubbed for the same reason as the reply gate above: .example never resolves
    real_has_mx = globals()["has_mx"]
    globals()["has_mx"] = lambda domain: True
    try:
        gate_or_die(rs_pending, date(2026, 8, 13))
        try:
            gate_or_die(rs, date(2026, 8, 13))
        except SystemExit as e:
            assert "one" in str(e) and "stale" in str(e), str(e)
        else:
            raise AssertionError("a stale source on an unstamped block must block the send")
    finally:
        globals()["has_mx"] = real_has_mx
    with tempfile.TemporaryDirectory() as td:
        check_attachments(rs_pending, Path(td))
        try:
            check_attachments(rs, Path(td))
        except BatchError as e:
            assert "gone.pdf" in str(e) and "one" in str(e), str(e)
        else:
            raise AssertionError("a missing attachment on an unstamped block must raise")

    # Task 6: preflight must parse against the new return type, and its voice gate must
    # actually see a planted banned phrase. r.get("body", "") returned "" on every block,
    # so it printed clean on every batch ever run.
    # Source read, never `import preflight`: preflight.py is a script, not a module - its
    # module level reads sys.argv[1], resolves an app password through the identity's
    # pw_cmd and opens an authenticated IMAP session. Importing it would log in to
    # Gmail to run a unit test.
    _src = (Path(__file__).parent / "preflight.py").read_text(encoding="utf-8")
    _arg = re.search(r"check_voice\((.+?)\)\n", _src).group(1)
    _, _, _vr = parse_batch(
        "## @x | A B <a@b.example>\nSource: b.example/c, read 2026-08-13\n"
        "Subject: I hope this email finds you well\n\nBody.\n")
    r = _vr[0]
    assert eval(f"check_voice({_arg})"), \
        "preflight's voice gate sees nothing - it is passing a key parse_batch never sets"

    # a repeated Sent: must NOT kill the parse - it blocked resuming every other block
    _, _, _ds = parse_batch(
        "## @one | A B <a@b.example>\nSource: b.example/c, read 2026-08-13\n"
        "Subject: s\nSent: 2026-08-13 14:01\nSent: 2026-08-13 16:22\n\nHi.\n")
    assert _ds[0]["sent"] == "2026-08-13 14:01", \
        f"a double stamp must keep the FIRST stamp, got {_ds[0].get('sent')!r}"

    # the attachment cap is per message and measured base64-encoded
    with tempfile.TemporaryDirectory() as td:
        big = Path(td) / "big.pdf"
        big.write_bytes(b"x" * 20_000_000)          # 20 MB raw, ~26.7 MB on the wire
        _, _, _ar = parse_batch(
            "## @one | A B <a@b.example>\nSource: b.example/c, read 2026-08-13\n"
            "Subject: s\nAttach: big.pdf\n\nHi.\n")
        try:
            check_attachments(_ar, Path(td))
        except BatchError as e:
            assert "26." in str(e) and "per-message" in str(e), str(e)
        else:
            raise AssertionError("20 MB raw is over 25 MB once base64-encoded")
        # and the same file across two recipients is two messages, not one 40 MB batch
        small = Path(td) / "small.pdf"
        small.write_bytes(b"x" * 9_000_000)         # 9 MB raw, 12 MB encoded, fine
        _, _, _ar2 = parse_batch(
            "## @one | A B <a@b.example>\nSource: b.example/c, read 2026-08-13\n"
            "Subject: s\nAttach: small.pdf\n\nHi.\n---\n"
            "## @two | C D <c@d.example>\nSource: d.example/c, read 2026-08-13\n"
            "Subject: s\nAttach: small.pdf\n\nHi.\n")
        check_attachments(_ar2, Path(td))           # must not raise: 12 MB each

    # the reply check. It answers one authoring question: has our last mail on this thread
    # been answered. If it has not, the next mail has to be written as an amendment to it
    # rather than the same ask with the numbers changed, which is what went wrong on
    # 2026-08-13. It gates nothing and never blocks a send.
    class _FakeBox:
        """SENT and ALL_MAIL, each absent or holding one (hours_ago, subject)."""

        def __init__(self, sent=None, inbound=None):
            self.msgs = {SENT: sent, ALL_MAIL: inbound}
            self.box = None

        def select(self, mailbox, readonly=False):
            self.box = mailbox
            return "OK", [b"1"]

        def search(self, charset, *criteria):
            return "OK", [b"1" if self.msgs.get(self.box) else b""]

        def fetch(self, uid, spec):
            ago, subj = self.msgs[self.box]
            when = datetime.now(timezone.utc) - timedelta(hours=ago)
            raw = (f"Subject: {subj}\r\n"
                   f"Date: {email.utils.format_datetime(when)}\r\n").encode()
            return "OK", [(b"1 (BODY[HEADER]", raw)]

    _S = "RE: Dinner for 100"
    _rec = {"slug": "grandhall", "to": "dana.r@venuegroup.example", "subject": _S}
    # we wrote 2h ago and nothing has come back: this one amends that one
    assert awaiting_reply(_FakeBox(sent=(2, _S)), _rec) is not None, \
        "an unanswered send must be reported"
    # they answered after we wrote, so this is simply the next turn
    assert awaiting_reply(_FakeBox(sent=(26, _S), inbound=(2, _S)), _rec) is None, \
        "a reply since our last send means nothing is awaiting"
    # their message predates our last one, so ours is still unanswered
    assert awaiting_reply(_FakeBox(sent=(2, _S), inbound=(26, _S)), _rec) is not None, \
        "an older inbound does not answer a newer send"
    # we have never written to them, so there is nothing to amend
    assert awaiting_reply(_FakeBox(), _rec) is None, "no prior send means nothing awaiting"
    # an autoresponder is in the thread but is not the venue answering us
    assert awaiting_reply(
        _FakeBox(sent=(26, _S), inbound=(2, "Automatic reply: Dinner for 100")),
        _rec) is not None, "an out-of-office is not a reply"
    # a different thread is a different conversation
    assert awaiting_reply(_FakeBox(sent=(2, _S)),
                          dict(_rec, subject="Other enquiry")) is None, \
        "another thread's send is not this thread's"

    # credential resolution, offline. Never calls vault_password: POSTMAN_NO_VAULT is
    # what keeps this a unit test instead of a live secret-store round trip.
    _ident = resolve_identity("branded", None)
    os.environ[pw_env(_ident)] = "env-wins"
    assert gmail_password(_ident) == "env-wins", "the environment must beat the store"
    os.environ.pop(pw_env(_ident))
    os.environ["POSTMAN_NO_VAULT"] = "1"
    try:
        gmail_password(_ident)
    except SystemExit as e:
        # the message has to name the switch, or the failure reads as a missing export
        assert "POSTMAN_NO_VAULT" in str(e), str(e)
    else:
        raise AssertionError("POSTMAN_NO_VAULT must stop the vault fallback")
    finally:
        os.environ.pop("POSTMAN_NO_VAULT", None)

    # pw_cmd is the security-critical seam and it used to have no test at all: the block
    # above deliberately never reaches it. These do, with a python -c that prints a
    # harmless string, so the contract is exercised without a real secret store.
    import sys as _sys
    _pw_ident = dict(resolve_identity("branded", None))
    _pw_ident.pop("pw_env", None)
    os.environ.pop(pw_env(_pw_ident), None)
    _pw_ident["pw_cmd"] = [_sys.executable, "-c", "print('a-secret')"]
    assert gmail_password(_pw_ident) == "a-secret", "pw_cmd's stdout is the password"

    # every failure mode, through the entry point callers actually use. Each asserts the
    # message a stranger would have to act on, and that the secret is not in it.
    for _bad, _needle in (
        ({"pw_cmd": None}, "pw_cmd"),                                    # absent
        ({"pw_cmd": "   "}, "pw_cmd"),                                   # whitespace, used to IndexError
        # prints the secret and THEN fails: the only shape where the error path could leak
        # it, which is why vault_password reports stderr and never stdout. Without this
        # case the "not in str(e)" assertion below is true for want of anything to catch.
        ({"pw_cmd": [_sys.executable, "-c", "print('a-secret'); raise SystemExit(3)"]},
         "exited 3"),
        ({"pw_cmd": [_sys.executable, "-c", "pass"]}, "printed nothing"),
        ({"pw_cmd": ["no-such-binary-anywhere-postman"]}, "pw_cmd failed"),
    ):
        _case = dict(_pw_ident, **_bad)
        if _case["pw_cmd"] is None:
            del _case["pw_cmd"]
        try:
            _r = gmail_password(_case)
        except SystemExit as e:
            assert _needle in str(e), f"{_bad}: wanted {_needle!r}, got {str(e)[:200]!r}"
            assert "a-secret" not in str(e), "an error path leaked the password"
        else:
            raise AssertionError(f"{_bad} did not raise (returned {_r!r})")

    # config_dir must NOT find a .postman/ by walking up out of the cwd. A repo you cloned
    # five minutes ago would otherwise supply a pw_cmd that runs, plus an assets directory
    # whose signature is concatenated into your outbound mail. Standing in a directory is
    # not consent, so only POSTMAN_HOME and ~/.postman are read.
    with tempfile.TemporaryDirectory() as td:
        _prior_cwd = os.getcwd()
        _prior_home = None
        _had_home = "POSTMAN_HOME" in os.environ
        try:
            _prior_home = os.environ.pop("POSTMAN_HOME", None)
            _hostile = Path(td) / "cloned-repo"
            (_hostile / ".postman").mkdir(parents=True)
            (_hostile / ".postman" / "identities.json").write_text(
                json.dumps({"x": {"sender": "a@b.example", "assets": td, "store": td,
                                  "pw_cmd": [_sys.executable, "-c", "print('executed')"]}}),
                encoding="utf-8")
            _deep = _hostile / "src" / "nested"
            _deep.mkdir(parents=True)
            os.chdir(_deep)
            # .resolve() on both sides: a TemporaryDirectory is behind a symlink on macOS
            # (/var -> /private/var) and can be an 8.3 path on Windows, so comparing a
            # resolved path against an unresolved one is green on Linux and red elsewhere.
            assert config_dir() == Path("~/.postman").expanduser().resolve(), \
                f"a .postman/ in a parent directory must be ignored, got {config_dir()}"
            assert config_dir() != (_hostile / ".postman").resolve()
        finally:
            os.chdir(_prior_cwd)
            if _had_home:
                os.environ["POSTMAN_HOME"] = _prior_home

    # voice_md's two branches: yours when present, the shipped default otherwise. Neither
    # was covered, and the README sells the override as load-bearing behaviour.
    assert voice_md() == Path(__file__).resolve().parent / "VOICE.md", \
        "with no user VOICE.md the shipped default must win"
    _user_voice = config_dir() / "VOICE.md"
    # an em dash as the entry: proves a user file wins AND that a punctuation entry works,
    # which is what VOICE.md now tells people to do instead of inheriting one
    _user_voice.write_text("## Banned\n\n- a-phrase-only-here\n- —\n", encoding="utf-8")
    try:
        assert voice_md() == _user_voice, "a user VOICE.md must beat the shipped one"
        assert "a-phrase-only-here" in banned_phrases()
        assert check_voice("A range 3 — 4pm.") == ["—"], \
            "a punctuation entry in a user's own file must still refuse the build"
        assert check_voice("I hope this email finds you well.") == [], \
            "a user file REPLACES the shipped list, it does not merge with it"
    finally:
        _user_voice.unlink()
    assert voice_md() == Path(__file__).resolve().parent / "VOICE.md"

    # Every domain in a shipped file must be a reserved one. This check is INVERSE: it does
    # not look for names someone thought of, it rejects anything not provably fake. Three
    # hand-written sweeps for guessed strings all came back clean while a real person's
    # address at a real government agency sat in a fixture, because a sweep for suspected
    # names only ever finds what its author already suspected.
    _real_hosts = {"gmail.com", "smtp.gmail.com", "imap.gmail.com",   # the mail service
                   "api.hunter.io"}                                   # the opt-in verifier
    # suffixes that are a file extension or a reserved namespace, not somebody's domain
    _safe_suffix = {
        "example", "invalid", "test", "localhost",                    # RFC 2606/6761
        "py", "md", "json", "yml", "yaml", "txt", "html", "htm", "css", "js", "mjs",
        "png", "jpg", "jpeg", "gif", "svg", "pdf", "csv", "bak", "log", "cfg", "ini",
        "toml", "lock", "sh", "bat", "ps1", "exe", "zip", "gz",
    }
    # Three patterns. The first two are EXHAUSTIVE - an address or a URL is unambiguous.
    # The third is best-effort by construction: a bare dotted token cannot be told from
    # `json.loads` without knowing every TLD, so it is a net, not a wall. The first cut of
    # this check enumerated dangerous TLDs and a review planted a fresh one straight
    # through it, which is the same predictive mistake the check exists to replace.
    _pats = (re.compile(r"[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,24})\b"),
             re.compile(r"https?://([A-Za-z0-9.-]+\.[A-Za-z]{2,24})\b"),
             re.compile(r"\b([a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:[a-z]{2}|com|org|net|info|biz|"
                        r"dev|app|cloud|tech|online|site|xyz|shop|store|blog|wiki))\b"))
    _plugin_root = Path(__file__).resolve().parent.parent.parent
    _leaks, _scanned = [], 0
    for _f in sorted(_plugin_root.rglob("*")):
        if not _f.is_file() or "__pycache__" in str(_f) or _f.suffix not in (".py", ".md", ".json"):
            continue
        _scanned += 1
        for _n, _line in enumerate(_f.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
            for _p in _pats:
                for _m in _p.finditer(_line):
                    _host = _m.group(1).lower()
                    if (_host in _real_hosts
                            or _host.rsplit(".", 1)[-1] in _safe_suffix
                            or _host.endswith((".example", ".invalid", ".test"))
                            or _host in ("example.com", "example.org", "example.net")
                            or _host.endswith((".example.com", ".example.org",
                                               ".example.net"))):
                        continue
                    _leaks.append(f"{_f.relative_to(_plugin_root)}:{_n}: {_m.group(1)}")
    # A wrong _plugin_root scans nothing and this check would pass forever. `git ls-files
    # postman` is 9 today; the floor only has to be high enough that zero cannot slip by.
    assert _scanned >= 8, f"the leak check scanned {_scanned} files - _plugin_root is wrong"
    assert not _leaks, (
        "a real-looking domain is about to ship. Use a .example/.invalid host, or add it "
        "to _real_hosts if it is genuine infrastructure:\n  " + "\n  ".join(_leaks[:20])
        + (f"\n  (+{len(_leaks) - 20} more)" if len(_leaks) > 20 else ""))

    # the read path tests ride the same selftest - one command, no framework
    import inbox as inbox_mod
    inbox_mod.selftest()

    print("selftest: OK")


def main(argv=None):
    argv = sys.argv[1:] if argv is None else argv
    # 'inbox' is a subcommand, not a flag: the file-less read mode takes its identity
    # positionally (the contract this replaced) and its options belong to the read path
    if argv[:1] == ["inbox"]:
        import inbox
        return inbox.inbox_main(argv[1:])
    if argv[:1] == ["search"]:
        import inbox
        return inbox.search_main(argv[1:])
    ap = argparse.ArgumentParser(
        description=__doc__,
        epilog="subcommands, each with its own -h: 'inbox IDENTITY' reads a mailbox "
               "window, 'search IDENTITY QUERY' runs a Gmail search server-side and "
               "prints the hits with their URLs.")
    ap.add_argument("--selftest", action="store_true",
                    help="run the built-in checks and exit")
    ap.add_argument("--verify", metavar="BATCH",
                    help="run layers 1 and 2 and print the table, send nothing")
    ap.add_argument("--test", metavar="BATCH",
                    help="send the FIRST email in the batch to the test address, "
                         "subject prefixed [TEST]")
    # mutually exclusive: `batch = args.draft or args.send` would otherwise pick the
    # draft batch and then take the send branch, so --send anywhere in argv silently
    # overrode an explicit --draft and put real mail on the wire.
    mode = ap.add_mutually_exclusive_group()
    mode.add_argument("--draft", metavar="BATCH",
                      help="create every email as a draft (use this unless told to send)")
    mode.add_argument("--send", metavar="BATCH",
                      help="SEND the batch. Only after the human explicitly says send.")
    ap.add_argument("--bounces", nargs=2, metavar=("IDENTITY", "DAYS"),
                    help="layer 4: report bounces from the last N days for an identity")
    ap.add_argument("--drafts", nargs="+", metavar=("IDENTITY", "MATCH"),
                    help="list drafts for IDENTITY, optionally filtered by a substring "
                         "MATCH against the To and Subject headers. Read-only unless "
                         "--purge is given.")
    ap.add_argument("--purge", action="store_true",
                    help="with --drafts: move the listed drafts to Trash, recoverable "
                         "for 30 days. Refused without --drafts.")
    ap.add_argument("--hunter", nargs="+", metavar="ADDRESS",
                    help="layer 3: verify these addresses. Spends one credit each. "
                         "Only for addresses that failed layer 2, and only after asking.")
    ap.add_argument("--as", dest="as_identity", metavar="NAME",
                    help="override the batch file's Identity: line")
    args = ap.parse_args(argv)
    if args.purge and not args.drafts:
        raise SystemExit("--purge only applies to --drafts. On its own it names no "
                         "mailbox and no filter, so nothing was touched.")
    if args.drafts:
        if len(args.drafts) > 2:
            raise SystemExit(
                f"--drafts takes IDENTITY and at most one MATCH, got {len(args.drafts)}: "
                f"{args.drafts!r}. Quote a MATCH that contains spaces.")
        ident = resolve_identity(args.drafts[0], None)
        match = args.drafts[1] if len(args.drafts) == 2 else None
        print(f"reading as: {ident['sender']}  (identity: {ident['name']})")
        rows = sweep_drafts(gmail_password(ident), ident["sender"],
                            match=match, purge=args.purge)
        for uid, hdr in rows:
            print(f"  {uid:<8} {hdr}")
        scope = f"matching {match!r}" if match else "in the mailbox (no filter given)"
        if args.purge:
            print(f"{len(rows)} draft(s) {scope} moved to Trash, recoverable for 30 days.")
        else:
            print(f"{len(rows)} draft(s) {scope}. Nothing was changed. "
                  f"Add --purge to move them to Trash.")
        return 0
    if args.hunter:
        key = hunter_key()
        print(f"This spends {len(args.hunter)} Hunter credit(s) of the 50/month free "
              f"allowance.")
        for addr in args.hunter:
            d = hunter_verify(addr, key)
            print(f"{addr:<40} {d['status']:<12} score={d['score']:<4} "
                  f"result={d['result']} smtp_check={d['smtp_check']}")
        return 0
    if args.verify:
        ident_name, _, recs = parse_batch(Path(args.verify).read_text(encoding="utf-8"))
        ident = resolve_identity(args.as_identity, ident_name)
        print(f"sending as: {ident['sender']}  (identity: {ident['name']})")
        print_table(verify(recs))
        # --verify is the pre-flight, so a missing or oversized attachment is exactly
        # what it is for: found here, nothing was going to send anyway
        check_attachments(recs, Path(args.verify).parent)
        return 0
    if args.test:
        ident_name, _, recs = parse_batch(Path(args.test).read_text(encoding="utf-8"))
        ident = resolve_identity(args.as_identity, ident_name)
        print(f"sending as: {ident['sender']}  (identity: {ident['name']})")
        check_attachments(recs, Path(args.test).parent)
        dest = test_to(ident)
        msg = build_message(recs[0], ident, to=dest, subject_prefix="[TEST] ",
                            base_dir=Path(args.test).parent)
        smtp_send(msg, gmail_password(ident))
        print(f"sent {msg['Subject']!r} to {dest}")
        return 0
    # is not None, not truthiness: --bounces 0 means "today only", not "no sweep"
    if args.bounces is not None:
        # the identity is the positional, never a default: a mode that reads a mailbox
        # must say which one, or a forgotten flag reads back "no bounces" for a mailbox
        # nobody looked at
        if args.as_identity:
            # loud, not ignored, for the same reason
            raise SystemExit(
                "--bounces names its identity as the first positional: "
                "--bounces <identity> <days>. --as does not apply to it.")
        ident = resolve_identity(args.bounces[0], None)
        if not args.bounces[1].isdecimal():
            # an argument swap ('--bounces 3 work') otherwise dies in int() as a
            # traceback, and a negative sweeps from a future date and reads back clean
            raise SystemExit(
                f"--bounces DAYS must be a whole number of days back, got "
                f"{args.bounces[1]!r}. Order is --bounces <identity> <days>.")
        # same wording as the sending modes: the point is which account is on the wire
        print(f"sending as: {ident['sender']}  (identity: {ident['name']})")
        since = date.today() - timedelta(days=int(args.bounces[1]))
        hits = bounce_sweep(gmail_password(ident), since, ident["sender"])
        for h in hits:
            print(h)
        # zero bounces used to print nothing at all, which is the same output as a sweep
        # that silently matched nothing for the wrong reason. Layer 4 is the last gate on
        # a batch that has already left, so "I cannot tell whether this ran" is the one
        # thing it must not say (issue 2026-08-13).
        print(f"{len(hits)} bounce(s) in {ALL_MAIL} since "
              f"{since.strftime('%d-%b-%Y')} for {ident['sender']}")
        return 0
    batch = args.draft or args.send
    if batch:
        ident_name, _, recs = parse_batch(Path(batch).read_text(encoding="utf-8"))
        ident = resolve_identity(args.as_identity, ident_name)
        print(f"sending as: {ident['sender']}  (identity: {ident['name']})")
        # a stamped block is a send that already happened. A batch that died at recipient
        # 7 is re-run to completion, not sent to 1 through 6 twice.
        pending = [r for r in recs if not r["sent"]]
        skipped, sent = len(recs) - len(pending), 0
        if not pending:
            # no login, no session: every block is stamped, so there is nothing to do
            print(f"\n{len(recs)} parsed | {skipped} skipped | 0 built | 0 sent | 0 failed")
            return 0
        # the gates run over `pending`, not every block, for the same reason: nothing about
        # a block that has already left the mailbox is still a decision. Gating all of them
        # means a Source: that has since crossed the 30 day window, or an attachment
        # renamed after it went out, blocks the resume of the recipients who have NOT been
        # sent to. --verify and --test still gate the whole file, which is their point.
        gate_or_die(pending)
        check_attachments(pending, Path(batch).parent)
        pw = gmail_password(ident)
        with contextlib.ExitStack() as stack:
            conn = stack.enter_context(smtp_session(pw, ident["sender"]) if args.send
                                      else imap_session(pw, ident["sender"]))
            # A --send batch of replies needs IMAP too, to read the Message-IDs it is
            # threading onto. --draft is already on IMAP, so it reuses that one session.
            imap = conn if not args.send else stack.enter_context(
                imap_session(pw, ident["sender"]))
            # a reply that will not thread is a hard block BEFORE anything goes out, so
            # every thread is resolved first and the batch either sends whole or not at
            # all. On 11 Aug the post-hoc warning put 9 of 11 into new conversations,
            # which is too late to be a decision.
            plan = []
            for rec in pending:
                irt, refs = thread_headers(imap, rec) if (imap and is_reply(rec)) \
                    else (None, None)
                if is_reply(rec) and not irt:
                    raise SystemExit(
                        f"HOLD: no thread found for {rec['slug']} - it would start a new "
                        f"conversation. Nothing further has been sent.")
                plan.append((rec, irt, refs))
            for rec, irt, refs in plan:
                msg = build_message(rec, ident, in_reply_to=irt, references=refs,
                                    base_dir=Path(batch).parent)
                mark = "  [thread]" if irt else ""
                if args.send:
                    smtp_send(msg, pw, conn=conn)
                    # stamped before the next send, not after the loop: the window a
                    # crash can land in is one recipient wide either way, and only this
                    # order makes that window "not stamped" rather than "sent twice"
                    stamp_block(Path(batch), rec["slug"],
                                datetime.now().strftime("%Y-%m-%d %H:%M"))
                    sent += 1
                    print(f"sent  {rec['slug']:<12} {rec['to']}{mark}", flush=True)
                else:
                    # --draft never stamps: a duplicate Gmail draft is visible and
                    # harmless, a silent double-send is not
                    append_draft(msg, pw, conn=conn)
                    print(f"draft {rec['slug']:<12} {rec['to']}{mark}", flush=True)
        print(f"\n{len(recs)} parsed | {skipped} skipped | {len(pending)} built | "
              f"{sent} sent | 0 failed")
        if args.send:
            print(f"Run --bounces {ident['name']} 1 in 30 minutes for layer 4.")
        return 0
    if args.selftest:
        selftest()
        return 0
    ap.error("no mode given")


if __name__ == "__main__":
    sys.exit(main())
