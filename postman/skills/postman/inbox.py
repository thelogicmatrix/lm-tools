#!/usr/bin/env python3
"""Postman read path - inbox pull, attribution, inbox.md. See SKILL.md."""
import email
import email.header
import email.policy
import imaplib
import json
import os
import re
import sys
from datetime import date, datetime, timedelta
from email.utils import getaddresses, parsedate_to_datetime
from pathlib import Path

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
DOC_EXTS = {".pdf", ".doc", ".docx", ".xls", ".xlsx", ".ppt", ".pptx",
            ".csv", ".rtf", ".txt", ".zip"}
MIN_IMAGE_BYTES = 500_000

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


def _atomic_write(path, text):
    """Temp file, then rename. Both output files use this: a half-written store is
    worse than a missing one."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8", newline="")
    tmp.replace(path)


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
    _atomic_write(store_dir(ident) / "registry.json",
                  json.dumps(reg, indent=1, sort_keys=True) + "\n")


def load_seen(ident):
    return set(_load_json(store_dir(ident) / "seen.json", []))


def save_seen(ident, seen):
    _atomic_write(store_dir(ident) / "seen.json", json.dumps(sorted(seen)))


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


def decode_snippet(raw_bytes):
    """Whitespace-collapsed first 2000 body bytes. Keyword fodder for a consumer's
    classifier, not a rendering - same semantics as the the ad-hoc script this replaced."""
    if not isinstance(raw_bytes, (bytes, bytearray)):
        return ""
    return " ".join(raw_bytes.decode("utf-8", errors="replace").split())


def fetch_window(M, mailbox, days, with_snippets=False, from_addr=None):
    """Every message in mailbox since <days> ago, readonly.

    Raises InboxError when the mailbox is broken (messages found, none fetchable) -
    printing an empty result there would read as a quiet mailbox, which is the one
    lie this mode exists to never tell. A genuinely empty window returns [].

    from_addr narrows the SEARCH server-side instead of fetching the window and
    filtering it here. That is not a nicety. The loop below is one round trip per
    UID, so a 12,501 message window was headed for over two hours on 2026-08-15
    when the actual question was "what has this one counterparty sent me" and the
    answer was a handful of messages. SEARCH FROM cuts the UID list before FETCH.
    """
    typ, _ = M.select(mailbox, readonly=True)
    if typ != "OK":
        raise InboxError(f"SELECT {mailbox} failed: {typ}")
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
    uids = (data[0] or b"").split()
    out, skipped = [], 0
    # A silent run looks identical to a hung one. This measured 3m14s on a 721 message
    # mailbox printing nothing at all, and was killed at 100s and 120s on the assumption
    # it had hung - one of those kills produced a wrong "dead credential" diagnosis that
    # ran for most of a session. stderr, so it never contaminates the --json stream on
    # stdout, and only on a window big enough to be slow, so the tests stay quiet.
    loud = len(uids) >= PROGRESS_EVERY
    if loud:
        print(f"postman inbox: {mailbox}: {len(uids)} message(s) to fetch",
              file=sys.stderr, flush=True)
    for n, uid in enumerate(uids, 1):
        if loud and (n % PROGRESS_EVERY == 0 or n == len(uids)):
            print(f"postman inbox: {mailbox}: {n}/{len(uids)}",
                  file=sys.stderr, flush=True)
        typ, d = M.uid("FETCH", uid, HEADER_FIELDS)
        if typ != "OK" or not d or not isinstance(d[0], tuple):
            skipped += 1
            continue
        msg = parse_message(d[0][1])
        msg["uid"] = uid.decode()
        if with_snippets:
            btyp, braw = M.uid("FETCH", uid, "(BODY.PEEK[TEXT]<0.2000>)")
            msg["snippet"] = decode_snippet(braw[0][1]) if (
                btyp == "OK" and braw and isinstance(braw[0], tuple)) else ""
        out.append(msg)
    if uids and not out:
        raise InboxError(
            f"{mailbox}: {len(uids)} message(s) found, none fetchable - "
            f"mailbox/connection problem, not an empty inbox")
    if skipped:
        print(f"postman inbox: skipped {skipped} malformed fetch(es) in {mailbox}",
              file=sys.stderr)
    return out


TAG_RE = re.compile(r"<[^>]+>")


def save_attachments(msg, att_dir, prefix):
    """Write msg's real attachments under att_dir, return [(name, nbytes, path)].

    Called from fetch_fence_text with the message it ALREADY fetched: the fence
    fetch is a full BODY.PEEK[], which is the whole MIME tree, so pulling the
    attachment out of it costs no extra IMAP round trip. A separate pass would
    double the per-message cost of the one path that is already the expensive one.
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
        safe = re.sub(r"[^A-Za-z0-9._-]+", "_", name)[:120]
        dest = Path(att_dir) / f"{prefix}__{safe}"
        dest.parent.mkdir(parents=True, exist_ok=True)
        dest.write_bytes(payload)
        out.append((name, len(payload), str(dest)))
    return out


