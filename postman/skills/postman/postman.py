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
from concurrent.futures import ThreadPoolExecutor
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
        if "imap_host" in d and not (isinstance(d["imap_host"], str)
                                     and d["imap_host"].strip()):
            raise SystemExit(f"{path}: identity {name!r} has an empty imap_host. "
                             f"Remove it to use {IMAP_HOST}.")
        if "smtp_host" in d and not (isinstance(d["smtp_host"], str)
                                     and d["smtp_host"].strip()):
            raise SystemExit(f"{path}: identity {name!r} has an empty smtp_host. "
                             f"Remove it to use {SMTP_HOST}.")
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
HEADER_RE = re.compile(
    r"^(To|Cc|Source|Third-party|Subject|Attach|Sent|Attempting):\s*(.+)$")

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
           "to": m.group("addr"), "cc": None, "third_party": None, "sent": None,
           "attempting": None}
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


# Seconds one DNS lookup may take across every nameserver, per attempt. Set, not left to
# dnspython's default, so a dead resolver cannot stall the gate for longer than this (#51).
MX_LIFETIME = 5


def _dns(resolve, domain, rdtype):
    """One lookup, retried once on the two failures that are about the resolver rather
    than the domain: a timeout, and every nameserver failing (SERVFAIL, REFUSED)."""
    import dns.exception
    import dns.resolver
    try:
        return resolve(domain, rdtype, lifetime=MX_LIFETIME)
    except (dns.exception.Timeout, dns.resolver.NoNameservers):
        return resolve(domain, rdtype, lifetime=MX_LIFETIME)


def has_mx(domain, resolve=None):
    """Layer 1. True when the domain takes mail, False when DNS says it does not, None
    when DNS could not say. None blocks like False and is reported apart from it,
    because a resolver timeout is not a fact about the domain.

    No MX record means the A record is the mail host (RFC 5321 5.1). An MX of "." is a
    null MX and means the domain takes no mail at all (RFC 7505).
    """
    try:
        import dns.exception
        import dns.resolver
    except ImportError:
        raise SystemExit("dnspython is not installed, so no MX check can run. "
                         "pip install -r requirements.txt") from None
    resolve = resolve or dns.resolver.resolve
    try:
        try:
            return any(str(r.exchange) != "." for r in _dns(resolve, domain, "MX"))
        except dns.resolver.NoAnswer:
            return bool(_dns(resolve, domain, "A"))
    except (dns.resolver.NXDOMAIN, dns.resolver.NoAnswer):
        return False
    except (dns.exception.DNSException, OSError):
        return None


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
        # a reply carries no Source: by rule, so the source columns come from the thread
        m = SOURCE_RE.match(rec.get("source") or "")
        rows.append({
            "slug": rec["slug"], "to": rec["to"],
            "host": source_host(m.group("url")) if m else "(thread)",
            "read": m.group("date") if m else "",
            "layer2": layer2, "reason": reason,
        })
    # after the gates, so a refused batch costs no DNS. One lookup per domain, all of
    # them at once: ten recipients at one venue group are one query, and the batch waits
    # for its slowest domain rather than the sum of them.
    domains = sorted({row["to"].rsplit("@", 1)[-1].lower() for row in rows})
    with ThreadPoolExecutor(max_workers=max(1, min(8, len(domains)))) as pool:
        mx = dict(zip(domains, pool.map(lambda d: has_mx(d), domains)))
    for row in rows:
        row["mx"] = mx[row["to"].rsplit("@", 1)[-1].lower()]
    return rows


MX_LABEL = {True: "MX", False: "NO-MX", None: "UNKNOWN"}


def print_table(rows):
    """The human gate. One row per recipient, nothing rounded up to a tick."""
    w = max((len(r["slug"]) for r in rows), default=4)
    for r in rows:
        mx = MX_LABEL[r["mx"]]
        print(f"{r['slug']:<{w}}  {r['to']:<38} {mx:<7} {r['layer2']:<9} {r['reason']}")
    bad = [r for r in rows if not r["mx"] or r["layer2"] not in CLEARED]
    print(f"\n{len(rows)} recipient(s), {len(bad)} needing attention.")
    unknown = {r["to"].rsplit("@", 1)[-1].lower() for r in rows if r["mx"] is None}
    if unknown:
        print(f"{len(unknown)} domain(s) did not answer DNS (timeout or server failure): "
              f"{', '.join(sorted(unknown))}. They block like NO-MX. Re-run when DNS "
              f"answers.")
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


def smtp_send(msg, password, conn=None, host=None):
    """Send one message. Pass conn to reuse an open session across a batch. host is the
    identity's smtp_host, None for Gmail, and only used when conn is None.

    Returns the recipients the server refused while it took the message for the rest,
    as smtplib gives them: {address: (code, reply)}. {} means every recipient took it.
    A refusal of every recipient raises SMTPRecipientsRefused instead (#49).
    """
    if conn is None:
        # the login address is the one on the message, so a message built for one
        # identity can never leave over the other identity's authenticated session
        with smtp_session(password, msg["From"], host) as s:
            return smtp_send(msg, password, conn=s)
    # Once DATA is under way the server may hold the whole message, and a connection
    # that drops before its 250 arrives looks exactly like one that dropped before it had
    # anything. smtplib cannot tell them apart, so this marks when DATA began (#48).
    reached, real_data = [], conn.data

    def data(m):
        reached.append(True)
        return real_data(m)
    conn.data = data
    try:
        return conn.send_message(msg) or {}
    except smtplib.SMTPDataError:
        raise                                   # the server answered no: nothing taken
    except Exception as e:
        if reached:
            raise AmbiguousSend(f"{type(e).__name__}: {' '.join(str(e).split())}") from e
        raise
    finally:
        del conn.data


class AmbiguousSend(Exception):
    """The session failed after DATA began, so the server may have accepted the message.
    Never retried: the block is UNKNOWN until Sent Mail says otherwise (#48)."""


def refusal_text(refused):
    """smtplib's {address: (code, reply)} as one line a person can act on."""
    return ", ".join(
        f"{a} ({c} {r.decode('utf-8', 'replace') if isinstance(r, bytes) else r})"
        for a, (c, r) in refused.items())


# Socket timeouts in seconds. Without one a server that accepts and then stalls hangs
# the command forever (#47). A send is never retried on a timeout, because the server
# may already have the message (#48).
IMAP_TIMEOUT = 60
SMTP_TIMEOUT = 30


@contextlib.contextmanager
def read_failed(mode, note):
    """A mailbox read that times out or drops ends in one line, not a traceback.
    Never wrapped around a send: a send that fails this way may still have gone (#48).
    """
    try:
        yield
    except (OSError, imaplib.IMAP4.abort) as e:
        raise SystemExit(f"{mode}: {type(e).__name__}: {e}. {note}") from None


@contextlib.contextmanager
def smtp_session(password, sender, host=None):
    """One authenticated SMTP session for a whole batch. A connect/login per
    recipient is 12 login cycles in a few seconds on the real run, which Gmail
    throttles, and a throttle at recipient 7 leaves 1 to 6 already sent.
    host is the identity's smtp_host, None for Gmail. Always port 587 with STARTTLS.
    """
    s = smtplib.SMTP(host or SMTP_HOST, 587, timeout=SMTP_TIMEOUT)
    try:
        s.starttls(context=ssl.create_default_context())
        s.login(sender, password)
        yield s
    finally:
        # a dead connection raises from QUIT too, and that would replace the error that
        # killed it, which is the one that says whether a send went (#49)
        try:
            s.quit()
        except (OSError, smtplib.SMTPException):
            s.close()


IMAP_HOST = "imap.gmail.com"
SMTP_HOST = "smtp.gmail.com"
# Gmail's English names. The fallback only: a non-English account names these folders in
# its own language, so special_folder asks LIST for the SPECIAL-USE flag first (#52).
DRAFTS = '"[Gmail]/Drafts"'
SENT = '"[Gmail]/Sent Mail"'
ALL_MAIL = '"[Gmail]/All Mail"'
_SPECIAL_USE = {"\\Drafts": DRAFTS, "\\Sent": SENT, "\\All": ALL_MAIL}
# (flags) delimiter name. The delimiter is a quoted char or NIL, the name a quoted string
# or an atom. A name sent as a literal does not match and so falls back.
LIST_RE = re.compile(rb'^\((?P<flags>[^)]*)\) (?:"(?:[^"\\]|\\.)*"|NIL) (?P<name>.+)$')


def special_folder(M, flag):
    """The mailbox LIST marks with SPECIAL-USE `flag` (RFC 6154), else Gmail's English
    name. One LIST per session, kept on the connection. The name goes back to SELECT
    exactly as LIST sent it, quoted and still in modified UTF-7.
    """
    found = getattr(M, "_postman_folders", None)
    if found is None:
        found = {}
        typ, data = M.list()
        for line in (data or []) if typ == "OK" else []:
            m = LIST_RE.match(line) if isinstance(line, bytes) else None
            if not m:
                continue
            name = m.group("name").decode("ascii", "replace")
            name = name if name.startswith('"') else f'"{name}"'
            for f in m.group("flags").decode("ascii", "replace").split():
                found.setdefault(f.lower(), name)       # flags are case-insensitive
        M._postman_folders = found
    return found.get(flag.lower(), _SPECIAL_USE[flag])

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


