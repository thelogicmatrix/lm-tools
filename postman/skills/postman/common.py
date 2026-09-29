"""IMAP and file helpers shared by postman.py and inbox.py (#53)."""
import re
import sys

# UIDs per FETCH. 500 seven-digit UIDs is a 4 KB command line, inside the 8 KB RFC 7162
# asks a client to stay under. ponytail: a fixed size. Adapt it if a server refuses a line.
FETCH_CHUNK = 500
UID_RE = re.compile(rb"\bUID (\d+)")


def atomic_write(path, text):
    """Temp file, then rename, so a reader finds the old file or the new one and never
    half of either. UTF-8, with the newlines in text written as they are."""
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(text, encoding="utf-8", newline="")
    tmp.replace(path)


def open_mailbox(M, mailbox, fail, readonly=True):
    """SELECT mailbox, or raise fail("SELECT <mailbox> failed: <typ>"). fail is the
    exception class, or a function building one, that the caller's mode reports with."""
    typ, _ = M.select(mailbox, readonly=readonly)
    if typ != "OK":
        raise fail(f"SELECT {mailbox} failed: {typ}")
    return mailbox


def fetched(typ, data):
    """The message bytes from a FETCH of one message, or None when that FETCH failed."""
    if typ != "OK" or not data or not isinstance(data[0], tuple):
        return None
    return data[0][1]


def _by_uid(data):
    """{uid: literal bytes} from one UID FETCH answer. A server may put the UID before
    the literal or after it, so both halves of each item are read, and items are keyed
    on their UID, never on their position or sequence number."""
    out, pending = {}, None
    for part in data or []:
        if isinstance(part, tuple):
            m = UID_RE.search(part[0])
            if m:
                out[m.group(1).decode()] = part[1]
            pending = None if m else part[1]
        elif pending is not None and isinstance(part, bytes):
            m = UID_RE.search(part)
            if m:
                out[m.group(1).decode()] = pending
            pending = None
    return out


def fetch_headers(M, uids, fields, size=FETCH_CHUNK, into=None, label=None):
    """UID FETCH `fields` for uids, `size` UIDs at a time, into {uid: literal bytes}.

    fields is the FETCH item: a header list everywhere but inbox's snippet pass, which
    asks for the body. A UID the server leaves out, or a chunk it answers with anything
    but OK, is missing from the result, so the caller decides what a gap means.
    Pass into to have it filled in place as each chunk lands, so a connection that dies
    mid-pull keeps every chunk that arrived. label, when set, prints one progress line
    per chunk to stderr.
    """
    into = {} if into is None else into
    for i in range(0, len(uids), size):
        typ, d = M.uid("FETCH", ",".join(uids[i:i + size]), fields)
        if typ == "OK":
            into.update(_by_uid(d))
        if label:
            print(f"postman inbox: {label}: {min(i + size, len(uids))}/{len(uids)}",
                  file=sys.stderr, flush=True)
    return into