def _att_lines(m):
    """An attachment named in inbox.md but not on disk is worse than silence - the
    reader quotes a proposal they never opened. So this renders only what was
    actually written, and names the path so it can be opened."""
    return [f"- attachment: {name} ({n // 1024} KB) -> {path}"
            for name, n, path in m.get("atts") or []]


def _att_prefix(m):
    """Sender domain, so a saved file names its counterparty. inbox.py has no batch
    to read slugs from - the domain is the only stable identity in the read path."""
    return re.sub(r"[^A-Za-z0-9._-]+", "_",
                  (m.get("from_addr") or "unknown").rsplit("@", 1)[-1]) or "unknown"


def fetch_fence_text(M, uid, cap_lines=12, cap_chars=800,
                     att_dir=None, att_prefix="", atts_out=None):
    """Plain-text body of ONE message, for the quoted fence in inbox.md. Fetched in
    full only for each rendered thread's latest inbound message, so the pull stays
    cheap. Lifted mechanically - batch.md carries these bytes verbatim, so a
    paraphrase here is a counterparty misquoted there."""
    typ, d = M.uid("FETCH", uid.encode(), "(BODY.PEEK[])")
    if typ != "OK" or not d or not isinstance(d[0], tuple):
        return ""
    # a missing fence loses one section; a raise loses the whole pull. The strict
    # default policy over arbitrary real-world MIME raises far more than the narrow
    # band this used to catch (a charset of "\x00" is a ValueError out of
    # get_content), and the caller's except band does not cover it - so one malformed
    # venue message would discard a finished ~4-minute pull. The fence is cosmetic.
    try:
        msg = email.message_from_bytes(d[0][1], policy=email.policy.default)
        # out-param rather than a second return value: every existing caller wants
        # the text alone, and a conditional tuple return would make them all branch
        # on a flag to read a string.
        if att_dir is not None and atts_out is not None:
            atts_out.extend(save_attachments(msg, att_dir, att_prefix))
        part = msg.get_body(preferencelist=("plain", "html"))
        if part is None:
            return ""
        try:
            text = part.get_content()
        except (KeyError, LookupError, UnicodeDecodeError):
            payload = part.get_payload(decode=True)
            text = payload.decode("utf-8", errors="replace") if payload else ""
        if part.get_content_subtype() == "html":
            # ponytail: crude tag strip, no HTML parser; upgrade if a real venue's
            # fence text arrives unreadable
            text = TAG_RE.sub(" ", text)
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
    _atomic_write(store_dir(ident) / "inbox.md", text)
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
                         "named '<sender-domain>__<filename>'. Documents always; "
                         "images only above 500 KB, so signature logos stay out. "
                         "Pair with --from to sweep one counterparty's whole thread.")
    ap.add_argument("--from", dest="from_addr", metavar="ADDR",
                    help="narrow the IMAP SEARCH to one sender address or domain, "
                         "server-side. Use it for 'what has X sent me' on a big "
                         "mailbox: the full window costs one round trip per message.")
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
    try:
        with postman.imap_session(pw, ident["sender"]) as M:
            if args.as_json:
                # All Mail, not INBOX, for the same reason the render path uses it: an
                # archived thread has left INBOX entirely and archiving is normal
                # behaviour, so an INBOX read cannot tell "they never wrote back" from
                # "I archived it". Measured 2026-08-13: All Mail is a strict superset
                # of INBOX and of Sent (0 ids in either that it does not carry), so the
                # separate SENT fetch it used to need is now redundant.
                # Only inbound is emitted - All Mail carries every sent message too, and
                # the consumer's triage keys on the sender, so our own outbound would arrive as
                # threads that can never match. No store is written: a sweep from the consumer
                # must not eat inbox.md's 'new' markers.
                msgs = fetch_window(M, postman.ALL_MAIL, args.days, with_snippets=True,
                                    from_addr=args.from_addr)
                inbound = [m for m in msgs if m["from_addr"] != sender]
                own = [m for m in msgs if m["from_addr"] == sender]
                attribute(inbound, own, registry)
                json.dump(to_json_stream(inbound), sys.stdout)
                return 0
            msgs = fetch_window(M, postman.ALL_MAIL, args.days,
                                from_addr=args.from_addr)
            own = [m for m in msgs if m["from_addr"] == sender]
            inbound = [m for m in msgs if m["from_addr"] != sender]
            counts = attribute(inbound, own, registry)
            seen = load_seen(ident)
            new_ids = {m["message_id"] for m in inbound
                       if m["message_id"] and m["message_id"] not in seen}
            threads = group_threads(own, inbound)
            # full body only for each rendered thread's latest inbound message
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
                elif li is not None and (fresh or args.show_all):
                    li["atts"] = []
                    li["fence"] = fetch_fence_text(
                        M, li["uid"], att_dir=args.att_dir,
                        att_prefix=_att_prefix(li), atts_out=li["atts"])
    except (imaplib.IMAP4.error, InboxError, OSError) as e:
        print(f"postman inbox: {e}", file=sys.stderr)
        return 1
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
    print(f"read {postman.ALL_MAIL} | "
          f"{len(msgs)} messages | {len(own)} own | {len(inbound)} inbound | "
          f"{counts['attributed']} attributed | {counts['unaccounted']} unaccounted "
          f"| {counts['ignored']} ignored | {len(new_ids)} new | "
          # not unconditional: a --from run writes nothing, and a line claiming
          # 'inbox.md written' when the file was never touched sends the next reader
          # to a stale file, or to no file at all, believing it is this run's output
          + (f"slice printed to stdout, nothing written"
             if args.from_addr else f"{store_dir(ident) / 'inbox.md'} written"))
    if args.att_dir:
        saved = [a for t in threads for m in t["msgs"] for a in (m.get("atts") or [])]
        # named individually, not just counted: the point of the flag is to open the
        # files afterwards, and a bare count sends the reader hunting for the paths
        print(f"attachments: {len(saved)} saved to {args.att_dir}")
        for name, n, path in saved:
            print(f"  {n // 1024:>6} KB  {path}")
    return 0


