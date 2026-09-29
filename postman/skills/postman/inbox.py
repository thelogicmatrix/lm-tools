#!/usr/bin/env python3
"""Postman read path - inbox pull, attribution, inbox.md. See SKILL.md."""
import email
import email.header
import email.policy
import html as htmllib
import imaplib
import json
import os
import re
import sys
from datetime import date, datetime, timedelta
from email.utils import getaddresses, parsedate_to_datetime
from pathlib import Path

import common
import postman

# IMAP lookback for the inbox pull. NOT postman.FRESH_DAYS (how stale a Source: read
# may be): binding them means widening the inbox to 60 days silently accepts
# 60-day-old source reads. They start equal by coincidence and may diverge.
INBOX_DAYS = 30
PROGRESS_EVERY = 25             # also the threshold below which a fetch stays silent

# inbox.md is read by a model, so its size is a context budget, not a cosmetic
# concern. On 2026-08-16 the jobhunt file reached 4.3 MB (~1.07M tokens) because
# no registry.json existed: with zero owners nothing can be ignored, every one of
# 6,175 messages counted as new, and each got its own fence. Per-fence caps did
# not bound that - thread COUNT is the unbounded axis, and so is the unaccounted
# list at one line per message. Both are capped here, and the trim is always
# stated in the header rather than silently applied.
# Attachment saving (--attachments). Documents are always kept. Images are kept
# only above MIN_IMAGE_BYTES: every corporate signature carries a logo, and a
# 142 KB banner that lands next to a real proposal is noise wearing its filename.
#
# SIZE, NOT Content-Disposition, is what separates the two. That looks backwards
# and is not: measured on real venue mail 2026-08-27, an out-of-office marked its
# 965 B signature gif `disposition: attachment`, while both a pasted AV screenshot
# (79,677 B) and an emailed venue photo (496,029 B) arrived `disposition: inline`
# with a Content-ID, exactly like a logo. Disposition splits none of it. Size splits
# all of it, and the observed gap is 3,662 B of logo against 79,677 B of content.
#
# The floor was 500_000 until 2026-08-27 and sat ABOVE four of the five images worth
# keeping, so two 210 KB room photos from a venue and a screenshot carrying the AV
# inclusions were all binned as logos and the answers were lost twice. 20_000 clears
# every logo seen by 5x and every real image by 4x.
DOC_EXTS = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
            ".csv", ".rtf", ".txt", ".zip"}
MIN_IMAGE_BYTES = 20_000

FENCE_LIMIT = 150               # threads that get a quoted fence; rest are headings only
UNACCOUNTED_LIMIT = 200         # lines in the unaccounted tail


class InboxError(Exception):
    """The mailbox read failed in a way that must not be mistaken for an empty inbox."""


def store_dir(ident):
    """The identity's per-identity store, outside git. inbox.md, registry.json and
    seen.json all live here and all carry counterparty addresses - never in a repo."""
    d = ident["store"]
    d.mkdir(parents=True, exist_ok=True)
    return d


# Every store file is written with common.atomic_write: a half-written store is worse
# than a missing one.
def _load_json(path, default):
    if not path.exists():
        return default
    return json.loads(path.read_text(encoding="utf-8"))


def load_registry(ident):
    # keys lowercased on load: the file is hand-edited, addresses are case-insensitive
    # in practice, and a mixed-case key that never matches would also make
    # suggest_registrations write a second, lowercase entry for the same sender
    return {k.lower(): v
            for k, v in _load_json(store_dir(ident) / "registry.json", {}).items()}


def save_registry(ident, reg):
    common.atomic_write(store_dir(ident) / "registry.json",
                  json.dumps(reg, indent=1, sort_keys=True) + "\n")


def load_seen(ident):
    return set(_load_json(store_dir(ident) / "seen.json", []))


def save_seen(ident, seen):
    common.atomic_write(store_dir(ident) / "seen.json", json.dumps(sorted(seen)))


# The header cache (#50). A message's headers never change while its mailbox keeps the
# same UIDVALIDITY, so a pull reuses every header it already has and fetches only the
# rest. In memory the headers are bytes, on disk latin-1 text, which maps every byte.
def load_header_cache(ident):
    c = _load_json(store_dir(ident) / "headers.json", {})
    return dict(c, headers={u: h.encode("latin-1")
                            for u, h in c.get("headers", {}).items()})


def save_header_cache(ident, cache):
    common.atomic_write(store_dir(ident) / "headers.json", json.dumps(dict(
        cache, headers={u: h.decode("latin-1")
                        for u, h in cache.get("headers", {}).items()})))


HEADER_FIELDS = ("(BODY.PEEK[HEADER.FIELDS "
                 "(FROM TO SUBJECT DATE MESSAGE-ID REFERENCES IN-REPLY-TO)])")


def _decode(value):
    """MIME encoded-words decoded, best effort. Undecodable stays raw - the pull
    must never die on one venue's broken mailer."""
    if not value:
        return ""
    try:
        return str(email.header.make_header(email.header.decode_header(value)))
    except (UnicodeDecodeError, ValueError, LookupError):
        return value