def _address_headers(M, mailbox, key, addrs):
    """Per address, the headers of the newest SCAN_DEPTH messages in `mailbox` whose
    `key` (FROM or TO) is that address, newest first.

    One SELECT per mailbox, then one SEARCH and ONE FETCH per address. A FETCH per
    message made the not-found path about 96 round trips per recipient (#51). The result
    is kept on the connection per (mailbox, key, address). Every subject reuses it, and
    so does awaiting_reply after thread_headers, which is what preflight runs.

    The subject is deliberately NOT part of the IMAP criteria. A HEADER SUBJECT atom is
    matched against the raw header bytes, so any atom long enough to span a fold can never
    hit (2026-08-11: this silently unthreaded 9 of 11 venue replies). IMAP narrows on the
    address, which never folds, and the subject is decided by the caller on the unfolded
    header.
    """
    cache = M.__dict__.setdefault("_postman_headers", {})
    todo = [a for a in addrs if (mailbox, key, a) not in cache]
    if todo:
        typ, _ = M.select(mailbox, readonly=True)
        for addr in todo:
            cache[(mailbox, key, addr)] = (
                _fetch_headers(M, (key, f'"{addr}"')) if typ == "OK" else [])
    return [cache[(mailbox, key, a)] for a in addrs]


def _fetch_headers(M, criteria):
    """The selected mailbox's newest SCAN_DEPTH matches for criteria, newest first."""
    typ, data = M.search(None, *criteria)
    if typ != "OK":
        return []
    seqs = [s.decode() for s in (data[0] or b"").split()[-SCAN_DEPTH:]]
    if not seqs:
        return []
    typ, d = M.fetch(",".join(seqs),
                     "(BODY.PEEK[HEADER.FIELDS (MESSAGE-ID REFERENCES SUBJECT DATE)])")
    if typ != "OK":
        return []
    # each hit is a (b"<seq> (BODY[...] {n}", header bytes) tuple, in whatever order the
    # server chose, so it is keyed on its own sequence number and not on position
    got = {p[0].split(None, 1)[0].decode(): email.message_from_bytes(p[1])
           for p in (d or []) if isinstance(p, tuple)}
    return [got[s] for s in reversed(seqs) if s in got]


def _newest_date(lists, subj, since, skip_autoreply=False):
    """When the newest message in any of `lists` in thread `subj`, sent since `since`,
    was sent. None when there is none."""
    newest = None
    for hdrs in (h for msgs in lists for h in msgs):
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
        if when >= since and (newest is None or when > newest):
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
    # the lookback is applied to the Date header here rather than as an IMAP SINCE, so
    # this reads the same cached headers thread_headers already fetched
    since = datetime.now(timezone.utc) - timedelta(days=THREAD_LOOKBACK_DAYS)
    addrs = _to_addrs(rec)
    sent, all_mail = special_folder(M, "\\Sent"), special_folder(M, "\\All")
    ours = _newest_date(_address_headers(M, sent, "TO", addrs), subj, since)
    theirs = _newest_date(_address_headers(M, all_mail, "FROM", addrs), subj, since,
                          skip_autoreply=True)
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


def _newest_matching(msgs, subj):
    """Newest (Message-ID, References) in msgs (newest first) in thread subj, else None."""
    for hdrs in msgs:
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
    # Grouped by mailbox, one SELECT each, and the order is unchanged: every address in
    # INBOX, then in ALL_MAIL, then in SENT.
    addrs = _to_addrs(rec)
    for mailbox, key in (("INBOX", "FROM"), (special_folder(M, "\\All"), "FROM"),
                         (special_folder(M, "\\Sent"), "TO")):
        for msgs in _address_headers(M, mailbox, key, addrs):
            hit = _newest_matching(msgs, subj)
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
            f"{r['slug']} ({r['layer2']}, "
            f"{ {True: 'MX', False: 'no MX', None: 'MX unknown'}[r['mx']] })"
            for r in blocked)
        raise SystemExit(
            f"{len(blocked)} recipient(s) did not clear layer 2 or have no MX: "
            f"{named}. Fix the source or ask about --hunter. Nothing was sent.")
    return rows


@contextlib.contextmanager
def imap_session(password, sender, host=None):
    """One authenticated IMAP session, for the same reason as smtp_session. host is the
    identity's imap_host, None for Gmail."""
    M = imaplib.IMAP4_SSL(host or IMAP_HOST, timeout=IMAP_TIMEOUT)
    try:
        M.login(sender, password)
        yield M
    finally:
        # the same as smtp_session: a failed LOGOUT must not mask the original error
        with contextlib.suppress(OSError, imaplib.IMAP4.error):
            M.logout()


def append_draft(msg, password, conn=None):
    """Append one draft. Pass conn to reuse an open session across a batch."""
    if conn is None:
        with imap_session(password, msg["From"]) as M:
            append_draft(msg, password, conn=M)
        return
    # "\\Draft" so the message is a draft by flag, not only by which mailbox it landed in
    typ, _ = conn.append(special_folder(conn, "\\Drafts"), "\\Draft",
                         imaplib.Time2Internaldate(time.time()),
                         msg.as_bytes())
    if typ != "OK":
        raise SystemExit(f"IMAP append failed for {msg['To']}: {typ}")


def draft_exists(M, rec):
    """True when Drafts already holds a draft to rec's first To address with its subject.

    --draft stamps nothing into the batch file, so this is what stops a rerun after a
    failure from making every draft a second time (#49). Matched on the address and the
    unfolded subject, as thread_headers matches, because a draft has no other stable key.
    """
    subj = " ".join(rec["subject"].split())
    drafts = special_folder(M, "\\Drafts")
    return any(header_subject(h) == subj
               for h in _address_headers(M, drafts, "TO", _to_addrs(rec)[:1])[0])


ATTEMPT_RE = re.compile(r"^(\d{4}-\d\d-\d\d \d\d:\d\d)")
# how far before its Attempting: minute a Sent Mail copy still counts, for clock skew
# between this machine and the server that stamped the Date header
ATTEMPT_SKEW = timedelta(minutes=5)


def sent_copy(M, rec):
    """When Sent Mail holds rec as sent since its Attempting: time, else None.

    Matched on the first To address, the unfolded subject and the Date header. Never on
    Message-ID: Gmail replaces the one smtplib sent with its own, so the id we built never
    reaches the mailbox (test/test_threading_live.py). None too when the Attempting: value
    carries no time, because an unknown window cannot clear anything.
    """
    m = ATTEMPT_RE.match(rec.get("attempting") or "")
    if not m:
        return None
    since = datetime.strptime(m.group(1), "%Y-%m-%d %H:%M").astimezone() - ATTEMPT_SKEW
    subj = " ".join(rec["subject"].split())
    for hdrs in _address_headers(M, special_folder(M, "\\Sent"), "TO",
                                 _to_addrs(rec)[:1])[0]:
        if header_subject(hdrs) != subj:
            continue
        try:
            when = email.utils.parsedate_to_datetime(hdrs.get("Date", ""))
        except (TypeError, ValueError):
            continue
        if when.tzinfo is None:                 # a naive Date is read as UTC
            when = when.replace(tzinfo=timezone.utc)
        if when >= since:
            return when.astimezone().strftime("%Y-%m-%d %H:%M")
    return None


def stamp_block(path, slug, when, key="Sent"):
    """Write '<key>: <when>' into one block, as an atomic rewrite of the whole file.

    Written after EACH send, not once at the end: smtp_session's docstring names the
    throttle that leaves 1 to 6 already sent, and batching the writes loses every
    stamp in exactly the crash the stamp exists for.

    An Attempting: line already in the block goes in the same rewrite, so a block moves
    from attempting to sent in one write and is never both or neither. when=None only
    removes it, which is how a send the server definitely refused becomes sendable again.
    """
    with path.open("r", encoding="utf-8", newline="") as source:
        text = source.read()
    out, hit, head = [], False, False
    for line in text.splitlines(keepends=True):
        if head:
            if not line.strip():
                head = False
            elif line.startswith("Attempting:"):
                continue
        out.append(line)
        m = RECIPIENT_RE.match(line.rstrip("\n"))
        if m and m.group("slug") == slug:
            if when is not None:
                out.append(f"{key}: {when}\n")
            hit = head = True
    if not hit:
        raise BatchError(f"stamp: no block named {slug!r} in {path}")
    tmp = path.with_suffix(path.suffix + ".tmp")
    with tmp.open("w", encoding="utf-8", newline="") as dest:
        dest.write("".join(out))
    tmp.replace(path)


