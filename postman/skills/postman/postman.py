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

import common

if __name__ == "__main__":
    # Run as a script this module is __main__, and inbox.py's `import postman` would
    # execute the file a second time as a separate module with its own globals (#53).
    # Registering it under its own name first makes that import find this one.
    sys.modules.setdefault("postman", sys.modules[__name__])


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
    # Once the DATA step begins the server may end up holding the whole message, and a
    # connection that drops before its 250 arrives looks exactly like one that dropped
    # before it had anything. smtplib cannot tell them apart, so this marks the moment
    # data() is called, before the DATA command itself goes out. A drop on that command
    # also reads as ambiguous, which is the safe direction (#48).
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
        # the same as smtp_session: a failed LOGOUT must not mask the original error.
        # IMAP4.logout only shuts the socket after the command returns, so close it here.
        try:
            M.logout()
        except (OSError, imaplib.IMAP4.error):
            with contextlib.suppress(OSError):
                M.shutdown()


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
# how far either side of its Attempting: minute a Sent Mail copy still counts, for clock
# skew between this machine and the server that stamped the Date header. The window is
# closed at the far end too: a later mail in the same thread to the same address, sent
# by hand or by a later batch, is not this send and must not clear it.
ATTEMPT_SKEW = timedelta(minutes=5)


def sent_copy(M, rec):
    """When Sent Mail holds rec as sent within ATTEMPT_SKEW of its Attempting: minute,
    else None.

    Matched on the first To address, the unfolded subject and the Date header. Never on
    Message-ID: Gmail replaces the one smtplib sent with its own, so the id we built never
    reaches the mailbox (test/test_threading_live.py). None too when the Attempting: value
    carries no time, because an unknown window cannot clear anything.
    """
    m = ATTEMPT_RE.match(rec.get("attempting") or "")
    if not m:
        return None
    tried = datetime.strptime(m.group(1), "%Y-%m-%d %H:%M").astimezone()
    # the stamp is truncated to the minute, so the send itself fell inside that minute
    since, until = tried - ATTEMPT_SKEW, tried + timedelta(minutes=1) + ATTEMPT_SKEW
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
        if since <= when <= until:
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
    common.atomic_write(path, "".join(out))


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
        folder = common.open_mailbox(M, special_folder(M, "\\All"), lambda why: SystemExit(
            f"--bounces: {why}. Nothing was swept, so this is not a clean result."))
        stamp = since.strftime("%d-%b-%Y")
        for who in ("mailer-daemon", "postmaster"):
            typ, data = M.search(None, "SINCE", stamp, "FROM", who)
            if typ != "OK":
                raise SystemExit(f"--bounces: SEARCH FROM {who} failed: {typ}. Nothing "
                                 f"was swept, so this is not a clean result.")
            for uid in (data[0] or b"").split():
                typ, d = M.fetch(uid, "(BODY[HEADER.FIELDS (SUBJECT FROM)])")
                # a bounce that cannot be read is not a bounce that is not there
                raw = common.fetched(typ, d)
                if raw is None:
                    raise SystemExit(f"--bounces: FETCH {uid.decode()} failed: {typ}. "
                                     f"This is not a clean result.")
                hits.append(raw.decode("utf-8", "replace").strip())
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
        common.open_mailbox(M, special_folder(M, "\\Drafts"), lambda why: SystemExit(
            f"--drafts: {why}. Nothing was read or changed."), readonly=not purge)
        typ, data = M.uid("SEARCH", "ALL")
        if typ != "OK":
            raise SystemExit(f"--drafts: SEARCH failed: {typ}. Nothing was changed.")
        uids = [u.decode() for u in (data[0] or b"").split()]
        # chunked, not one FETCH per draft. A draft the answer leaves out is skipped.
        got = common.fetch_headers(M, uids, "(BODY.PEEK[HEADER.FIELDS (TO SUBJECT)])")
        for uid in uids:
            if uid not in got:
                continue
            hdr = " ".join(got[uid].decode("utf-8", "replace").split())
            if match and match.lower() not in hdr.lower():
                continue
            out.append((uid, hdr))
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