def parse_message(raw):
    """Header bytes -> message dict. Pure, so the whole attribution and render
    pipeline is testable without a mailbox."""
    h = email.message_from_bytes(raw)
    pairs = getaddresses([h.get("From", "")])
    display, addr = pairs[0] if pairs else ("", "")
    when = None
    try:
        when = parsedate_to_datetime(h.get("Date", ""))
    except (TypeError, ValueError):
        pass
    refs = set((h.get("References") or "").split())
    irt = (h.get("In-Reply-To") or "").strip()
    if irt:
        refs.add(irt)
    return {
        "from_raw": _decode(h.get("From")),
        "from_display": _decode(display),
        "from_addr": addr.lower(),
        "to_addrs": [a.lower() for _, a in getaddresses([h.get("To", "")]) if a],
        "subject": postman.header_subject(h),
        "date_raw": _decode(h.get("Date")),
        "when": when,
        "message_id": (h.get("Message-ID") or "").strip(),
        "refs": refs,
    }


TAG_RE = re.compile(r"<[^>]+>")
# whole elements whose content is never message text: a <head> carries the <meta>
# and CSS that filled the old raw window, and comments carry Outlook's <!--[if mso]>
HIDDEN_RE = re.compile(r"<!--.*?-->|<(head|style|script|title)\b[^>]*>.*?</\1\s*>",
                       re.S | re.I)
URL_RE = re.compile(r"https?://[^\s\"<>)']+")

SNIPPET_CHARS = 2000
# ponytail: a byte cap on the whole message, not a BODYSTRUCTURE walk to the text
# part. Text parts sit before attachments in real mail, so the cap only bites on an
# html-only body over 256 KB, whose snippet then comes from its first 256 KB. Walk
# BODYSTRUCTURE and fetch the one part if that shows up.
BODY_FETCH = "(BODY.PEEK[]<0.262144>)"

# UIDs per FETCH, headers at common.FETCH_CHUNK (why 500 is there). A snippet is at most
# 256 KB, so a body chunk is at most about 50 MB in memory. ponytail: a fixed size.
HEADER_CHUNK = common.FETCH_CHUNK
BODY_CHUNK = 200


def html_to_text(html):
    # ponytail: regex reduction, no HTML parser. Upgrade if real mail arrives unreadable
    return htmllib.unescape(TAG_RE.sub(" ", HIDDEN_RE.sub(" ", html)))


def body_text(msg):
    """Readable body of an EmailMessage parsed with policy.default: the plain part
    when there is one, else the html part reduced to text. get_content decodes the
    part, so quoted-printable, base64 and the part's own headers never reach the
    caller - the raw-bytes read before 2026-09-24 handed all three over as text."""
    part = msg.get_body(preferencelist=("plain", "html"))
    if part is None:
        return ""
    try:
        text = part.get_content()
    except (KeyError, LookupError, UnicodeDecodeError):
        payload = part.get_payload(decode=True)
        text = payload.decode("utf-8", errors="replace") if payload else ""
    return html_to_text(text) if part.get_content_subtype() == "html" else text


def decode_snippet(raw_bytes):
    """Whitespace-collapsed first 2000 characters of the message TEXT. Keyword fodder
    for a consumer's classifier, not a rendering.

    raw_bytes is the whole message (BODY_FETCH), and the text is extracted BEFORE the
    cut. Cutting first was issue #11: 2000 raw bytes of an html mail are DOCTYPE, meta
    and inline CSS, and a real rejection reduced to 12 characters of markup, so the
    classifier read the subject line and nothing else. Never raises."""
    if not isinstance(raw_bytes, (bytes, bytearray)):
        return ""
    try:
        text = body_text(email.message_from_bytes(raw_bytes, policy=email.policy.default))
    except Exception:
        text = raw_bytes.decode("utf-8", errors="replace")   # one bad mailer, not the pull
    return " ".join(text.split())[:SNIPPET_CHARS]