def selftest():
    import tempfile
    with tempfile.TemporaryDirectory() as td:
        ident = {"sender": "ada.personal@example.com", "store": Path(td) / "postman",
                 "name": "plain"}
        # store_dir creates the directory; the stores default to empty, not to a crash
        assert store_dir(ident).is_dir()
        assert load_registry(ident) == {}
        assert load_seen(ident) == set()
        # round-trip both stores
        save_registry(ident, {"a@b.example": {"owner": "autumn-gala", "label": "grandhall"}})
        assert load_registry(ident)["a@b.example"]["owner"] == "autumn-gala"
        save_seen(ident, {"<m1@x>", "<m2@x>"})
        assert load_seen(ident) == {"<m1@x>", "<m2@x>"}
        # atomic write leaves no tmp file behind and the content is exact
        p = Path(td) / "postman" / "inbox.md"
        _atomic_write(p, "# Inbox\n")
        assert p.read_text(encoding="utf-8") == "# Inbox\n"
        assert not list((Path(td) / "postman").glob("*.tmp"))
    # parse_message: display/addr split, folded subject unfolded, refs collected from
    # both References and In-Reply-To. The fold is the 2026-08-11 unthreading bytes.
    raw = (b"From: Dana R. <Dana.r@venuegroup.example>\r\n"
           b"To: ada@example.com, events@example.com\r\n"
           b"Subject: RE: Private client dinner for 100 - September 2026 availability &\r\n"
           b" quote\r\n"
           b"Date: Tue, 11 Aug 2026 14:22:00 +0800\r\n"
           b"Message-ID: <m3@venuegroup.example>\r\n"
           b"References: <m1@example.com> <m2@venuegroup.example>\r\n"
           b"In-Reply-To: <m2@venuegroup.example>\r\n")
    m = parse_message(raw)
    assert m["from_addr"] == "dana.r@venuegroup.example", m["from_addr"]
    assert m["from_display"] == "Dana R."
    assert "<" not in m["from_addr"]                      # bare, like rec["to"]
    assert m["to_addrs"] == ["ada@example.com", "events@example.com"]
    assert m["subject"].endswith("availability & quote"), m["subject"]  # unfolded
    assert m["message_id"] == "<m3@venuegroup.example>"
    assert m["refs"] == {"<m1@example.com>", "<m2@venuegroup.example>"}
    assert m["when"].day == 11 and m["when"].month == 8
    # a dateless, header-poor message still parses rather than crashing the pull
    m2 = parse_message(b"From: news@jobboard.example\r\nSubject: Jobs for you\r\n")
    assert m2["when"] is None and m2["refs"] == set() and m2["to_addrs"] == []
    assert m2["from_display"] == ""                        # no display name given
    # snippet: whitespace-collapsed, never raises - byte-compatible with the consumer
    # contract (same decode_body semantics as the script this replaced)
    assert decode_snippet(b"line one\r\n  line\ttwo\r\n") == "line one line two"
    assert decode_snippet(None) == ""
    assert decode_snippet(b"\xff\xfebad") != ""            # errors=replace, no raise

    # One fake IMAP covers the fetch loop, the never-lie raise and the fence. It
    # answers M.uid() and nothing else, so a regression back to sequence-number
    # M.search/M.fetch fails here with AttributeError rather than shipping.
    alt = (b"From: Dana R. <Dana.r@venuegroup.example>\r\n"
           b"Subject: RE: quote\r\n"
           b'Content-Type: multipart/alternative; boundary="b1"\r\n\r\n'
           b"--b1\r\nContent-Type: text/plain\r\n\r\n"
           b"Table for one hundred confirmed\r\n\r\n"
           b"--b1\r\nContent-Type: text/html\r\n\r\n"
           b"<p>Table for one hundred confirmed</p>\r\n--b1--\r\n")

    class FakeIMAP:
        def __init__(self, uids=b"41", body=alt):
            self.uids, self.body = uids, body

        def select(self, mailbox, readonly=False):
            return ("OK", None)

        def uid(self, cmd, *args):
            if cmd == "SEARCH":
                return ("OK", [self.uids])
            if self.body is None:                     # every fetch fails
                return ("NO", None)
            spec = args[-1]
            if "HEADER" in spec:
                return ("OK", [(b"41", raw)])
            if "TEXT" in spec:
                return ("OK", [(b"41", b"snippet   body\r\n")])
            return ("OK", [(b"41", self.body)])

    M = FakeIMAP()
    got = fetch_window(M, "INBOX", INBOX_DAYS, with_snippets=True)
    assert len(got) == 1 and got[0]["uid"] == "41", got
    assert got[0]["from_addr"] == "dana.r@venuegroup.example"
    assert got[0]["snippet"] == "snippet body", got[0]["snippet"]
    # the fence takes the PLAIN alternative, not the html one. get_body/get_content
    # are EmailMessage-only, so dropping policy=email.policy.default from
    # fetch_fence_text fails this assert instead of crashing on a real venue's reply.
    assert fetch_fence_text(M, "41") == "Table for one hundred confirmed", \
        fetch_fence_text(M, "41")
    # a malformed body degrades to no fence, it never kills the pull. This charset
    # makes get_content raise ValueError - outside the narrow band the inner except
    # catches, and outside the caller's (IMAP4.error, InboxError, OSError) band too,
    # so before the broad guard one bad venue message discarded a finished pull.
    bad = b'Content-Type: text/plain; charset="\x00"\r\n\r\nhello'
    # attachments: a real doc is kept at any size, a small image is dropped as a
    # signature logo. Getting this backwards silently fills the directory with
    # banners and buries the one proposal that mattered.
    att = email.message_from_string("""From: a@b.example
Subject: s
MIME-Version: 1.0
Content-Type: multipart/mixed; boundary=X

--X
Content-Type: text/plain

body
--X
Content-Type: application/pdf
Content-Disposition: attachment; filename="Quote 2026.pdf"

tiny
--X
Content-Type: image/png
Content-Disposition: attachment; filename="logo.png"

small
--X--
""", policy=email.policy.default)
    with tempfile.TemporaryDirectory() as ad:
        got_att = save_attachments(att, ad, "b.example")
        assert [n for n, _, _ in got_att] == ["Quote 2026.pdf"], got_att
        assert Path(got_att[0][2]).name == "b.example__Quote_2026.pdf", got_att
        assert Path(got_att[0][2]).read_bytes() == b"tiny"
    assert _att_lines({"atts": got_att})[0].startswith(
        "- attachment: Quote 2026.pdf")
    assert _att_prefix({"from_addr": "a.person@agency.example"}) == "agency.example"
    assert fetch_fence_text(FakeIMAP(body=bad), "41") == ""
    assert fetch_fence_text(FakeIMAP(body=b"Content-Type: \x00garbage"), "41") == ""
    # never lie: messages found but none fetchable is an error, NOT an empty inbox
    try:
        fetch_window(FakeIMAP(body=None), "INBOX", INBOX_DAYS)
        raise AssertionError("unfetchable mailbox reported as an empty one")
    except InboxError:
        pass
    # a genuinely empty window is genuinely empty
    assert fetch_window(FakeIMAP(uids=b""), "INBOX", INBOX_DAYS) == []

    # attribution fixture: 7 messages, every layer exercised
    def _msg(frm_disp, frm_addr, to, subj, mid, refs=frozenset()):
        return {"from_raw": f"{frm_disp} <{frm_addr}>", "from_display": frm_disp,
                "from_addr": frm_addr, "to_addrs": list(to), "subject": subj,
                "date_raw": "", "when": None, "message_id": mid, "refs": set(refs)}

    me = "ada@example.com"
    registry = {
        # one domain, one owner, ONE label - the spec section 10 case: the label is
        # unambiguous, so it rides along into the suggestion
        "careers@acme.example": {"owner": "tracker", "label": "app-412"},
        "hr@acme.example": {"owner": "tracker", "label": "app-412"},
        "news@jobboard.example": {"owner": "ignore"},
        # one domain, one owner, TWO labels - the venuegroup case: owner suggestable,
        # label not
        "dana.r@venuegroup.example": {"owner": "autumn-gala", "label": "grandhall"},
        "sales@venuegroup.example": {"owner": "autumn-gala", "label": "venue-group"},
    }
    fixture = [
        _msg("Ada Lovelace", me, ["enquiry@bistro.example"], "Dinner for 100", "<s1@example>"),
        _msg("Ada Lovelace", me, ["dana.r@venuegroup.example"],
             "RE: Private client dinner", "<s2@example>"),          # own, inside a thread
        _msg("Bistro Sales", "enquiry@bistro.example", [me],
             "RE: Dinner for 100", "<i1@bistro>", {"<s1@example>"}),  # layer 1 by refs
        _msg("Bistro Sales", "enquiry@bistro.example", [me],
             "Re: Dinner for 100", "<i2@bistro>"),                 # layer 1 by (addr, subj)
        _msg("Acme Careers", "careers@acme.example", [me],
             "Your application", "<i3@acme>"),                    # layer 2 exact
        _msg("New Contact", "new.person@venuegroup.example", [me],
             "Wedding enquiry", "<i4@1g>"),                       # domain guess: owner only
        _msg("Job Board", "news@jobboard.example", [me], "Jobs", "<i5@li>"),   # ignored
        _msg("Stranger", "hello@nowhere.example", [me], "Hi", "<i6@nw>"),  # unaccounted
    ]
    own = [m for m in fixture if m["from_addr"] == me]
    inbound = [m for m in fixture if m["from_addr"] != me]
    assert len(own) == 2 and len(inbound) == 6            # layer 0 partition
    counts = attribute(inbound, own, registry)
    by = {m["message_id"]: m for m in inbound}
    assert by["<i1@bistro>"]["attribution"]["via"] == "thread"
    assert by["<i2@bistro>"]["attribution"]["via"] == "thread"     # base_subject match
    assert by["<i3@acme>"]["attribution"] == {"via": "registry", "owner": "tracker",
                                              "label": "app-412"}
    sug = by["<i4@1g>"]["attribution"]
    assert sug["via"] == "suggested" and sug["owner"] == "autumn-gala" and sug["label"] is None
    assert by["<i5@li>"]["bucket"] == "ignored"
    assert by["<i6@nw>"]["bucket"] == "unaccounted"

    # domain-level entries: '@dom' covers every address at dom, and an exact address
    # still overrides its own domain - the case that keeps one real human visible at an
    # otherwise-ignored vendor
    dom_reg = {
        "@vendor.example": {"owner": "ignore"},
        "real.human@vendor.example": {"owner": "autumn-gala", "label": "catering"},
        "@venue.example": {"owner": "autumn-gala", "label": "venue"},
    }
    dom_fix = [
        _msg("No Reply", "no-reply@vendor.example", [me], "Invoice", "<d1@v>"),
        _msg("Billing", "billing@vendor.example", [me], "Invoice 2", "<d2@v>"),
        _msg("A Human", "real.human@vendor.example", [me], "Quote", "<d3@v>"),
        _msg("Venue", "anyone@venue.example", [me], "Availability", "<d4@w>"),
    ]
    dcounts = attribute(dom_fix, [], dom_reg)
    dby = {m["message_id"]: m for m in dom_fix}
    assert dby["<d1@v>"]["bucket"] == "ignored", "a domain ignore must cover no-reply@"
    assert dby["<d2@v>"]["bucket"] == "ignored", "and every other address at it"
    assert dby["<d3@v>"]["attribution"] == {"via": "registry", "owner": "autumn-gala",
                                            "label": "catering"}, \
        "an exact address must beat its own domain's ignore"
    assert dby["<d4@w>"]["attribution"] == {"via": "registry-domain", "owner": "autumn-gala",
                                            "label": "venue"}
    assert dcounts == {"attributed": 2, "unaccounted": 0, "ignored": 2}, dcounts
    # a domain entry is a decision, so it must never be re-suggested back into the file
    assert suggest_registrations(dom_fix, dom_reg) == {}
    # the accounting identity, asserted not assumed (spec section 6):
    # messages = own + inbound, inbound = attributed + unaccounted + ignored
    assert counts == {"attributed": 4, "unaccounted": 1, "ignored": 1}, counts
    assert len(fixture) == len(own) + len(inbound)
    assert len(inbound) == sum(counts.values())
    # suggestion write-back: only the new suggested entry, never an overwrite
    new_entries = suggest_registrations(inbound, registry)
    assert set(new_entries) == {"new.person@venuegroup.example"}
    assert new_entries["new.person@venuegroup.example"] == {
        "owner": "autumn-gala", "suggested": True}
    # spec section 10, the other half: one owner AND one label on the domain, so the
    # label carries into the suggestion, the written entry and the render tag. Kept
    # off the shared fixture so the counts above stay the ones the spec states.
    cold = [_msg("Acme Talent", "talent@acme.example", [me], "Role for you", "<i8@acme>")]
    attribute(cold, [], registry)
    assert cold[0]["attribution"] == {"via": "suggested", "owner": "tracker",
                                      "label": "app-412"}, cold[0]["attribution"]
    assert suggest_registrations(cold, registry) == {
        "talent@acme.example": {"owner": "tracker", "suggested": True,
                                "label": "app-412"}}
    cold_text = render_inbox("work", 30, datetime(2026, 8, 13, 9, 2),
                             group_threads([], cold),
                             {"messages": 1, "own": 0, "inbound": 1, "attributed": 1,
                              "unaccounted": 0, "ignored": 0},
                             new_ids=set(), unaccounted=[], registry=registry,
                             show_all=True)
    assert "[suggested: tracker/app-412]" in cold_text, cold_text

    # give the fixture messages real datetimes so ordering is testable
    from datetime import timezone as _tz
    for i, m in enumerate(fixture):
        m["when"] = datetime(2026, 8, 5 + i, 12, 0, tzinfo=_tz.utc)
        m["fence"] = f"body of {m['message_id']}"
    threads = group_threads(own, inbound)
    tby = {(t["addr"], t["subject"]): t for t in threads}
    # both bistro messages plus our own opener share one thread, base-subject keyed
    bistro = tby[("enquiry@bistro.example", "Dinner for 100")]
    assert [m["message_id"] for m in bistro["msgs"]] == \
        ["<s1@example>", "<i1@bistro>", "<i2@bistro>"]
    assert bistro["latest_inbound"]["message_id"] == "<i2@bistro>"
    # an ignored sender never becomes a thread section
    assert not any(t["addr"] == "news@jobboard.example" for t in threads)
    # render: counts line, [NEW] marker, mechanical fence lift, unaccounted named
    unacc = [m for m in inbound if m["bucket"] == "unaccounted"]
    header_counts = {"messages": len(fixture), "own": len(own),
                     "inbound": len(inbound), **counts}
    # i4 is in new_ids too so the venuegroup thread renders and the [suggested:] tag is
    # actually exercised - by default only threads with something NEW render
    text = render_inbox("work", 30, datetime(2026, 8, 13, 9, 2), threads,
                        header_counts, new_ids={"<i2@bistro>", "<i4@1g>"},
                        unaccounted=unacc, registry=registry)
    assert "# Inbox: work" in text and "window 30 days" in text
    assert ("messages 8 | inbound 6 | own outbound 2 | attributed 4 | "
            "unaccounted 1 | ignored 1") in text
    assert "new since last pull: 2" in text
    assert "[NEW]" in text
    assert "```quoted" in text and "body of <i2@bistro>" in text  # lifted verbatim
    assert "hello@nowhere.example" in text                       # unaccounted named
    assert "[suggested: autumn-gala]" in text                            # flagged guess
    # registry label wins the slug; unregistered falls back to the domain's first
    # dot-segment
    assert "## @grandhall | " in text or "## @venue-group | " in text or \
        "## @venuegroup | " in text
    # a thread ENDING in our own reply: the fence still shows latest_inbound, so
    # 'earlier' must exclude the FENCED message, not the positional last - otherwise
    # the quoted message renders twice and our own last reply never appears
    reply = _msg("Ada Lovelace", me, ["enquiry@bistro.example"], "Re: Dinner for 100",
                 "<s3@example>")
    reply["when"] = datetime(2026, 8, 13, 12, 0, tzinfo=_tz.utc)
    bistro["msgs"].append(reply)
    text2 = render_inbox("work", 30, datetime(2026, 8, 13, 9, 2), threads,
                         header_counts, new_ids=set(), unaccounted=[],
                         registry=registry, show_all=True)
    assert text2.count("body of <i2@bistro>") == 1, "fenced message duplicated in earlier:"
    earlier_line = next(ln for ln in text2.splitlines()
                        if ln.startswith("earlier: ") and "Bistro Sales 7 Aug" in ln)
    assert "you 13 Aug" in earlier_line, earlier_line   # our own last reply is listed
    assert "8 Aug" not in earlier_line, earlier_line    # <i2@bistro> is the fence only
    # bounded render. inbox.md is read by a model, so its size is a context budget:
    # on 2026-08-16 the jobhunt file hit 4.3 MB (~1.07M tokens) off an empty
    # registry. Past the caps a thread keeps its heading and roll-up and loses only
    # the quoted body, the unaccounted tail is truncated with a count, and the file
    # SAYS it was trimmed - a trimmed file that reads as whole is the failure mode.
    assert "TRIMMED:" not in text2, "untrimmed render must not claim a trim"
    big, many_unacc = threads * 4, unacc * 3
    _fl, _ul = FENCE_LIMIT, UNACCOUNTED_LIMIT
    globals()["FENCE_LIMIT"], globals()["UNACCOUNTED_LIMIT"] = 2, 1
    try:
        capped = render_inbox("work", 30, datetime(2026, 8, 13, 9, 2), big,
                              header_counts, new_ids=set(), unaccounted=many_unacc,
                              registry=registry, show_all=True)
    finally:
        globals()["FENCE_LIMIT"], globals()["UNACCOUNTED_LIMIT"] = _fl, _ul
    assert capped.count("```quoted") == 2, capped.count("```quoted")   # == FENCE_LIMIT
    assert capped.count("## @") == len(big), "a trimmed thread must keep its heading"
    assert "TRIMMED:" in capped and f"{len(big) - 2} thread(s)" in capped
    assert f"and {len(many_unacc) - 1} more unaccounted" in capped
    # write order: inbox.md lands even when the seen-store write dies - ids must
    # re-report, never vanish (spec section 3)
    with tempfile.TemporaryDirectory() as td2:
        ident2 = {"sender": me, "store": Path(td2) / "postman", "name": "work"}
        real_save = globals()["save_seen"]
        globals()["save_seen"] = lambda *a: (_ for _ in ()).throw(OSError("disk"))
        try:
            write_outputs(ident2, "# Inbox\n", {"<x@y>"})
        except OSError:
            pass
        finally:
            globals()["save_seen"] = real_save
        assert (Path(td2) / "postman" / "inbox.md").exists(), \
            "inbox.md must be written BEFORE the seen-store"
        assert load_seen(ident2) == set()
        write_outputs(ident2, "# Inbox\n", {"<x@y>"})
        assert load_seen(ident2) == {"<x@y>"}

    # a hand-edited registry entry is mixed case; from_addr is always lowercased, so
    # without normalisation on BOTH sides an 'ignore' entry silently never ignores
    mixed = _msg("Job Board", "news@jobboard2.example", [me], "Jobs", "<i7@li>")
    attribute([mixed], [], {"News@Jobboard2.example": {"owner": "ignore"}})
    assert mixed["bucket"] == "ignored", mixed["bucket"]

    # the consumer contract: per-message, the four legacy keys byte-for-byte in spirit
    # (a consumer feeds this straight into its own triage), two additive keys
    oj = to_json_stream([dict(fixture[2], snippet="We regret to inform")])
    assert set(oj[0]) == {"from", "subject", "date", "snippet", "thread_id",
                          "attribution"}, set(oj[0])
    assert oj[0]["from"] == "Bistro Sales <enquiry@bistro.example>"
    assert oj[0]["snippet"] == "We regret to inform"
    assert oj[0]["thread_id"] == "enquiry@bistro.example|dinner for 100"
    assert oj[0]["attribution"]["via"] == "thread"
    # an own-outbound message (no bucket ever set) emits attribution None, not a crash
    assert to_json_stream([fixture[0]])[0]["attribution"] is None
    # missing credential is exit 2 (a consumer tells 2=creds from 1=IMAP), and the
    # unknown-identity error still names the known ones.
    # POSTMAN_NO_VAULT is load-bearing here, not decoration: without it the helper
    # resolves the password, this assertion runs a LIVE mailbox pull and dumps it to
    # stdout. That is not a test, it is an exfiltration.
    ident = postman.resolve_identity(None, None)
    os.environ.pop(postman.pw_env(ident), None)
    os.environ["POSTMAN_NO_VAULT"] = "1"
    try:
        assert inbox_main([ident["name"], "--json"]) == 2
    finally:
        os.environ.pop("POSTMAN_NO_VAULT", None)
    try:
        inbox_main(["nope"])
    except SystemExit as e:
        assert ident["name"] in str(e), str(e)
    else:
        raise AssertionError("unknown identity did not raise")
    print("inbox selftest: OK")