def selftest():
    """--selftest: the offline suite in the plugin's test/ folder, run with unittest (#53).

    Every test_*.py there runs except *_live.py, which needs a real mailbox. Exits 1 on a
    failure and on a run that found nothing, so CI goes red either way.
    """
    import unittest
    tests = Path(__file__).resolve().parent.parent.parent / "test"
    names = sorted(p.stem for p in tests.glob("test_*.py") if not p.stem.endswith("_live"))
    # pinned by value: a glob that stopped matching would otherwise pass on what is left
    missing = {"test_common", "test_inbox", "test_postman"} - set(names)
    if missing:
        raise SystemExit(f"selftest: {', '.join(sorted(missing))} not found in {tests}")
    sys.path.insert(0, str(tests))
    suite = unittest.defaultTestLoader.loadTestsFromNames(names)
    result = unittest.TextTestRunner().run(suite)
    if not result.wasSuccessful() or not result.testsRun:
        raise SystemExit(1)
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
                        f"from around then. It may still have gone. Check that thread, "
                        f"then delete its Attempting: line to send it, or replace that "
                        f"line with a Sent: line to skip it. Nothing was sent.")
                # a PARTIAL whose Sent: stamp failed left its refusals on this line, and
                # they ride into the stamp so nobody loses who was not reached
                partial = rec["attempting"].partition(" PARTIAL, ")[2]
                found += " (found in Sent Mail)" + (f" PARTIAL, {partial}" if partial else "")
                stamp_block(Path(batch), rec["slug"], found)
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
                    mark = "  [thread]" if irt else ""
                    # into the file before the message goes on the wire. Until a Sent:
                    # line replaces it the block is UNKNOWN, and a rerun will not send it
                    # before Sent Mail has been checked. If the build or this write fails,
                    # nothing went, and the stamp is atomic, so the file is unchanged.
                    tried = datetime.now().strftime("%Y-%m-%d %H:%M")
                    try:
                        msg = build_message(rec, ident, in_reply_to=irt, references=refs,
                                            base_dir=Path(batch).parent)
                        stamp_block(Path(batch), rec["slug"], tried, key="Attempting")
                    except (OSError, BatchError, SystemExit) as e:
                        stop = (f"FAILED: {rec['slug']} {rec['to']}: {type(e).__name__}: "
                                f"{e}. Nothing was sent for it. Nothing further has been "
                                f"sent.")
                        break
                    try:
                        refused = smtp_send(msg, pw, conn=conn)
                    except AmbiguousSend as e:
                        # the Attempting: line already holds the block. This write only
                        # says why, so its own failure changes nothing.
                        with contextlib.suppress(OSError, BatchError):
                            stamp_block(Path(batch), rec["slug"], f"{tried} UNKNOWN, {e}",
                                        key="Attempting")
                        stop = (f"UNKNOWN: {rec['slug']} {rec['to']}: the connection "
                                f"failed once the DATA step had begun ({e}), so the server "
                                f"may have the message. It was not retried. A rerun "
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
                        # the refusals are the one thing Sent Mail cannot give back, so
                        # they go on the Attempting: line if the file takes a write at all,
                        # and into this message whether it does or not
                        if refused:
                            with contextlib.suppress(OSError, BatchError):
                                stamp_block(Path(batch), rec["slug"],
                                            f"{tried} PARTIAL, refused "
                                            f"{', '.join(refused)}", key="Attempting")
                        stop = (f"UNKNOWN: {rec['slug']} {rec['to']} was sent, but its "
                                f"Sent: stamp could not be written ({type(e).__name__}: "
                                f"{e}). Its Attempting: line holds it, so a rerun checks "
                                f"Sent Mail before sending it again. "
                                + (f"The server refused {refusal_text(refused)}. "
                                   if refused else "")
                                + "Nothing further has been sent.")
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