def fetch_window(M, mailbox, days, with_snippets=False, from_addr=None, cache=None):
    """Every message in mailbox since <days> ago, readonly.

    Raises InboxError when the mailbox is broken (messages found, none fetchable) -
    printing an empty result there would read as a quiet mailbox, which is the one
    lie this mode exists to never tell. A genuinely empty window returns [].

    from_addr narrows the SEARCH server-side instead of fetching the window and
    filtering it here. That is not a nicety. The loop here was one round trip per
    UID until #50, so a 12,501 message window was headed for over two hours on
    2026-08-15 when the actual question was "what has this one counterparty sent me" and the
    answer was a handful of messages. SEARCH FROM cuts the UID list before FETCH.

    Headers come HEADER_CHUNK and snippets BODY_CHUNK to a FETCH, not one FETCH per
    message (#50). cache is the identity's header cache (load_header_cache), updated in
    place, so a pull that dies keeps what it fetched and the rerun asks only for the
    rest. A full window trims the cache to itself, a --from slice only adds to it.
    """
    common.open_mailbox(M, mailbox, InboxError)
    headers = {}
    if cache is not None:
        validity = (M.response("UIDVALIDITY")[1] or [None])[-1]
        validity = validity.decode() if isinstance(validity, bytes) else None
        if validity is None:
            cache.clear()               # nothing proves a cached UID is the same message
        else:
            if (cache.get("mailbox"), cache.get("uidvalidity")) != (mailbox, validity):
                cache.clear()
                cache.update(mailbox=mailbox, uidvalidity=validity, headers={})
            headers = cache["headers"]
    stamp = (date.today() - timedelta(days=days)).strftime("%d-%b-%Y")
    # UID commands throughout, never sequence numbers. A sequence number is valid only
    # until the next EXPUNGE: an untagged expunge mid-loop renumbers every higher
    # message, so a later fence would quote a DIFFERENT message than the header row it
    # sits under - exactly the counterparty misquote fetch_fence_text exists to avoid.
    # one address per FROM key, quoted. IMAP SEARCH takes exactly one address per
    # key, and joining several into one atom is BAD Could not parse command, not a
    # bad result - the same trap the reply threading lookup already documents.
    crit = ["SINCE", stamp] + (["FROM", f'"{from_addr}"'] if from_addr else [])
    typ, data = M.uid("SEARCH", *crit)
    if typ != "OK":
        raise InboxError(f"SEARCH {mailbox} failed: {typ}")
    uids = [u.decode() for u in (data[0] or b"").split()]
    todo = [u for u in uids if u not in headers]
    # A silent run looks identical to a hung one. This measured 3m14s on a 721 message
    # mailbox printing nothing at all, and was killed at 100s and 120s on the assumption
    # it had hung - one of those kills produced a wrong "dead credential" diagnosis that
    # ran for most of a session. stderr, so it never contaminates the --json stream on
    # stdout, and only on a window big enough to be slow, so the tests stay quiet.
    loud = len(todo) >= PROGRESS_EVERY
    if loud:
        print(f"postman inbox: {mailbox}: {len(todo)} message(s) to fetch, "
              f"{len(uids) - len(todo)} cached", file=sys.stderr, flush=True)
    common.fetch_headers(M, todo, HEADER_FIELDS, HEADER_CHUNK, headers,
                         loud and f"{mailbox}: headers")
    bodies = {}
    if with_snippets:
        common.fetch_headers(M, uids, BODY_FETCH, BODY_CHUNK, bodies,
                             len(uids) >= PROGRESS_EVERY and f"{mailbox}: snippets")
    out = []
    for uid in uids:
        if uid not in headers:
            continue
        msg = parse_message(headers[uid])
        msg["uid"] = uid
        if with_snippets:
            msg["snippet"] = decode_snippet(bodies.get(uid))
        out.append(msg)
    skipped = len(uids) - len(out)
    if cache is not None and not from_addr:
        window = set(uids)
        for uid in [u for u in headers if u not in window]:
            del headers[uid]
    if uids and not out:
        raise InboxError(
            f"{mailbox}: {len(uids)} message(s) found, none fetchable - "
            f"mailbox/connection problem, not an empty inbox")
    if skipped:
        print(f"postman inbox: skipped {skipped} malformed fetch(es) in {mailbox}",
              file=sys.stderr)
    return out


def save_attachments(msg, att_dir, prefix):
    """Select msg's real attachments, return [(name, nbytes, path_or_None)].

    Called from fetch_fence_text with the message it ALREADY fetched: the fence
    fetch is a full BODY.PEEK[], which is the whole MIME tree, so pulling the
    attachment out of it costs no extra IMAP round trip. A separate pass would
    double the per-message cost of the one path that is already the expensive one.

    att_dir=None SELECTS WITHOUT WRITING, and each entry comes back with a path of
    None. That is the whole point: when nobody passed --attachments, the answer to
    "did this message carry an image" has to still reach inbox.md, or a screenshot
    holding the AV inclusions reads as a message that said nothing (it did, twice,
    before 2026-08-27). The reader is told what is there and how to fetch it.
    """
    out = []
    for part in msg.iter_attachments():
        name = part.get_filename()
        try:
            payload = part.get_payload(decode=True)
        except Exception:
            continue                      # one bad part must not lose the others
        if not name or not payload:
            continue
        if (os.path.splitext(name)[1].lower() not in DOC_EXTS
                and len(payload) < MIN_IMAGE_BYTES):
            continue
        if att_dir is None:
            out.append((name, len(payload), None))
            continue
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", name)[:120]
        dest = Path(att_dir) / f"{prefix}__{safe}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payload)
        out.append((name, len(payload), str(dest)))
    return out


def _att_lines(m):
    """An attachment named in inbox.md but not on disk is worse than silence - the
    reader quotes a proposal they never opened. So a written file names its path and
    an unwritten one says so and names the flag that would fetch it. Silence is the
    one option that is not offered: a message whose content is inside an image
    otherwise renders as a message with nothing in it."""
    return [f"- attachment: {name} ({n // 1024} KB) -> {path}" if path
            else f"- attachment: {name} ({n // 1024} KB), NOT SAVED"
                 f" - re-run with --attachments DIR to read it"
            for name, n, path in m.get("atts") or []]


def _att_prefix(m):
    """Sender domain plus uid, so a saved file names its counterparty and cannot
    collide. inbox.py has no batch to read slugs from - the domain is the only
    stable identity in the read path. The uid is there because inline images are
    named by the mailer, not the sender: every Outlook message calls them
    image001.png, image002.png, image003.png, so a domain-only prefix silently
    overwrote one message's screenshot with the next message's signature logo."""
    domain = re.sub(r"[^A-Za-z0-9._-]+", "_",
                    (m.get("from_addr") or "unknown").rsplit("@", 1)[-1]) or "unknown"
    uid = re.sub(r"[^A-Za-z0-9]+", "", str(m.get("uid") or "")) or "nouid"
    return f"{domain}__{uid}"