def bounce_sweep(password, since, sender, host=None):
    """Layer 4. Bounce senders seen since a date. The only ground truth available.

    All Mail, not INBOX: a bounce that has been archived has left INBOX entirely, and
    this is the last gate on a batch that has already gone out, so a false clean is the
    one answer it must never give. All Mail excludes only Spam and Trash, and no message
    we sent is FROM mailer-daemon, so the wider scope adds no false positives.
    Returns (hits, the folder swept).
    """
    hits = []
    with imap_session(password, sender, host) as M:
        folder = special_folder(M, "\\All")
        typ, _ = M.select(folder, readonly=True)
        if typ != "OK":
            raise SystemExit(f"--bounces: SELECT {folder} failed: {typ}. Nothing was "
                             f"swept, so this is not a clean result.")
        stamp = since.strftime("%d-%b-%Y")
        for who in ("mailer-daemon", "postmaster"):
            typ, data = M.search(None, "SINCE", stamp, "FROM", who)
            if typ != "OK":
                raise SystemExit(f"--bounces: SEARCH FROM {who} failed: {typ}. Nothing "
                                 f"was swept, so this is not a clean result.")
            for uid in (data[0] or b"").split():
                typ, d = M.fetch(uid, "(BODY[HEADER.FIELDS (SUBJECT FROM)])")
                # a bounce that cannot be read is not a bounce that is not there
                if typ != "OK" or not d or not isinstance(d[0], tuple):
                    raise SystemExit(f"--bounces: FETCH {uid.decode()} failed: {typ}. "
                                     f"This is not a clean result.")
                hits.append(d[0][1].decode("utf-8", "replace").strip())
    return hits, folder