def fetch_fence_text(M, uid, cap_lines=12, cap_chars=800,
                     att_dir=None, att_prefix="", atts_out=None):
    """Plain-text body of ONE message, for the quoted fence in inbox.md. Fetched in
    full only for each rendered thread's latest inbound message, so the pull stays
    cheap. Lifted mechanically - batch.md carries these bytes verbatim, so a
    paraphrase here is a counterparty misquoted there."""
    raw = common.fetched(*M.uid("FETCH", uid.encode(), "(BODY.PEEK[])"))
    if raw is None:
        return ""
    # a missing fence loses one section; a raise loses the whole pull. The strict
    # default policy over arbitrary real-world MIME raises far more than the narrow
    # band this used to catch (a charset of "\x00" is a ValueError out of
    # get_content), and the caller's except band does not cover it - so one malformed
    # venue message would discard a finished ~4-minute pull. The fence is cosmetic.
    try:
        msg = email.message_from_bytes(raw, policy=email.policy.default)
        # out-param rather than a second return value: every existing caller wants
        # the text alone, and a conditional tuple return would make them all branch
        # on a flag to read a string.
        # atts_out alone, not att_dir: with no --attachments the parts are still
        # listed (path None) so inbox.md can say an image is carrying the answer
        if atts_out is not None:
            atts_out.extend(save_attachments(msg, att_dir, att_prefix))
        text = body_text(msg)
    except Exception:
        return ""
    lines = [ln.strip() for ln in text.replace("\r\n", "\n").splitlines()]
    lines = [ln for ln in lines if ln][:cap_lines]
    out = "\n".join(lines)
    return out[:cap_chars]


def sent_index(own):
    """What layer 1 matches against: our own Message-IDs, and (recipient, base
    subject) pairs. In the real corpus all 5 'unmatched' messages were own outbound
    sitting inside postman threads - resolving own mail FIRST is what makes
    'attributed' and 'own outbound' disjoint."""
    mids = {m["message_id"] for m in own if m["message_id"]}
    pairs = {(a, postman.base_subject(m["subject"]).lower())
             for m in own for a in m["to_addrs"]}
    return mids, pairs


def attribute(inbound, own, registry):
    """Layers 0-2 over one window. Layer 0 already happened (the own/inbound split is
    the caller's, by From == sender). Mutates each inbound message with 'bucket'
    (attributed | unaccounted | ignored) and 'attribution' (dict or None). Returns
    the counts, with the accounting identity enforced, not assumed."""
    mids, pairs = sent_index(own)
    # normalised locally too, not only in load_registry: attribute() is called directly
    # (tests, any future caller) and a mixed-case 'ignore' entry that silently never
    # ignores is indistinguishable from an entry nobody added
    registry = {k.lower(): v for k, v in registry.items()}
    # A key written '@example.com' covers the whole domain. Per-address ignore entries
    # alone never collapsed the noise: a vendor sends from no-reply@, billing@ and
    # notifications@, so an address list is stale by the next invoice and 58% of inbound
    # sat unaccounted with `ignored` at zero (issue 2026-08-13). An exact address still
    # beats its domain, so one real human at an otherwise ignored vendor stays visible.
    dom_ents = {k[1:]: v for k, v in registry.items() if k.startswith("@")}
    addr_reg = {k: v for k, v in registry.items() if not k.startswith("@")}
    domains = {}
    for addr, ent in addr_reg.items():
        if ent.get("owner") == "ignore":
            continue
        domains.setdefault(addr.rsplit("@", 1)[-1].lower(), []).append(ent)
    for m in inbound:
        dom = m["from_addr"].rsplit("@", 1)[-1].lower()
        ent = addr_reg.get(m["from_addr"].lower())
        dent = dom_ents.get(dom)
        if (ent or dent or {}).get("owner") == "ignore":
            # an explicit human decision beats inference, so this precedes layer 1
            m["bucket"], m["attribution"] = "ignored", None
            continue
        threaded = bool(m["refs"] & mids) or (
            (m["from_addr"], postman.base_subject(m["subject"]).lower()) in pairs)
        if threaded:
            m["bucket"] = "attributed"
            m["attribution"] = {"via": "thread", "owner": (ent or {}).get("owner"),
                                "label": (ent or {}).get("label")}
            continue
        if ent:
            m["bucket"] = "attributed"
            m["attribution"] = {"via": "registry", "owner": ent["owner"],
                                "label": ent.get("label")}
            continue
        if dent:
            # a declared domain entry is a human decision, not a guess, so it does not
            # go through the suggestion path below
            m["bucket"] = "attributed"
            m["attribution"] = {"via": "registry-domain", "owner": dent["owner"],
                                "label": dent.get("label")}
            continue
        ents = domains.get(dom, [])
        owners = {e["owner"] for e in ents}
        if len(owners) == 1:
            # a domain hit proposes the owner only: one real group carried three
            # addresses across two labels, deliberately kept apart, so a label
            # guess is left unset for confirmation
            labels = {e.get("label") for e in ents}
            m["bucket"] = "attributed"
            m["attribution"] = {"via": "suggested", "owner": owners.pop(),
                                "label": labels.pop() if len(labels) == 1 else None}
        else:
            # zero owners, or several: a guess between owners is a coin flip
            m["bucket"], m["attribution"] = "unaccounted", None
    counts = {b: sum(1 for m in inbound if m["bucket"] == b)
              for b in ("attributed", "unaccounted", "ignored")}
    if len(inbound) != sum(counts.values()):
        raise SystemExit(
            f"attribution accounting broken: {len(inbound)} inbound != {counts}")
    return counts


def suggest_registrations(inbound, registry):
    """The registry entries the domain guesses imply. Additive only: an existing
    entry, confirmed or suggested, is never overwritten."""
    out = {}
    for m in inbound:
        a = m.get("attribution") or {}
        if a.get("via") == "suggested" and m["from_addr"] not in registry:
            ent = {"owner": a["owner"], "suggested": True}
            if a.get("label"):
                ent["label"] = a["label"]
            out[m["from_addr"]] = ent
    return out


def _stamp(when):
    """'11 Aug 14:22' / '8 Aug'. f-string day because Windows strftime has no %-d."""
    if when is None:
        return "?"
    return f"{when.day} {when:%b %H:%M}" if (when.hour or when.minute) \
        else f"{when.day} {when:%b}"


def _day(when):
    return "?" if when is None else f"{when.day} {when:%b}"


def group_threads(own, inbound):
    """(counterparty address, base subject) -> thread. Own outbound joins the thread
    it was sent to; own mail with no inbound thread is counted in the header but is
    not a section - the inbox reports what arrived."""
    threads = {}
    for m in inbound:
        if m["bucket"] == "ignored":
            continue
        key = (m["from_addr"], postman.base_subject(m["subject"]).lower())
        t = threads.setdefault(key, {"addr": m["from_addr"],
                                     "subject": postman.base_subject(m["subject"]),
                                     "msgs": []})
        t["msgs"].append(m)
    for m in own:
        for a in m["to_addrs"]:
            key = (a, postman.base_subject(m["subject"]).lower())
            if key in threads:
                threads[key]["msgs"].append(m)
    out = list(threads.values())
    for t in out:
        t["msgs"].sort(key=lambda m: m["when"].timestamp() if m["when"] else 0)
        # own-outbound messages carry no 'bucket' key (only attribute() sets it, and
        # it only sees inbound), so bucket-bearing == inbound member of this thread
        inb = [m for m in t["msgs"] if m.get("bucket")]
        t["latest_inbound"] = inb[-1] if inb else None
    out.sort(key=lambda t: t["msgs"][-1]["when"].timestamp()
             if t["msgs"][-1]["when"] else 0, reverse=True)
    return out


def _slug(t, registry):
    ent = registry.get(t["addr"]) or {}
    return ent.get("label") or t["addr"].rsplit("@", 1)[-1].split(".")[0]


def render_inbox(name, days, now, threads, counts, new_ids, unaccounted, registry,
                 show_all=False, full_thread=False):
    """The generated, disposable inbox.md. Same grammar as batch.md deliberately, so
    quoted fences are lifted mechanically rather than retyped.

    full_thread renders a fence for every message that has one instead of the
    latest inbound alone. Explicit rather than inferred from how many fences are
    present, because the callers that build fixtures fence every message and would
    silently switch mode."""
    lines = [f"# Inbox: {name}        window {days} days        "
             f"pulled {now:%Y-%m-%d %H:%M}", ""]
    lines += [f"messages {counts['messages']} | inbound {counts['inbound']} | "
              f"own outbound {counts['own']} | attributed {counts['attributed']} | "
              f"unaccounted {counts['unaccounted']} | ignored {counts['ignored']}",
              f"new since last pull: {len(new_ids)}", "", "---", ""]
    fenced_threads = trimmed_threads = 0
    for t in threads:
        fresh = any(m["message_id"] in new_ids for m in t["msgs"] if m.get("bucket"))
        if not (fresh or show_all):
            continue
        li = t["latest_inbound"]
        disp = (li or {}).get("from_display") or t["addr"]
        tags = ("            [NEW]" if fresh else "")
        a = (li or {}).get("attribution") or {}
        if a.get("via") == "suggested":
            tags += f"  [suggested: {a['owner']}"
            tags += f"/{a['label']}]" if a.get("label") else "]"
        lines.append(f"## @{_slug(t, registry)} | {disp} <{t['addr']}>{tags}")
        own_msgs = [m for m in t["msgs"] if not m.get("bucket")]
        you = f"you last wrote {_day(own_msgs[-1]['when'])}" if own_msgs \
            else "no reply from you"
        lines.append(f'thread: "{t["subject"]}" | {len(t["msgs"])} messages | {you}')
        lines.append("")
        # every message that was given a fence gets one, oldest first, not only the
        # latest. A full-window pull fences the latest inbound alone and that stays
        # the default. A --from slice fences the whole thread, because "what did
        # they say about X" is regularly answered three replies up, and a summary
        # of the last message alone reads as though it were the whole exchange.
        fenced = [m for m in t["msgs"] if m.get("fence")] if full_thread else []
        # past FENCE_LIMIT the thread keeps its heading, subject and full message
        # roll-up and loses only the quoted body. Nothing disappears from the file;
        # the accounting header still balances and 'earlier:' below lists every
        # message, including the latest, since none of them was quoted above.
        render_fence = fenced_threads < FENCE_LIMIT
        if render_fence:
            fenced_threads += 1
            if fenced:
                for m in fenced:
                    who = m['from_display'] or m['from_addr'] if m.get("bucket") else "you"
                    lines += ["```quoted", f"{who}, {_stamp(m['when'])}",
                              m["fence"], "```"]
                    lines += _att_lines(m) + [""]
            elif li is not None:
                lines += ["```quoted", f"{disp}, {_stamp(li['when'])}",
                          li.get("fence") or li.get("snippet") or "", "```"]
                lines += _att_lines(li)
        else:
            trimmed_threads += 1
        shown = (set(id(m) for m in fenced) if fenced else {id(li)}) \
            if render_fence else set()
        earlier = [f"you {_day(m['when'])}" if not m.get("bucket")
                   else f"{m['from_display'] or m['from_addr']} {_day(m['when'])}"
                   for m in t["msgs"] if id(m) not in shown]
        if earlier:
            lines.append("earlier: " + ", ".join(earlier))
        lines += ["", "---", ""]
    if unaccounted:
        lines.append("## unaccounted")
        for m in unaccounted[:UNACCOUNTED_LIMIT]:
            lines.append(f"- {m['from_raw']} | {m['subject']} | {m['date_raw']}")
        if len(unaccounted) > UNACCOUNTED_LIMIT:
            lines.append(f"- ...and {len(unaccounted) - UNACCOUNTED_LIMIT} more "
                         f"unaccounted, not listed")
        lines.append("")
    # stated, never silent: a trimmed file that looks whole is the failure mode.
    if trimmed_threads or len(unaccounted) > UNACCOUNTED_LIMIT:
        lines.insert(3, f"TRIMMED: {trimmed_threads} thread(s) rendered without a "
                        f"quoted body, {max(0, len(unaccounted) - UNACCOUNTED_LIMIT)} "
                        f"unaccounted line(s) omitted. Register noisy senders in "
                        f"registry.json ('owner': 'ignore') or narrow with --from.")
    return "\n".join(lines)