def sweep_drafts(password, sender, match=None, purge=False, host=None):
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

    Returns (rows, failed). failed counts the matched drafts still in Drafts after the
    purge, 0 when listing.
    """
    out = []
    with imap_session(password, sender, host) as M:
        drafts = special_folder(M, "\\Drafts")
        typ, _ = M.select(drafts, readonly=not purge)
        if typ != "OK":
            raise SystemExit(f"--drafts: SELECT {drafts} failed: {typ}. Nothing was "
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
        if not (purge and out):
            return out, 0
        # Gmail-specific. +X-GM-LABELS (\Trash) moves it, and the message survives
        # in Trash, so a wrong match costs a restore rather than the draft.
        # The label is ONE backslash and it is parenthesised. "\\\\Trash" in
        # source emits a literal \\Trash and Gmail answers BAD Could not parse
        # command, the same shape of failure as an unquoted multi-address SEARCH.
        # One STORE on the whole matched set, not one per draft.
        M.uid("STORE", ",".join(u for u, _ in out), "+X-GM-LABELS", "(\\Trash)")
        # Its answer is not the count. A NO can come after some moved, so what failed is
        # whatever matched and is still in Drafts. NOOP first, so the server can report
        # what the STORE removed before the SEARCH looks.
        M.noop()
        typ, data = M.uid("SEARCH", "ALL")
        if typ != "OK":
            raise SystemExit(f"--drafts --purge: the STORE ran but the check after it "
                             f"failed: {typ}. Re-run --drafts to see what is left.")
        left = {u.decode() for u in (data[0] or b"").split()}
        return out, sum(1 for u, _ in out if u in left)


HUNTER_URL = "https://api.hunter.io/v2/email-verifier"


def hunter_key():
    key = os.environ.get("POSTMAN_HUNTER_KEY")
    if not key:
        raise SystemExit(
            "POSTMAN_HUNTER_KEY is not set. Export it from wherever you keep it. "
            "Layers 1, 2 and 4 do not need it.")
    return key


class HunterError(Exception):
    """No verdict for one address. Never retried, because each call bills a credit."""


def hunter_verify(address, key):
    """Layer 3, on request only. One credit per call. Never called by a default path.

    accept_all means cannot-be-disproved, not confirmed. Reported verbatim.
    """
    import urllib.error
    import urllib.parse
    import urllib.request
    q = urllib.parse.urlencode({"email": address})
    # the key rides in a header, not the query string, where proxy logs and tracebacks
    # keep every URL they see (#51)
    req = urllib.request.Request(f"{HUNTER_URL}?{q}", headers={"X-API-KEY": key})
    try:
        with urllib.request.urlopen(req, timeout=30) as r:
            if r.status == 202:
                raise HunterError("Hunter still verifying (202), re-run this address, "
                                  "it bills once")
            return json.load(r)["data"]
    except urllib.error.HTTPError as e:
        raise HunterError(f"HTTP {e.code} {e.reason}") from None
    except OSError as e:
        raise HunterError(f"{type(e).__name__}: {e}") from None


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
                      "store": str(Path(td) / "store2"), "html_sig": False,
                      "imap_host": "imap.mail.example",
                      "smtp_host": "smtp.mail.example"},
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
    # #51: layer 1 against a stubbed resolver, so every branch runs and none touches DNS.
    # True takes mail, False provably does not, None could not be told. None blocks the
    # batch like False, and is reported apart from it.
    import dns.exception
    import dns.name
    import dns.resolver
    import threading
    import types

    def _mx(*hosts):
        return [types.SimpleNamespace(exchange=dns.name.from_text(h)) for h in hosts]

    def _resolver(script):
        """script maps rdtype to a list of outcomes, one per call: a list is an answer,
        an exception class is raised. Every call is recorded with its lifetime."""
        calls = []

        def resolve(domain, rdtype, lifetime=None):
            calls.append((domain, rdtype, lifetime))
            got = script[rdtype].pop(0)
            if isinstance(got, type):
                raise got()
            return got
        return resolve, calls

    for _script, _want, _n in (
        ({"MX": [_mx("mx1.b.example")]}, True, 1),
        ({"MX": [_mx(".")]}, False, 1),                       # null MX, RFC 7505
        ({"MX": [dns.resolver.NXDOMAIN]}, False, 1),
        # no MX record: the A record is the mail host (RFC 5321 5.1)
        ({"MX": [dns.resolver.NoAnswer], "A": [["192.0.2.1"]]}, True, 2),
        ({"MX": [dns.resolver.NoAnswer], "A": [dns.resolver.NoAnswer]}, False, 2),
        # the two transient failures are retried once, and only once
        ({"MX": [dns.exception.Timeout, _mx("mx1.b.example")]}, True, 2),
        ({"MX": [dns.resolver.NoNameservers, _mx("mx1.b.example")]}, True, 2),
        ({"MX": [dns.exception.Timeout, dns.exception.Timeout]}, None, 2),
        ({"MX": [dns.resolver.NoNameservers, dns.resolver.NoNameservers]}, None, 2),
        ({"MX": [dns.resolver.NoAnswer], "A": [dns.exception.Timeout,
                                               dns.exception.Timeout]}, None, 3),
    ):
        _res, _calls = _resolver({k: list(v) for k, v in _script.items()})
        _got = has_mx("b.example", resolve=_res)
        assert _got is _want, f"{_script}: got {_got!r}, wanted {_want!r}"
        assert len(_calls) == _n, f"{_script}: {len(_calls)} lookups, wanted {_n}"
        assert all(c[2] == MX_LIFETIME for c in _calls), _calls
    assert MX_LIFETIME == 5, MX_LIFETIME

    # verify: one lookup per domain, all domains at once. The barrier only opens when
    # all three lookups are in flight together, so a serial verify fails it.
    _looked, _gate = [], threading.Barrier(3, timeout=5)

    def _stub_mx(domain):
        _looked.append(domain)
        _gate.wait()
        return {"a.example": True, "b.example": False, "c.example": None}[domain]
    _mx_real, globals()["has_mx"] = globals()["has_mx"], _stub_mx
    try:
        _recs = parse_batch("\n---\n".join(
            f"## @r{i} | P Q <p{i}@{d}>\nSource: {d.lower()}/x, read "
            f"{date.today():%Y-%m-%d}\nSubject: s\n\nHi.\n"
            for i, d in enumerate(["a.example"] * 10 + ["B.example", "c.example"])))[2]
        _rows = verify(_recs)
    finally:
        globals()["has_mx"] = _mx_real
    assert sorted(_looked) == ["a.example", "b.example", "c.example"], _looked
    assert [r["mx"] for r in _rows] == [True] * 10 + [False, None], _rows
    import io
    with contextlib.redirect_stdout(io.StringIO()) as _out:
        print_table(_rows)
    assert "NO-MX" in _out.getvalue() and "UNKNOWN" in _out.getvalue(), _out.getvalue()
    assert "1 domain(s) did not answer DNS" in _out.getvalue(), _out.getvalue()
    # unknown still blocks, and says which it was
    _mx_real, globals()["has_mx"] = globals()["has_mx"], lambda d: {"a.example": True}.get(d)
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            gate_or_die([_recs[0], _recs[11]])
    except SystemExit as e:
        assert "r11 (" in str(e) and "MX unknown" in str(e), str(e)
        assert "r0 (" not in str(e), str(e)
    else:
        raise AssertionError("an unknown MX must block the batch")
    finally:
        globals()["has_mx"] = _mx_real

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

    # #51: Hunter. The key rides in a header, never the URL, where it lands in proxy logs
    # and tracebacks. Each call bills a credit, so nothing is retried, and one address
    # failing no longer ends the loop for the rest. urlopen is stubbed: no HTTP.
    import urllib.error
    import urllib.request
    _sent = []

    class _Resp:
        def __init__(self, status, body):
            self.status, self._body = status, body

        def __enter__(self):
            return self

        def __exit__(self, *exc):
            return False

        def read(self):
            return self._body

    def _fake_open(req, timeout=None):
        _sent.append(req)
        addr = urllib.parse.parse_qs(urllib.parse.urlsplit(req.full_url).query)["email"][0]
        if addr.startswith("slow"):
            return _Resp(202, b"{}")
        if addr.startswith("busy"):
            raise urllib.error.HTTPError(req.full_url, 429, "Too Many Requests", {}, None)
        return _Resp(200, json.dumps({"data": {"status": "valid", "score": 97,
                                               "result": "deliverable",
                                               "smtp_check": True}}).encode())
    import urllib.parse
    _real_open = urllib.request.urlopen
    os.environ["POSTMAN_HUNTER_KEY"] = "k-test-123"
    try:
        urllib.request.urlopen = _fake_open
        with contextlib.redirect_stdout(io.StringIO()) as _out:
            _rc = main(["--hunter", "ok@b.example", "slow@b.example", "busy@b.example",
                        "ok2@b.example"])
    finally:
        urllib.request.urlopen = _real_open
        os.environ.pop("POSTMAN_HUNTER_KEY", None)
    assert len(_sent) == 4, f"{len(_sent)} calls for 4 addresses: nothing retries"
    for _req in _sent:
        assert "k-test-123" not in _req.full_url and "api_key" not in _req.full_url, \
            _req.full_url
        assert _req.get_header("X-api-key") == "k-test-123", _req.header_items()
    _o = _out.getvalue()
    assert "ok2@b.example" in _o and "valid" in _o, _o      # the loop reached the end
    assert "slow@b.example" in _o and "202" in _o, _o
    assert "busy@b.example" in _o and "429" in _o, _o
    assert "k-test-123" not in _o, "the key must never be printed"
    assert _rc == 1, "any address without a verdict makes the run exit 1"

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

        def list(self):
            return "OK", []                     # names nothing: the Gmail fallbacks

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
    # outside THREAD_LOOKBACK_DAYS, our old mail is not something to amend
    assert awaiting_reply(_FakeBox(sent=(24 * 100, _S)), _rec) is None, \
        "a send older than the lookback is not awaiting"
    # an autoresponder is in the thread but is not the venue answering us
    assert awaiting_reply(
        _FakeBox(sent=(26, _S), inbound=(2, "Automatic reply: Dinner for 100")),
        _rec) is not None, "an out-of-office is not a reply"
    # a different thread is a different conversation
    assert awaiting_reply(_FakeBox(sent=(2, _S)),
                          dict(_rec, subject="Other enquiry")) is None, \
        "another thread's send is not this thread's"

    # #52: folders by SPECIAL-USE flag (RFC 6154), not by Gmail's English names. A German
    # account calls All Mail "Alle Nachrichten", and a SELECT on the English name fails
    # there, which read back as "nothing found" or died. One LIST per session.
    assert (DRAFTS, SENT, ALL_MAIL) == ('"[Gmail]/Drafts"', '"[Gmail]/Sent Mail"',
                                        '"[Gmail]/All Mail"'), "the fallbacks moved"

    class _LocalBox:
        """A German Gmail account. LIST names its folders, every command is recorded."""
        LISTING = [b'(\\HasNoChildren) "/" "INBOX"',
                   b'(\\All \\HasNoChildren) "/" "[Gmail]/Alle Nachrichten"',
                   b'(\\Drafts \\HasNoChildren) "/" "[Gmail]/Entw&APw-rfe"',
                   b'(\\HasNoChildren \\Sent) "/" "[Gmail]/Gesendet"',
                   b'(\\HasNoChildren \\Trash) "/" "[Gmail]/Papierkorb"']

        def __init__(self, listing=LISTING, list_typ="OK"):
            self.listing, self.list_typ, self.calls = listing, list_typ, []

        def login(self, user, password):
            self.calls.append(("LOGIN", user))

        def logout(self):
            self.calls.append(("LOGOUT",))

        def noop(self):
            self.calls.append(("NOOP",))
            return "OK", [b""]

        def list(self):
            self.calls.append(("LIST",))
            return self.list_typ, list(self.listing)

        def select(self, mailbox, readonly=False):
            self.calls.append(("SELECT", mailbox))
            return "OK", [b"0"]

        def search(self, charset, *criteria):
            self.calls.append(("SEARCH",) + criteria)
            return "OK", [b""]

        def append(self, mailbox, flags, when, raw):
            self.calls.append(("APPEND", mailbox))
            return "OK", [b""]

    _lb = _LocalBox()
    assert special_folder(_lb, "\\All") == '"[Gmail]/Alle Nachrichten"'
    assert special_folder(_lb, "\\Sent") == '"[Gmail]/Gesendet"'
    # modified UTF-7 goes back to SELECT exactly as LIST sent it, never decoded
    assert special_folder(_lb, "\\Drafts") == '"[Gmail]/Entw&APw-rfe"'
    assert _lb.calls.count(("LIST",)) == 1, f"one LIST per session, got {_lb.calls}"
    # every read path and the draft append use what LIST named, never the English name
    _lb = _LocalBox()
    thread_headers(_lb, {"to": "a@b.example, c@d.example", "subject": "RE: x"})
    awaiting_reply(_lb, {"to": "a@b.example", "subject": "RE: x"})
    append_draft(built, "x", conn=_lb)
    _sel = {c[1] for c in _lb.calls if c[0] in ("SELECT", "APPEND")}
    assert _sel == {"INBOX", '"[Gmail]/Alle Nachrichten"', '"[Gmail]/Gesendet"',
                    '"[Gmail]/Entw&APw-rfe"'}, _sel
    assert _lb.calls.count(("LIST",)) == 1, "the whole session costs one LIST"
    # an unquoted atom and a NIL delimiter are both legal LIST replies
    assert special_folder(_LocalBox([b"(\\Sent) NIL Sent"]), "\\Sent") == '"Sent"'
    # a LIST that marks nothing, or fails, keeps the behaviour before #52
    for _box in (_LocalBox([b'(\\HasNoChildren) "/" "INBOX"']), _LocalBox(list_typ="NO")):
        assert [special_folder(_box, f) for f in ("\\All", "\\Sent", "\\Drafts")] \
            == [ALL_MAIL, SENT, DRAFTS], _box.calls

    # purge is ONE UID STORE on the matched set, and the failure count is what is still
    # in Drafts afterwards, not a constant. Drafts 1 to 3 match, `stuck` never moves.
    class _DraftBox(_LocalBox):
        def __init__(self, stuck=(), store_typ="OK"):
            super().__init__()
            self.left, self.stuck, self.store_typ = {b"1", b"2", b"3"}, set(stuck), store_typ

        def uid(self, cmd, *args):
            self.calls.append((cmd,) + args)
            if cmd == "SEARCH":
                return "OK", [b" ".join(sorted(self.left))]
            if cmd == "FETCH":
                return "OK", [(b"1 (BODY[HEADER]", b"To: v@venue.example\r\n"
                               b"Subject: Dinner " + args[0] + b"\r\n\r\n")]
            assert cmd == "STORE", cmd
            self.left -= {u.encode() for u in args[0].split(",")} - self.stuck
            return self.store_typ, [b""]

    import io
    _real_ssl, _hosts = imaplib.IMAP4_SSL, []

    def _connect(box):
        def ssl(host, **kw):
            _hosts.append(host)
            return box
        return ssl
    try:
        for _stuck, _typ, _failed in (((), "OK", 0), ((b"2",), "OK", 1),
                                      ((b"1", b"2", b"3"), "NO", 3)):
            _db = _DraftBox(_stuck, _typ)
            imaplib.IMAP4_SSL = _connect(_db)
            _rows, _f = sweep_drafts("x", "a@b.example", match="dinner", purge=True)
            assert [u for u, _ in _rows] == ["1", "2", "3"], _rows
            _stores = [c for c in _db.calls if c[0] == "STORE"]
            assert _stores == [("STORE", "1,2,3", "+X-GM-LABELS", "(\\Trash)")], _stores
            assert _f == _failed, f"stuck={_stuck} typ={_typ}: {_f} failed"
            assert ("SELECT", '"[Gmail]/Entw&APw-rfe"') in _db.calls, _db.calls
        # listing only: no STORE, nothing failed
        _db = _DraftBox()
        imaplib.IMAP4_SSL = _connect(_db)
        assert sweep_drafts("x", "a@b.example")[1] == 0
        assert not [c for c in _db.calls if c[0] == "STORE"]
        # through main: the final line carries the real count and the exit is non-zero
        os.environ[pw_env(work)] = "x"
        imaplib.IMAP4_SSL = _connect(_DraftBox((b"3",)))
        with contextlib.redirect_stdout(io.StringIO()) as _out:
            assert main(["--drafts", work["name"], "dinner", "--purge"]) == 1
        assert "2 draft(s) matching 'dinner' moved to Trash" in _out.getvalue(), \
            _out.getvalue()
        assert "1 failed" in _out.getvalue(), _out.getvalue()
        # bounces read the localized All Mail, and the summary names that folder
        imaplib.IMAP4_SSL = _connect(_LocalBox())
        with contextlib.redirect_stdout(io.StringIO()) as _out:
            main(["--bounces", work["name"], "1"])
        assert '0 bounce(s) in "[Gmail]/Alle Nachrichten"' in _out.getvalue(), \
            _out.getvalue()
        # imap_host: absent is Gmail, present is used. "plain" declares one.
        os.environ[pw_env(resolve_identity("plain", None))] = "x"
        del _hosts[:]
        for _name in (work["name"], "plain"):
            imaplib.IMAP4_SSL = _connect(_DraftBox())
            with contextlib.redirect_stdout(io.StringIO()):
                main(["--drafts", _name])
        assert _hosts == ["imap.gmail.com", "imap.mail.example"], _hosts
    finally:
        imaplib.IMAP4_SSL = _real_ssl
        os.environ.pop(pw_env(work), None)
        os.environ.pop(pw_env(resolve_identity("plain", None)), None)
    # an empty host is refused by name, never read as "use the default": a blank field
    # is a config that was meant to say something
    with tempfile.TemporaryDirectory() as td:
        _prev = os.environ["POSTMAN_HOME"]
        os.environ["POSTMAN_HOME"] = td
        try:
            for _extra, _needle in (({"smtp_host": ""}, "smtp_host"),
                                    ({"smtp_host": "  "}, "smtp_host"),
                                    ({"imap_host": ""}, "imap_host")):
                (Path(td) / "identities.json").write_text(json.dumps(
                    {"x": dict({"sender": "a@b.example", "assets": td, "store": td},
                               **_extra)}), encoding="utf-8")
                try:
                    load_identities()
                except SystemExit as e:
                    assert _needle in str(e), str(e)
                else:
                    raise AssertionError(f"{_extra} was accepted")
        finally:
            os.environ["POSTMAN_HOME"] = _prev

    # Task 6: preflight's voice gate must see a planted banned phrase. r.get("body", "")
    # returned "" on every block, so it printed clean on every batch ever run.
    # A real import since #52: preflight.py runs nothing until main(), so importing it
    # reads no argv and logs in to nothing. It imports its own copy of this module (the
    # same quirk as inbox), so the seams are patched on that copy.
    import preflight
    _pm, _opened = preflight.postman, []

    @contextlib.contextmanager
    def _fake_session(password, sender, host=None):
        _opened.append((password, sender, host))
        yield _LocalBox()                       # empty folders: every reply is unthreaded
    _saved_pm = {k: getattr(_pm, k) for k in ("gmail_password", "imap_session", "has_mx")}
    try:
        _pm.gmail_password = lambda ident: "x"
        _pm.imap_session, _pm.has_mx = _fake_session, lambda domain: True
        with tempfile.TemporaryDirectory() as td:
            _bp = Path(td) / "batch.md"
            # the planted phrase: reported by the voice line, then refused by layer 2,
            # which raises before any mailbox is opened
            _bp.write_text(f"## @x | A B <a@b.example>\nSource: b.example/c, read "
                           f"{date.today():%Y-%m-%d}\n"
                           f"Subject: I hope this email finds you well\n\nBody.\n",
                           encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()) as _out:
                try:
                    preflight.main([str(_bp)])
                except _pm.BatchError as e:
                    assert "finds you well" in str(e), str(e)
                else:
                    raise AssertionError("a banned phrase passed preflight's layer 2")
            _voice = _out.getvalue().split("voice\n", 1)[1].splitlines()[0]
            assert "finds you well" in _voice.lower() and "clean" not in _voice, \
                "preflight's voice gate sees nothing - it is passing a key parse_batch " \
                "never sets"
            assert _opened == [], "a batch that fails its gates must not log in"
            # a clean reply with no thread: HOLD and exit 1, over one shared session
            _bp.write_text("## @y | C D <c@d.example>\nSubject: RE: Dinner\n\n"
                           "```quoted\nC D, 1 Sep\nHi.\n```\n\nBody.\n", encoding="utf-8")
            with contextlib.redirect_stdout(io.StringIO()) as _out:
                _rc = preflight.main([str(_bp)])
    finally:
        for _k, _v in _saved_pm.items():
            setattr(_pm, _k, _v)
    _o = _out.getvalue()
    assert _rc == 1 and "HOLD: y would send unthreaded" in _o, _o
    # the shared session helper, with the identity's host, and exactly one session
    assert _opened == [("x", work["sender"], None)], _opened

    # #51: thread lookup round trips. Per mailbox one SELECT, then per address one SEARCH
    # and ONE FETCH for the newest SCAN_DEPTH headers, never one FETCH per message. The
    # headers are kept on the connection per (mailbox, key, address), so awaiting_reply
    # after thread_headers (what preflight does) costs nothing more.
    class _ThreadBox:
        """Mailboxes of (from, to, subject, hours_ago, message_id). Counts commands."""

        def __init__(self, boxes):
            self.boxes, self.box, self.calls = boxes, None, []

        def list(self):
            return "OK", []                     # names nothing: the Gmail fallbacks

        def select(self, mailbox, readonly=False):
            self.calls.append("SELECT")
            self.box = mailbox
            return "OK", [str(len(self.boxes.get(mailbox, []))).encode()]

        def search(self, charset, key, addr):
            self.calls.append("SEARCH")
            col = {"FROM": 0, "TO": 1}[key]
            return "OK", [b" ".join(str(n).encode() for n, m in
                                    enumerate(self.boxes.get(self.box, []), 1)
                                    if f'"{m[col]}"' == addr)]

        def fetch(self, seqs, spec):
            self.calls.append("FETCH")
            out = []
            for s in str(seqs).split(","):
                f, t, subj, ago, mid = self.boxes[self.box][int(s) - 1]
                when = datetime.now(timezone.utc) - timedelta(hours=ago)
                out += [(f"{s} (BODY[HEADER.FIELDS (...)] {{99}}".encode(),
                         (f"From: {f}\r\nTo: {t}\r\nSubject: {subj}\r\n"
                          f"Date: {email.utils.format_datetime(when)}\r\n"
                          f"Message-ID: {mid}\r\n\r\n").encode()), b")"]
            return "OK", out

    _v, _me = "dana.r@venuegroup.example", "ada@example.com"
    # 40 unrelated messages each way in every mailbox: the not-found (HOLD) path. This
    # was 3 x (SELECT + SEARCH + 30 FETCH) = 96 round trips per recipient.
    _noise = [(_v, _me, f"Other {i}", 500 - i, f"<n{i}@v.example>") for i in range(40)]
    _sent_noise = [(_me, _v, f"Other {i}", 500 - i, f"<s{i}@v.example>") for i in range(40)]
    _tb = _ThreadBox({"INBOX": _noise, ALL_MAIL: _noise, SENT: _sent_noise})
    assert thread_headers(_tb, {"to": _v, "subject": _S}) == (None, None)
    assert _tb.calls == ["SELECT", "SEARCH", "FETCH"] * 3, _tb.calls
    # preflight's second pass on the same session is free
    assert awaiting_reply(_tb, {"to": _v, "subject": _S}) is None
    assert len(_tb.calls) == 9, f"awaiting_reply re-read what was cached: {_tb.calls}"
    # two addresses: still one SELECT per mailbox, not one per address
    _w = "sam@venuegroup.example"
    _tb = _ThreadBox({"INBOX": _noise, ALL_MAIL: _noise, SENT: _sent_noise})
    thread_headers(_tb, {"to": f"{_v}, {_w}", "subject": _S})
    assert _tb.calls.count("SELECT") == 3, _tb.calls
    assert _tb.calls.count("SEARCH") == 6 and _tb.calls.count("FETCH") == 3, _tb.calls
    # and the answers are the ones the serial lookup gave: the venue's newest message in
    # the thread, INBOX first, an autoreply skipped, our sent copy only as the fallback
    _thread = _noise + [(_v, _me, "RE: Dinner for 100", 30, "<old@v.example>"),
                        (_v, _me, "RE: Dinner for 100", 5, "<new@v.example>"),
                        (_v, _me, "Automatic reply: Dinner for 100", 1, "<ooo@v.example>")]
    _tb = _ThreadBox({"INBOX": [], ALL_MAIL: _thread,
                      SENT: [(_me, _v, "Dinner for 100", 40, "<ours@a.example>")]})
    assert thread_headers(_tb, {"to": _v, "subject": _S})[0] == "<new@v.example>"
    _tb = _ThreadBox({"INBOX": [], ALL_MAIL: _noise,
                      SENT: [(_me, _v, "Dinner for 100", 40, "<ours@a.example>")]})
    assert thread_headers(_tb, {"to": _v, "subject": _S})[0] == "<ours@a.example>"
    # our send 40h ago, their reply 5h ago: answered. thread_headers stopped at All Mail,
    # so only Sent is read now, and All Mail comes from the cache
    _tb = _ThreadBox({"INBOX": [], ALL_MAIL: _thread,
                      SENT: [(_me, _v, "Dinner for 100", 40, "<ours@a.example>")]})
    thread_headers(_tb, {"to": _v, "subject": _S})
    _n = len(_tb.calls)
    assert awaiting_reply(_tb, {"to": _v, "subject": _S}) is None
    assert _tb.calls[_n:] == ["SELECT", "SEARCH", "FETCH"], _tb.calls

    # #49: the send path against fakes. _FakeSMTP runs smtplib's own send_message and
    # sendmail over scripted replies and opens no socket, so what is tested is how
    # smtplib really reports a refusal, not a guess at it. Nothing here reaches a server.
    class _FakeSMTP(smtplib.SMTP):
        """`refuse` answers 550 to those RCPTs. `quit_error` is raised from quit. `drop`
        cuts the connection at "mail", before the server has anything, or "after-data",
        once it holds the whole message and the 250 is lost. `data_reply` is the answer
        to the message body, `on_data` runs as the server takes it. Every command lands
        in the shared `events` list."""

        def __init__(self, host, events, refuse=(), quit_error=None, drop=None,
                     data_reply=(250, b"ok"), on_data=None):
            super().__init__()                  # no host, so smtplib connects nowhere
            self.events, self.refuse, self.quit_error = events, set(refuse), quit_error
            self.drop, self.data_reply, self.on_data = drop, data_reply, on_data
            events.append(("SMTP", host))

        def starttls(self, context=None):
            return 220, b"ready"

        def login(self, user, password):
            return 235, b"ok"

        def ehlo_or_helo_if_needed(self):
            pass

        def mail(self, sender, options=()):
            if self.drop == "mail":
                raise smtplib.SMTPServerDisconnected("Connection unexpectedly closed")
            return 250, b"ok"

        def rcpt(self, recip, options=()):
            return (550, b"5.1.1 no such user") if recip in self.refuse else (250, b"ok")

        def rset(self):
            return 250, b"ok"

        def data(self, msg):
            self.events.append(("DATA", email.message_from_bytes(msg)["Subject"]))
            if self.on_data:
                self.on_data()
            if self.drop == "after-data":
                raise smtplib.SMTPServerDisconnected("Connection unexpectedly closed")
            return self.data_reply

        def quit(self):
            self.events.append(("QUIT",))
            if self.quit_error:
                raise self.quit_error

        def close(self):
            pass

    class _SendBox(_ThreadBox):
        """_ThreadBox's folders, plus the login, logout and append the send path needs."""

        def __init__(self, boxes, events, logout_error=None):
            super().__init__(boxes)
            self.events, self.logout_error = events, logout_error

        def login(self, user, password):
            self.events.append(("IMAP LOGIN",))

        def logout(self):
            self.events.append(("IMAP LOGOUT",))
            if self.logout_error:
                raise self.logout_error

        def append(self, mailbox, flags, when, raw):
            self.events.append(("APPEND", email.message_from_bytes(raw)["Subject"]))
            return "OK", [b""]

    _real_ssl, _real_smtp, _real_mx = imaplib.IMAP4_SSL, smtplib.SMTP, has_mx
    _pw_saved = {k: os.environ.get(k) for k in (pw_env(work), "POSTMAN_NO_VAULT")}

    def _run(argv, smtp=None, boxes=None, logout_error=None):
        """main(argv) over the fakes: (exit code or SystemExit, stdout, events)."""
        events = []
        box = _SendBox(boxes or {}, events, logout_error)
        imaplib.IMAP4_SSL = lambda host, **kw: box
        smtplib.SMTP = lambda host, port, **kw: _FakeSMTP(host, events, **(smtp or {}))
        with contextlib.redirect_stdout(io.StringIO()) as out:
            try:
                rc = main(argv)
            except (SystemExit, smtplib.SMTPException) as e:
                rc = e
        return rc, out.getvalue(), events

    def _blocks(bp):
        return parse_batch(bp.read_text(encoding="utf-8"))[2]

    _today = f"{date.today():%Y-%m-%d}"
    _two = (f"## @one | A B <a@b.example>\nSource: b.example/c, read {_today}\n"
            f"Cc: c@b.example\nSubject: s1\n\nHi.\n\n---\n"
            f"## @two | C D <c@d.example>\nSource: d.example/c, read {_today}\n"
            f"Subject: s2\n\nHi.\n")
    try:
        globals()["has_mx"] = lambda domain: True
        os.environ[pw_env(work)], os.environ["POSTMAN_NO_VAULT"] = "x", "1"
        with tempfile.TemporaryDirectory() as td:
            bp = Path(td) / "batch.md"
            # a clean batch: both sent and stamped, and the IMAP session that resolved the
            # threads is closed before the SMTP one opens, not held idle for the batch
            bp.write_text(_two, encoding="utf-8")
            rc, out, ev = _run(["--send", str(bp)])
            assert rc == 0, (rc, out)
            assert [e[1] for e in ev if e[0] == "DATA"] == ["s1", "s2"], ev
            assert ev.index(("IMAP LOGOUT",)) < ev.index(("SMTP", "smtp.gmail.com")), ev
            assert all(r["sent"] for r in parse_batch(bp.read_text(encoding="utf-8"))[2])
            assert "2 sent | 0 failed" in out, out
            # a partly refused list: the Cc bounced at RCPT, To took it. The block is
            # stamped (a rerun would send To a second copy) but not as clean, the refused
            # address is named, and the batch stops before block two
            bp.write_text(_two, encoding="utf-8")
            rc, out, ev = _run(["--send", str(bp)], smtp={"refuse": ["c@b.example"]})
            assert rc == 1 and "0 sent | 1 failed" in out, (rc, out)
            assert "PARTIAL: one" in out and "c@b.example (550" in out, out
            assert [e[1] for e in ev if e[0] == "DATA"] == ["s1"], ev
            _r = parse_batch(bp.read_text(encoding="utf-8"))[2]
            assert "refused c@b.example" in (_r[0]["sent"] or ""), _r[0]["sent"]
            assert _r[0]["attempting"] is None, "the stamp replaces the Attempting: line"
            assert _r[1]["sent"] is None, "block two must not have been sent"
            # the rerun resumes at block two and does not send block one again
            rc, out, ev = _run(["--send", str(bp)])
            assert rc == 0 and [e[1] for e in ev if e[0] == "DATA"] == ["s2"], (rc, ev)
            # quit raising on a dead connection after a clean batch changes nothing
            bp.write_text(_two, encoding="utf-8")
            rc, out, ev = _run(["--send", str(bp)], smtp={
                "quit_error": smtplib.SMTPServerDisconnected("gone")},
                logout_error=imaplib.IMAP4.abort("gone"))
            assert rc == 0, (rc, out)
            # a drafts resume: s1 is already in Drafts from the run that died, so the
            # rerun makes s2 only. A draft to someone else with that subject is not it.
            bp.write_text(_two, encoding="utf-8")
            _me = work["sender"]
            rc, out, ev = _run(["--draft", str(bp)], boxes={DRAFTS: [
                (_me, "a@b.example", "s1", 1, "<d1@a.example>"),
                (_me, "z@b.example", "s2", 1, "<d2@a.example>")]})
            assert rc == 0, (rc, out)
            assert [e[1] for e in ev if e[0] == "APPEND"] == ["s2"], ev
            assert "already in Drafts" in out, out
            # #48: an ambiguous send holds the batch and is never sent twice. The server
            # took block one and the connection dropped before its 250: UNKNOWN, stop.
            bp.write_text(_two, encoding="utf-8")
            rc, out, ev = _run(["--send", str(bp)], smtp={"drop": "after-data"})
            assert rc == 1 and "UNKNOWN: one" in out and "0 sent | 1 failed" in out, out
            assert [e[1] for e in ev if e[0] == "DATA"] == ["s1"], ev
            _r = _blocks(bp)
            assert _r[0]["sent"] is None and "UNKNOWN" in (_r[0]["attempting"] or ""), _r[0]
            assert _r[1]["sent"] is None and _r[1]["attempting"] is None, _r[1]
            # the rerun refuses: Sent Mail has no copy, so nothing sends at all, not even
            # block two, and no SMTP session opens. An older mail with that subject to
            # that address is from before the attempt and does not count.
            _old = {SENT: [(_me, "a@b.example", "s1", 48, "<old@a.example>")]}
            rc, out, ev = _run(["--send", str(bp)], boxes=_old)
            assert isinstance(rc, SystemExit) and str(rc).startswith("UNKNOWN: one"), rc
            assert "Sent Mail" in str(rc) and "Nothing was sent" in str(rc), str(rc)
            assert not [e for e in ev if e[0] in ("SMTP", "DATA")], ev
            # Sent Mail holds it, by recipient, subject and time and not by Message-ID
            # (Gmail rewrites that): the block is stamped sent and the batch goes on
            _found = {SENT: [(_me, "a@b.example", "s1", 0, "<gmail-rewrote@a.example>")]}
            rc, out, ev = _run(["--send", str(bp)], boxes=_found)
            assert rc == 0, (rc, out)
            assert [e[1] for e in ev if e[0] == "DATA"] == ["s2"], ev
            _r = _blocks(bp)
            assert "Sent Mail" in (_r[0]["sent"] or "") and _r[0]["attempting"] is None, _r[0]
            assert "found one in Sent Mail" in out, out
            # dropped before the server had anything: not ambiguous, the error surfaces
            # as itself, the Attempting: line is cleared, and the rerun sends both
            bp.write_text(_two, encoding="utf-8")
            rc, out, ev = _run(["--send", str(bp)], smtp={"drop": "mail"})
            assert rc == 1 and "FAILED: one" in out and "SMTPServerDisconnected" in out, out
            assert "0 sent | 1 failed" in out, out
            assert not [e for e in ev if e[0] == "DATA"], ev
            assert [(r["sent"], r["attempting"]) for r in _blocks(bp)] == [(None, None)] * 2
            rc, out, ev = _run(["--send", str(bp)])
            assert rc == 0 and [e[1] for e in ev if e[0] == "DATA"] == ["s1", "s2"], ev
            # the server answered the body with a refusal: not accepted, so not UNKNOWN
            bp.write_text(_two, encoding="utf-8")
            rc, out, ev = _run(["--send", str(bp)],
                               smtp={"data_reply": (554, b"5.7.1 rejected")})
            assert rc == 1 and "FAILED: one" in out and "SMTPDataError" in out, out
            assert [(r["sent"], r["attempting"]) for r in _blocks(bp)] == [(None, None)] * 2
            # sent, then the Sent: stamp cannot be written (an editor holding the file):
            # the Attempting: line stays, so the block is UNKNOWN, never sendable again
            bp.write_text(_two, encoding="utf-8")
            _tmp = bp.with_suffix(".md.tmp")
            rc, out, ev = _run(["--send", str(bp)], smtp={"on_data": _tmp.mkdir})
            assert rc == 1 and "UNKNOWN: one" in out and "1 failed" in out, out
            assert "was sent" in out and "stamp" in out, out
            _tmp.rmdir()
            _r = _blocks(bp)
            assert _r[0]["sent"] is None and _r[0]["attempting"], _r[0]
            rc, out, ev = _run(["--send", str(bp)])
            assert isinstance(rc, SystemExit) and str(rc).startswith("UNKNOWN: one"), rc
            assert not [e for e in ev if e[0] == "DATA"], ev
            # smtp_host: absent dials Gmail (asserted on the clean batch above), present
            # dials the declared host, for --send and for --test alike
            os.environ[pw_env(resolve_identity("plain", None))] = "x"
            bp.write_text(_two, encoding="utf-8")
            rc, out, ev = _run(["--send", str(bp), "--as", "plain"])
            assert rc == 0 and ("SMTP", "smtp.mail.example") in ev, (rc, ev)
            os.environ["POSTMAN_TEST_TO"] = "ada+test@example.com"
            try:
                for _as, _host in (("branded", "smtp.gmail.com"),
                                   ("plain", "smtp.mail.example")):
                    rc, out, ev = _run(["--test", str(bp), "--as", _as])
                    _dialled = [e for e in ev if e[0] == "SMTP"]
                    assert rc == 0 and _dialled == [("SMTP", _host)], (_as, rc, ev)
            finally:
                os.environ.pop("POSTMAN_TEST_TO", None)
                os.environ.pop(pw_env(resolve_identity("plain", None)), None)
        # cleanup never masks the error that killed the session
        for _cm, _kw in ((smtp_session, {}), (imap_session, {})):
            _ev = []
            smtplib.SMTP = lambda host, port, **kw: _FakeSMTP(
                host, _ev, quit_error=smtplib.SMTPServerDisconnected("quit"))
            imaplib.IMAP4_SSL = lambda host, **kw: _SendBox(
                {}, _ev, logout_error=imaplib.IMAP4.abort("logout"))
            try:
                with _cm("x", work["sender"]):
                    raise ValueError("the original")
            except ValueError as e:
                assert str(e) == "the original", e
            else:
                raise AssertionError(f"{_cm.__name__} swallowed the original error")
        # a FETCH that fails in the bounce sweep is not a clean result, and not a TypeError
        class _BadFetch(_LocalBox):
            def search(self, charset, *criteria):
                return "OK", [b"7"]

            def fetch(self, uid, spec):
                return "NO", [None]
        imaplib.IMAP4_SSL = lambda host, **kw: _BadFetch()
        try:
            bounce_sweep("x", date.today(), work["sender"])
        except SystemExit as e:
            assert "FETCH" in str(e) and "not a clean result" in str(e), str(e)
        else:
            raise AssertionError("a failed bounce FETCH read back as clean")
    finally:
        imaplib.IMAP4_SSL, smtplib.SMTP = _real_ssl, _real_smtp
        globals()["has_mx"] = _real_mx
        for _k, _v in _pw_saved.items():
            if _v is None:
                os.environ.pop(_k, None)
            else:
                os.environ[_k] = _v

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

    # #47: a server that accepts the connection and then says nothing must end in a
    # timeout error, not a hang. The real imaplib and smtplib classes run against a local
    # socket that accepts and never answers. Only the host is redirected, so the timeout
    # under test is the one the code passes. Timeouts drop to 1 s for the run, on both
    # copies of this module (inbox imports its own), and are pinned by value after.
    import contextlib as _cl
    import io
    import socket
    import threading
    import inbox as _inbox
    _srv = socket.create_server(("127.0.0.1", 0))
    _held = []

    def _stall():
        # hold every accepted socket open so the client waits on a reply that never comes
        while True:
            try:
                _held.append(_srv.accept()[0])
            except OSError:
                return
    threading.Thread(target=_stall, daemon=True).start()
    _port = _srv.getsockname()[1]
    _real_imap, _real_smtp = imaplib.IMAP4_SSL, smtplib.SMTP
    _boxes = [globals(), vars(_inbox.postman)]
    _saved = [(b, b.get("IMAP_TIMEOUT"), b.get("SMTP_TIMEOUT")) for b in _boxes]
    _pw_key = pw_env(work)
    _env = {k: os.environ.get(k) for k in (_pw_key, "POSTMAN_NO_VAULT")}

    def _timed(fn):
        t0 = time.monotonic()
        try:
            fn()
        except (OSError, imaplib.IMAP4.abort, SystemExit) as e:
            took = time.monotonic() - t0
            assert took < 10, f"{took:.1f} s against a 1 s timeout"
            return e
        raise AssertionError("a stalled server did not raise")
    try:
        imaplib.IMAP4_SSL = lambda host, **kw: _real_imap("127.0.0.1", _port, **kw)
        smtplib.SMTP = lambda host, port, **kw: _real_smtp("127.0.0.1", _port, **kw)
        for b in _boxes:
            b["IMAP_TIMEOUT"], b["SMTP_TIMEOUT"] = 1, 1
        # a dummy credential, and no vault: nothing here may reach a real login
        os.environ[_pw_key], os.environ["POSTMAN_NO_VAULT"] = "x", "1"
        # the send path is not caught and not retried: it raises the raw error (#48)
        e = _timed(lambda: smtp_session("x", work["sender"]).__enter__())
        assert isinstance(e, smtplib.SMTPServerDisconnected), repr(e)
        assert "timed out" in str(e), str(e)
        e = _timed(lambda: imap_session("x", work["sender"]).__enter__())
        assert isinstance(e, OSError) and "timed out" in str(e), repr(e)
        # the three read modes end in one line that names the mode
        e = _timed(lambda: main(["--bounces", work["name"], "1"]))
        assert isinstance(e, SystemExit), repr(e)
        assert str(e).startswith("--bounces:") and "timed out" in str(e), str(e)
        assert "not a clean result" in str(e) and "\n" not in str(e), str(e)
        e = _timed(lambda: main(["--drafts", work["name"]]))
        assert isinstance(e, SystemExit), repr(e)
        assert str(e).startswith("--drafts:") and "timed out" in str(e), str(e)
        with tempfile.TemporaryDirectory() as td:
            bp = Path(td) / "batch.md"
            bp.write_text(f"## @one | A B <a@b.example>\nSource: b.example/c, read "
                          f"{date.today():%Y-%m-%d}\nSubject: s1\n\nHi.\n", encoding="utf-8")
            _real_mx, globals()["has_mx"] = globals()["has_mx"], lambda domain: True
            try:
                e = _timed(lambda: main(["--draft", str(bp)]))
            finally:
                globals()["has_mx"] = _real_mx
        assert isinstance(e, SystemExit), repr(e)
        assert str(e).startswith("--draft:") and "timed out" in str(e), str(e)
        # inbox already caught OSError. This proves a timeout reaches that catch.
        t0 = time.monotonic()
        with _cl.redirect_stderr(io.StringIO()) as err:
            assert _inbox.inbox_main([work["name"]]) == 1
        assert time.monotonic() - t0 < 10, "inbox took too long against a 1 s timeout"
        assert "timed out" in err.getvalue(), err.getvalue()
    finally:
        imaplib.IMAP4_SSL, smtplib.SMTP = _real_imap, _real_smtp
        for b, imap_t, smtp_t in _saved:
            b["IMAP_TIMEOUT"], b["SMTP_TIMEOUT"] = imap_t, smtp_t
        for k, v in _env.items():
            if v is None:
                os.environ.pop(k, None)
            else:
                os.environ[k] = v
        _srv.close()
        for c in _held:
            c.close()
    assert (IMAP_TIMEOUT, SMTP_TIMEOUT) == (60, 30), (IMAP_TIMEOUT, SMTP_TIMEOUT)
    assert (_inbox.postman.IMAP_TIMEOUT, _inbox.postman.SMTP_TIMEOUT) == (60, 30)

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
        note = ("Some drafts may already be in Trash. Rerun --drafts to see what is left."
                if args.purge else "Nothing was changed.")
        with read_failed("--drafts", note):
            rows, failed = sweep_drafts(gmail_password(ident), ident["sender"],
                                        match=match, purge=args.purge,
                                        host=ident.get("imap_host"))
        for uid, hdr in rows:
            print(f"  {uid:<8} {hdr}")
        scope = f"matching {match!r}" if match else "in the mailbox (no filter given)"
        if args.purge:
            print(f"{len(rows) - failed} draft(s) {scope} moved to Trash, recoverable for "
                  f"30 days. {failed} failed"
                  + (". Rerun --drafts to see what is left." if failed else "."))
            return 1 if failed else 0
        else:
            print(f"{len(rows)} draft(s) {scope}. Nothing was changed. "
                  f"Add --purge to move them to Trash.")
        return 0
    if args.hunter:
        key = hunter_key()
        print(f"This spends {len(args.hunter)} Hunter credit(s) of the 50/month free "
              f"allowance.")
        failed = 0
        for addr in args.hunter:
            # one address without a verdict is reported and the loop goes on. Nothing is
            # retried: each call bills a credit whether or not an answer comes back.
            try:
                d = hunter_verify(addr, key)
            except HunterError as e:
                failed += 1
                print(f"{addr:<40} no verdict: {e}", flush=True)
                continue
            print(f"{addr:<40} {d['status']:<12} score={d['score']:<4} "
                  f"result={d['result']} smtp_check={d['smtp_check']}", flush=True)
        if failed:
            print(f"{failed} of {len(args.hunter)} address(es) got no verdict. Nothing "
                  f"was retried.")
        return 1 if failed else 0
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
        smtp_send(msg, gmail_password(ident), host=ident.get("smtp_host"))
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
        with read_failed("--bounces", "Nothing was swept, so this is not a clean result."):
            hits, folder = bounce_sweep(gmail_password(ident), since, ident["sender"],
                                        host=ident.get("imap_host"))
        for h in hits:
            print(h)
        # zero bounces used to print nothing at all, which is the same output as a sweep
        # that silently matched nothing for the wrong reason. Layer 4 is the last gate on
        # a batch that has already left, so "I cannot tell whether this ran" is the one
        # thing it must not say (issue 2026-08-13).
        print(f"{len(hits)} bounce(s) in {folder} since "
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
        # One IMAP session resolves every thread, and in --draft makes the drafts. It is
        # closed before the SMTP session opens, not held idle for the whole batch (#49).
        with contextlib.ExitStack() as stack:
            # entered first so it exits last, after imap_session has closed
            stack.enter_context(
                read_failed("--send", "Nothing was sent.") if args.send else
                read_failed("--draft", "Drafts listed above were made. A rerun skips "
                                       "any draft that is already in Drafts."))
            imap = stack.enter_context(
                imap_session(pw, ident["sender"], ident.get("imap_host")))
            # An Attempting: line with no Sent: is a send whose outcome was never
            # recorded: the connection dropped after DATA, the stamp failed, or the process
            # died. It may have gone, so it is never simply sent again. Sent Mail decides,
            # over this session, before anything sends (#48).
            for rec in [r for r in pending if r["attempting"]] if args.send else ():
                found = sent_copy(imap, rec)
                if not found:
                    raise SystemExit(
                        f"UNKNOWN: {rec['slug']} was attempted at {rec['attempting']} and "
                        f"Sent Mail has no copy to {_to_addrs(rec)[0]} with its subject "
                        f"since then. It may still have gone. Check that thread, then "
                        f"delete its Attempting: line to send it, or replace that line "
                        f"with a Sent: line to skip it. Nothing was sent.")
                stamp_block(Path(batch), rec["slug"], f"{found} (found in Sent Mail)")
                rec["sent"] = found
                print(f"found one in Sent Mail: {rec['slug']} {rec['to']} at {found}, "
                      f"stamped Sent", flush=True)
            skipped += sum(1 for r in pending if r["sent"])
            pending = [r for r in pending if not r["sent"]]
            # a reply that will not thread is a hard block BEFORE anything goes out, so
            # every thread is resolved first and the batch either sends whole or not at
            # all. On 11 Aug the post-hoc warning put 9 of 11 into new conversations,
            # which is too late to be a decision.
            plan = []
            for rec in pending:
                irt, refs = thread_headers(imap, rec) if is_reply(rec) else (None, None)
                if is_reply(rec) and not irt:
                    raise SystemExit(
                        f"HOLD: no thread found for {rec['slug']} - it would start a new "
                        f"conversation. Nothing further has been sent.")
                plan.append((rec, irt, refs))
            for rec, irt, refs in () if args.send else plan:
                msg = build_message(rec, ident, in_reply_to=irt, references=refs,
                                    base_dir=Path(batch).parent)
                mark = "  [thread]" if irt else ""
                # --draft never stamps the file: a duplicate Gmail draft is visible and
                # harmless, a silent double-send is not. What stops a rerun after a
                # failure making every draft again is the Drafts folder itself.
                if draft_exists(imap, rec):
                    print(f"draft {rec['slug']:<12} {rec['to']}{mark}  already in Drafts, "
                          f"skipped", flush=True)
                    continue
                append_draft(msg, pw, conn=imap)
                print(f"draft {rec['slug']:<12} {rec['to']}{mark}", flush=True)
        # why the batch stopped, when it did. Every stop is one block that did not cleanly
        # send, and it is the failed count, so a stopped batch never reads "0 failed".
        stop = None
        if args.send and plan:
            with smtp_session(pw, ident["sender"], ident.get("smtp_host")) as conn:
                for rec, irt, refs in plan:
                    msg = build_message(rec, ident, in_reply_to=irt, references=refs,
                                        base_dir=Path(batch).parent)
                    mark = "  [thread]" if irt else ""
                    # into the file before the message goes on the wire. Until a Sent:
                    # line replaces it the block is UNKNOWN, and a rerun will not send it
                    # before Sent Mail has been checked. If this write fails, nothing went.
                    tried = datetime.now().strftime("%Y-%m-%d %H:%M")
                    stamp_block(Path(batch), rec["slug"], tried, key="Attempting")
                    try:
                        refused = smtp_send(msg, pw, conn=conn)
                    except AmbiguousSend as e:
                        # the Attempting: line already holds the block. This write only
                        # says why, so its own failure changes nothing.
                        with contextlib.suppress(OSError, BatchError):
                            stamp_block(Path(batch), rec["slug"], f"{tried} UNKNOWN, {e}",
                                        key="Attempting")
                        stop = (f"UNKNOWN: {rec['slug']} {rec['to']}: the connection "
                                f"failed after the message went to the server ({e}), so "
                                f"it may have been sent. It was not retried. A rerun "
                                f"checks Sent Mail before it will send this block. Nothing "
                                f"further has been sent.")
                        break
                    except Exception as e:
                        # refused outright or failed before DATA: the server took nothing,
                        # so the block is sendable again
                        try:
                            stamp_block(Path(batch), rec["slug"], None)
                        except (OSError, BatchError) as e2:
                            print(f"postman: {rec['slug']}: its Attempting: line could not "
                                  f"be cleared ({e2}), so a rerun treats it as UNKNOWN.",
                                  file=sys.stderr)
                        if not isinstance(e, (OSError, smtplib.SMTPException)):
                            raise                   # not a mail error: a bug, surfaced whole
                        stop = (f"FAILED: {rec['slug']} {rec['to']}: {type(e).__name__}: "
                                f"{' '.join(str(e).split())}. The server took nothing, so a "
                                f"rerun sends it. Nothing further has been sent.")
                        break
                    when = datetime.now().strftime("%Y-%m-%d %H:%M")
                    line = (f"{when} PARTIAL, refused {', '.join(refused)}" if refused
                            else when)
                    # stamped before the next send, not after the loop: the window a
                    # crash can land in is one recipient wide either way, and only this
                    # order makes that window "not stamped" rather than "sent twice".
                    # A stamp that fails here leaves the Attempting: line, so the block
                    # is UNKNOWN on a rerun, never unstamped and sendable.
                    try:
                        stamp_block(Path(batch), rec["slug"], line)
                    except (OSError, BatchError) as e:
                        stop = (f"UNKNOWN: {rec['slug']} {rec['to']} was sent, but its "
                                f"Sent: stamp could not be written ({type(e).__name__}: "
                                f"{e}). Its Attempting: line holds it, so a rerun checks "
                                f"Sent Mail before sending it again. Nothing further has "
                                f"been sent.")
                        break
                    if refused:
                        # the others have it, so the block is stamped (a rerun would send
                        # them a second copy), but the stamp names who did not, and the
                        # batch stops: one refusal can be the first of a run of them (#49)
                        stop = (f"PARTIAL: {rec['slug']} went to every recipient but "
                                f"{refusal_text(refused)}. Its Sent: line says so, and a "
                                f"rerun will not send it again. Nothing further has been "
                                f"sent.")
                        break
                    sent += 1
                    print(f"sent  {rec['slug']:<12} {rec['to']}{mark}", flush=True)
        if stop:
            print(stop, flush=True)
        failed = 1 if stop else 0
        print(f"\n{len(recs)} parsed | {skipped} skipped | {len(pending)} built | "
              f"{sent} sent | {failed} failed")
        if args.send:
            print(f"Run --bounces {ident['name']} 1 in 30 minutes for layer 4.")
        return 1 if failed else 0
    if args.selftest:
        selftest()
        return 0
    ap.error("no mode given")


if __name__ == "__main__":
    sys.exit(main())