def write_outputs(ident, text, seen):
    """inbox.md FIRST, seen-store second, both atomic. The other order marks ids
    reported that were never written anywhere, and the next pull says 'new: 0' -
    indistinguishable from a quiet mailbox (spec section 3)."""
    common.atomic_write(store_dir(ident) / "inbox.md", text)
    save_seen(ident, seen)


def to_json_stream(messages):
    """The per-message contract an external consumer reads. from/subject/date/
    snippet match the the ad-hoc script this replaced; thread_id and attribution are
    additive and a consumer may ignore them. Cardinality stays per-message so nothing
    else downstream moves."""
    return [{"from": m["from_raw"], "subject": m["subject"], "date": m["date_raw"],
             "snippet": m.get("snippet", ""),
             "thread_id": f"{m['from_addr']}|"
                          f"{postman.base_subject(m['subject']).lower()}",
             "attribution": m.get("attribution")}
            for m in messages]


def inbox_main(argv):
    import argparse
    ap = argparse.ArgumentParser(
        prog="postman inbox",
        description="read a mailbox window into inbox.md, or --json for another tool to consume")
    # required positional: a file-less mode never defaults to 'work' - the forgotten
    # flag would read the wrong mailbox and report 'unaccounted 0' about a mailbox
    # nobody asked about (the contract this replaced)
    ap.add_argument("identity")
    ap.add_argument("--days", type=int, default=INBOX_DAYS,
                    help=f"IMAP lookback (default {INBOX_DAYS})")
    ap.add_argument("--all", action="store_true", dest="show_all",
                    help="render every thread in the window, not only NEW ones")
    ap.add_argument("--json", action="store_true", dest="as_json",
                    help="emit the per-message JSON stream for another tool to consume; read-only")
    ap.add_argument("--attachments", dest="att_dir", metavar="DIR",
                    help="save attachments from every fenced message into DIR, "
                         "named '<sender-domain>__<uid>__<filename>'. Documents "
                         "always, images above 20 KB, which keeps a pasted "
                         "screenshot and drops a signature logo. Without this flag "
                         "the same parts are still LISTED in inbox.md, unsaved. "
                         "Pair with --from to sweep one counterparty's whole thread.")
    ap.add_argument("--from", dest="from_addr", metavar="ADDR",
                    help="narrow the IMAP SEARCH to one sender address or domain, "
                         "server-side. Use it for 'what has X sent me' on a big "
                         "mailbox: it fetches only that sender's messages.")
    args = ap.parse_args(argv)
    ident = postman.resolve_identity(args.identity, None)
    if not args.as_json:
        # every mode that resolves a sender prints it first (the contract this replaced)
        print(f"reading as: {ident['sender']}  (identity: {ident['name']})")
    try:
        # env first, pw_cmd second - the same bootstrap every other mode uses, so
        # `postman inbox` no longer needs the password exported by hand
        pw = postman.gmail_password(ident)
    except SystemExit as e:
        print(f"postman inbox: {e}", file=sys.stderr)
        return 2                # 2 = credentials, 1 = IMAP: a caller keys off this
    registry = load_registry(ident)
    sender = ident["sender"].lower()
    cache = load_header_cache(ident)
    all_mail = postman.ALL_MAIL                 # pull() replaces it with what LIST names

    def pull(M):
        """Everything that needs the mailbox. None once --json has printed."""
        nonlocal all_mail
        all_mail = postman.special_folder(M, "\\All")
        if args.as_json:
            # All Mail, not INBOX, for the same reason the render path uses it: an
            # archived thread has left INBOX entirely and archiving is normal
            # behaviour, so an INBOX read cannot tell "they never wrote back" from
            # "I archived it". Measured 2026-08-13: All Mail is a strict superset
            # of INBOX and of Sent (0 ids in either that it does not carry), so the
            # separate SENT fetch it used to need is now redundant.
            # Only inbound is emitted - All Mail carries every sent message too, and
            # the consumer's triage keys on the sender, so our own outbound would arrive as
            # threads that can never match. Neither inbox.md nor seen.json is written: a
            # sweep from the consumer must not eat inbox.md's 'new' markers. The header
            # cache is, because it carries no 'new' state.
            msgs = fetch_window(M, all_mail, args.days, with_snippets=True,
                                from_addr=args.from_addr, cache=cache)
            inbound = [m for m in msgs if m["from_addr"] != sender]
            own = [m for m in msgs if m["from_addr"] == sender]
            attribute(inbound, own, registry)
            json.dump(to_json_stream(inbound), sys.stdout)
            return None
        msgs = fetch_window(M, all_mail, args.days,
                            from_addr=args.from_addr, cache=cache)
        own = [m for m in msgs if m["from_addr"] == sender]
        inbound = [m for m in msgs if m["from_addr"] != sender]
        counts = attribute(inbound, own, registry)
        seen = load_seen(ident)
        new_ids = {m["message_id"] for m in inbound
                   if m["message_id"] and m["message_id"] not in seen}
        threads = group_threads(own, inbound)
        # full body only for each rendered thread's latest inbound message, and only
        # while render_inbox still has a fence to give: past FENCE_LIMIT a thread
        # renders without one, so fetching its body was a round trip thrown away
        rendered = 0
        for t in threads:
            li = t["latest_inbound"]
            fresh = any(m["message_id"] in new_ids
                        for m in t["msgs"] if m.get("bucket"))
            # a --from slice is one sender's mail and is small by construction,
            # and it is asked for precisely to READ it. The 800-char cap that
            # keeps a full-window pull skimmable truncates the one message the
            # slice was run for, so the caps lift here and only here. Every
            # message in the thread, not just the latest: the answer to "what
            # did they say about X" is regularly three replies up.
            if args.from_addr:
                for m in t["msgs"]:
                    if m.get("bucket"):
                        m["atts"] = []
                        m["fence"] = fetch_fence_text(
                            M, m["uid"], cap_lines=400, cap_chars=20000,
                            att_dir=args.att_dir, att_prefix=_att_prefix(m),
                            atts_out=m["atts"])
            elif fresh or args.show_all:
                rendered += 1
                if li is None or rendered > FENCE_LIMIT:
                    continue
                li["atts"] = []
                li["fence"] = fetch_fence_text(
                    M, li["uid"], att_dir=args.att_dir,
                    att_prefix=_att_prefix(li), atts_out=li["atts"])
        return msgs, own, inbound, counts, seen, new_ids, threads

    try:
        # One reconnect on a dropped or stalled connection (#50). Reads are safe to
        # repeat, and the header cache already holds every chunk that arrived, so the
        # second session asks only for the UIDs the first did not get.
        for attempt in (1, 2):
            try:
                with postman.imap_session(pw, ident["sender"],
                                          ident.get("imap_host")) as M:
                    pulled = pull(M)
                break
            except (imaplib.IMAP4.abort, OSError) as e:
                if attempt == 2:
                    raise
                print(f"postman inbox: {type(e).__name__}: {e}. Reconnecting once, "
                      f"{len(cache.get('headers', {}))} header(s) kept.",
                      file=sys.stderr, flush=True)
            finally:
                save_header_cache(ident, cache)
    except (imaplib.IMAP4.error, InboxError, OSError) as e:
        print(f"postman inbox: {e}", file=sys.stderr)
        return 1
    if pulled is None:
        return 0
    msgs, own, inbound, counts, seen, new_ids, threads = pulled
    new_entries = suggest_registrations(inbound, registry)
    if new_entries:
        save_registry(ident, registry | new_entries)
    header = {"messages": len(msgs), "own": len(own), "inbound": len(inbound),
              **counts}
    text = render_inbox(ident["name"], args.days, datetime.now(), threads, header,
                        new_ids, [m for m in inbound if m["bucket"] == "unaccounted"],
                        registry, show_all=args.show_all,
                        full_thread=bool(args.from_addr))
    # a --from pull saw one sender's slice, not the window, so it must not touch
    # seen.json: marking that slice seen would silently suppress every OTHER new
    # message from the next full pull, which is the one lie this mode never tells.
    if args.from_addr:
        print(f"postman inbox: --from {args.from_addr}, so this is a slice and not "
              f"the window. inbox.md and seen.json were left alone.", file=sys.stderr)
        # stdout is cp1252 on this machine, and real mail routinely carries
        # characters it cannot encode: curly quotes, en dashes, accented names.
        # Without this the print raises UnicodeEncodeError and the ENTIRE slice is
        # lost after the fetch has already been paid for, which is the one failure
        # this path cannot afford (a real slice died exactly here once).
        # write_outputs already writes UTF-8, so only the stdout branch needs it.
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
        print(text)
    else:
        write_outputs(ident, text, seen | {m["message_id"] for m in inbound
                                           if m["message_id"]})
    # the reconciliation line every run ends with (spec section 6); attribute()
    # already exits non-zero on a bucket mismatch. The mailbox is named because a
    # reader cannot otherwise tell an INBOX-scoped pull from an All Mail one, and the
    # difference is whether "no reply" means anything (issue 2026-08-13)
    print(f"read {all_mail} | "
          f"{len(msgs)} messages | {len(own)} own | {len(inbound)} inbound | "
          f"{counts['attributed']} attributed | {counts['unaccounted']} unaccounted "
          f"| {counts['ignored']} ignored | {len(new_ids)} new | "
          # not unconditional: a --from run writes nothing, and a line claiming
          # 'inbox.md written' when the file was never touched sends the next reader
          # to a stale file, or to no file at all, believing it is this run's output
          + (f"slice printed to stdout, nothing written"
             if args.from_addr else f"{store_dir(ident) / 'inbox.md'} written"))
    if args.att_dir:
        # path None means selected-but-not-written, which only happens without
        # --attachments, so it can never reach this branch. Filtered anyway: a count
        # that says "saved" must count files that exist.
        saved = [a for t in threads for m in t["msgs"]
                 for a in (m.get("atts") or []) if a[2]]
        # named individually, not just counted: the point of the flag is to open the
        # files afterwards, and a bare count sends the reader hunting for the paths
        print(f"attachments: {len(saved)} saved to {args.att_dir}")
        for name, n, path in saved:
            print(f"  {n // 1024:>6} KB  {path}")
    return 0


SEARCH_LIMIT = 40


def search_mail(M, query, limit=SEARCH_LIMIT, out=sys.stdout):
    """Gmail's own search, run on the server: UID SEARCH X-GM-RAW on All Mail, then
    fetch the hits and nothing else. Prints one Date | From | Subject line per hit,
    each URL in its plain and html parts under it, and returns the total hit count.

    This is what "find the link in my mailbox" needs. A window pull fetches every
    message in the window, and a 400-day pull for one booking link (one round trip per
    message at the time) was still running when it was killed on 2026-09-24. The same answer came back in seconds
    from X-GM-RAW (issue #23). Readonly SELECT, BODY.PEEK: nothing is marked read."""
    all_mail = postman.special_folder(M, "\\All")
    common.open_mailbox(M, all_mail, InboxError)
    # an IMAP quoted string: a Gmail phrase query ("exact words") carries its own
    # double quotes, and an unescaped one ends the string early
    quoted = '"%s"' % query.replace("\\", "\\\\").replace('"', '\\"')
    typ, data = M.uid("SEARCH", "X-GM-RAW", quoted)
    if typ != "OK":
        raise InboxError(f"SEARCH X-GM-RAW failed: {typ} {data}")
    uids = (data[0] or b"").split()
    shown = uids[-limit:] if limit > 0 else uids     # UIDs ascend, so the newest hits
    print(f"{len(uids)} match(es) for {query!r} in {all_mail}"
          + (f", showing the newest {len(shown)}" if len(shown) < len(uids) else ""),
          file=out, flush=True)
    for n, uid in enumerate(shown, 1):
        raw = common.fetched(*M.uid("FETCH", uid, BODY_FETCH))
        if raw is None:
            print(f"[{n}/{len(shown)}] uid {uid.decode()}: fetch failed", file=out, flush=True)
            continue
        h = parse_message(raw)
        print(f"[{n}/{len(shown)}] {h['date_raw']} | {h['from_raw']} | {h['subject']}",
              file=out, flush=True)
        urls = set()
        try:
            for part in email.message_from_bytes(
                    raw, policy=email.policy.default).walk():
                if part.get_content_type() in ("text/plain", "text/html"):
                    # unescaped, so an href's &amp; reads as the & a browser follows
                    urls.update(URL_RE.findall(htmllib.unescape(part.get_content())))
        except Exception:
            pass                          # the header line above still stands
        for url in sorted(urls):
            print(f"    {url}", file=out)
    return len(uids)


def search_main(argv):
    import argparse
    ap = argparse.ArgumentParser(
        prog="postman search",
        description="Gmail search (X-GM-RAW) over All Mail, server-side. Prints Date, "
                    "From, Subject and URLs for the hits only. Read-only.")
    ap.add_argument("identity")
    ap.add_argument("query", help="ordinary Gmail syntax, quoted: "
                                  "'from:vendor.example (booking OR portal)'")
    ap.add_argument("--limit", type=int, default=SEARCH_LIMIT,
                    help=f"fetch only the newest N hits (default {SEARCH_LIMIT}, 0 = all)")
    args = ap.parse_args(argv)
    if not args.query.isascii():
        # imaplib sends arguments as ASCII and would die mid-command with a traceback
        print("postman search: the query must be ASCII (non-ASCII needs an IMAP "
              "literal, which this does not send)", file=sys.stderr)
        return 1
    ident = postman.resolve_identity(args.identity, None)
    print(f"reading as: {ident['sender']}  (identity: {ident['name']})")
    try:
        pw = postman.gmail_password(ident)
    except SystemExit as e:
        print(f"postman search: {e}", file=sys.stderr)
        return 2                # the same 2 = credentials, 1 = IMAP split as inbox
    # stdout is cp1252 here and subjects carry curly quotes and accented names
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    try:
        with postman.imap_session(pw, ident["sender"], ident.get("imap_host")) as M:
            search_mail(M, args.query, args.limit)
    except (imaplib.IMAP4.error, InboxError, OSError) as e:
        print(f"postman search: {e}", file=sys.stderr)
        return 1
    return 0
