"""Live round-trip test for reply threading. Needs the mailbox, so it is not --selftest.

    POSTMAN_TEST_IDENTITY=<name> python test_threading_live.py

The identity defaults to the one marked default in your identities.json. Its app
password resolves the same way every other mode resolves one: POSTMAN_PW_<NAME> if
exported, otherwise the identity's pw_cmd.

What it proves, end to end, against the real Gmail account:

  leg A  our own sent copy is found, so a venue that never replied still threads onto the
         original enquiry rather than arriving as a second conversation
  leg B  an inbound reply is found and PREFERRED over our sent copy, and its References
         chain is carried forward

Both legs use a subject long enough to fold across header lines, and the test ASSERTS the
fold is present before asserting the match. That order matters: without it a green run
proves nothing, which is how the 11 Aug 2026 bug survived a passing unit test and silently
unthreaded 9 of 11 venue emails.

Leg B's inbound message is written with the fold BY HAND, byte for byte as Outlook sent it,
and APPENDed to INBOX, since the alternative is waiting for a human to press reply. Appending
is also the only way to control the fold: leaving it to the server made the fold appear on one
run and not the next.

Everything this test creates carries a Message-ID at STRAY_HOST and is binned on the way out,
including a sweep on the way IN so a crashed run cannot pollute the next one. Note that
`+FLAGS \\Deleted` on INBOX only drops the INBOX label and Gmail keeps the message in All
Mail, where the next lookup finds it. Run 2 of this test threaded onto run 1's leftover
exactly that way. `+X-GM-LABELS \\Trash` is what actually bins it.
"""
import email
import email.header
import email.utils
import imaplib
import os
import sys
import time

sys.path.insert(0, os.path.join(
    os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "skills", "postman"))
import postman  # noqa: E402

# resolved once. No hardcoded name: whichever identity you point it at is the one
# whose real mailbox this test sends through.
IDENT = postman.resolve_identity(os.environ.get("POSTMAN_TEST_IDENTITY"), None)
TEST_TO = postman.test_to(IDENT)

TOKEN =f"{int(time.time())}-{os.getpid()}"
# ONE canonical subject. Every leg derives from it, because the first cut of this test
# double-prefixed "[TEST] " on the sent copy only, and then nothing matched anything.
# Long on purpose: 'Subject: ' plus this is well past 78 columns, so real mailers fold it.
SUBJ = ("[TESTTHREAD] Private client dinner for 100 - September 2026 availability & quote, "
        f"threading check {TOKEN}")
STRAY_HOST = "stray.test"
INBOUND_MID = f"<threadtest-{TOKEN}@{STRAY_HOST}>"
PRIOR_REFS = f"<enquiry-original-{TOKEN}@mail.example.com>"

BATCH = f"""## @threadtest | Thread Test <{TEST_TO}>
Source: gmail.com, read {time.strftime('%Y-%m-%d')}
Subject: RE: {SUBJ}

Hi there,

Threading regression check {TOKEN}. Nothing here needs an answer.

Thank you.
"""

# The fold is deliberate and hand-placed, mirroring the real bytes from the venue reply
# that exposed the bug: a CRLF and one space in the middle of the subject.
_head, _tail = SUBJ.split("availability & ", 1)
INBOUND = (
    f"From: {TEST_TO}\r\n"
    f"To: {IDENT['sender']}\r\n"
    f"Subject: Re: {_head}availability &\r\n {_tail}\r\n"
    f"Message-ID: {INBOUND_MID}\r\n"
    f"In-Reply-To: {PRIOR_REFS}\r\n"
    f"References: {PRIOR_REFS}\r\n"
    f"Date: {email.utils.formatdate(localtime=True)}\r\n"
    "MIME-Version: 1.0\r\n"
    'Content-Type: text/plain; charset="utf-8"\r\n'
    "\r\n"
    f"Threading regression check {TOKEN}, inbound leg. Disposable.\r\n"
).encode("utf-8")

results = []


def check(name, ok, detail=""):
    results.append(("PASS" if ok else "FAIL", name, detail))
    print(f"  [{'PASS' if ok else 'FAIL'}] {name}" + (f"  {detail}" if detail else ""))
    return ok


def raw_subject(M, mailbox, criteria, subj):
    """(raw Subject bytes, Message-ID) for the newest match, or (None, None).

    Never searches on Message-ID for our own sent mail: Gmail REWRITES the Message-ID of
    anything sent through its SMTP, so the id build_message carried never reaches the
    mailbox. That rewrite is why an earlier cut of this test reported a false pass, comparing
    a None against a None.
    """
    typ, _ = M.select(mailbox, readonly=True)
    if typ != "OK":
        return None, None
    typ, data = M.search(None, *criteria)
    for uid in reversed((data[0] or b"").split()[-30:]):
        typ, d = M.fetch(uid, "(BODY.PEEK[HEADER.FIELDS (SUBJECT)] "
                              "BODY.PEEK[HEADER.FIELDS (MESSAGE-ID)])")
        if typ != "OK":
            continue
        blocks = [p[1] for p in d if isinstance(p, tuple)]
        if not blocks:
            continue
        subj_raw = next((b for b in blocks if b.lower().startswith(b"subject:")), b"")
        mid_raw = next((b for b in blocks if b.lower().startswith(b"message-id:")), b"")
        if not postman.subject_matches(email.message_from_bytes(subj_raw), subj):
            continue
        return subj_raw, (email.message_from_bytes(mid_raw).get("Message-ID") or "").strip()
    return None, None


def is_folded(raw):
    """True when this raw 'Subject: ...' block wraps over more than one line."""
    if not raw:
        return False
    value = raw.split(b":", 1)[1].strip(b"\r\n")
    return b"\r\n" in value or b"\n" in value


def show(raw):
    return raw.decode(errors="replace").strip().replace("\r\n", " <FOLD> ") if raw else "-"


"""Search terms that actually find this test's artefacts.

`HEADER MESSAGE-ID "stray.test"` finds NOTHING on Gmail: its IMAP search is
word-indexed and will not substring-match inside a Message-ID, so an earlier cut of this
cleanup reported "binned 0" on every run while four synthetic messages piled up in All Mail.
A full Message-ID does match, and so does a SUBJECT word, so the sweep uses those. Scoping
every term to the test address as well keeps a stray SUBJECT word from ever touching real mail.
"""
SWEEPS = [
    ("FROM", f'"{TEST_TO}"', "SUBJECT", '"threading"'),
    ("TO", f'"{TEST_TO}"', "SUBJECT", '"threading"'),
    ("FROM", f'"{TEST_TO}"', "SUBJECT", '"TESTTHREAD"'),
    ("TO", f'"{TEST_TO}"', "SUBJECT", '"TESTTHREAD"'),
]


def trash_strays(M):
    """Bin every artefact this test has ever created, from every mailbox it can reach."""
    binned = set()
    for mailbox in ("INBOX", postman.ALL_MAIL, postman.SENT):
        typ, _ = M.select(mailbox)
        if typ != "OK":
            continue
        for criteria in SWEEPS + [("HEADER", "MESSAGE-ID", f'"{INBOUND_MID}"')]:
            typ, data = M.search(None, *criteria)
            if typ != "OK":
                continue
            for uid in (data[0] or b"").split():
                # (\Trash) with ONE backslash, parenthesised: Gmail wants a label LIST, and
                # "\\\\Trash" in source is two backslashes, which is BAD Could not parse command.
                M.store(uid, "+X-GM-LABELS", "(\\Trash)")
                binned.add((mailbox, uid))
    return len(binned)


def strays_remaining(M):
    """Post-condition for the sweep. A cleanup that cannot be seen to work has not worked."""
    left = 0
    for mailbox in ("INBOX", postman.ALL_MAIL, postman.SENT):
        if M.select(mailbox)[0] != "OK":
            continue
        for criteria in SWEEPS:
            typ, data = M.search(None, *criteria)
            left += len((data[0] or b"").split()) if typ == "OK" else 0
    return left


def main():
    pw = postman.gmail_password(IDENT)
    rec = postman.parse_batch(BATCH)[2][0]
    assert postman.is_reply(rec), "the test batch must be a reply, or nothing threads"
    print(f"token {TOKEN}\nsubject is {len(SUBJ) + 4} chars with the RE:, so it folds\n")

    M = imaplib.IMAP4_SSL(postman.IMAP_HOST)
    M.login(IDENT["sender"], pw)
    stale = trash_strays(M)
    if stale:
        print(f"binned {stale} leftover artifact(s) from an earlier run first\n")

    try:
        print("leg A: our own sent copy, for a venue that never replied")
        msg = postman.build_message(rec, IDENT, to=TEST_TO)
        built_mid = msg["Message-ID"]
        postman.smtp_send(msg, pw)
        print(f"  sent to {TEST_TO}")

        raw = mid_sent = None
        for attempt in range(12):
            raw, mid_sent = raw_subject(M, postman.SENT,
                                        ("TO", f'"{TEST_TO}"'), SUBJ)
            if raw:
                break
            time.sleep(5)
        check("sent copy reaches Sent Mail", raw is not None)
        check("its stored Subject really is folded", is_folded(raw), show(raw))
        check("Gmail rewrote the Message-ID, so it is read back not assumed",
              bool(mid_sent) and built_mid is None, f"mailbox has {mid_sent!r}")
        mid, refs = postman.thread_headers(M, rec)
        check("thread_headers finds our sent copy despite the fold", mid == mid_sent,
              f"got {mid!r}")

        print("\nleg B: an inbound reply, which must win over our sent copy")
        typ, _ = M.append("INBOX", "", imaplib.Time2Internaldate(time.time()), INBOUND)
        check("inbound reply appended to INBOX", typ == "OK")
        raw_in, mid_in = raw_subject(M, "INBOX", ("HEADER", "MESSAGE-ID",
                                                 f'"{INBOUND_MID}"'), SUBJ)
        check("the inbound Subject is folded as Outlook folded it", is_folded(raw_in),
              show(raw_in))
        mid, refs = postman.thread_headers(M, rec)
        check("thread_headers prefers the inbound reply", mid == INBOUND_MID, f"got {mid!r}")
        check("References carries the prior message forward", PRIOR_REFS in (refs or ""),
              f"got {refs!r}")
        check("the chain ends with the message being replied to",
              (refs or "").endswith(INBOUND_MID))

        print("\nthe headers that would actually go out")
        out = postman.build_message(rec, IDENT, in_reply_to=mid, references=refs)
        check("In-Reply-To is set", out["In-Reply-To"] == INBOUND_MID)
        check("References is set too", out["References"] == refs,
              "Outlook threads on References, so one without the other threads only for us")

        print("\nregression: an unrelated thread must NOT match")
        other = postman.parse_batch(BATCH.replace(f"RE: {SUBJ}",
                                                  f"RE: Some other enquiry {TOKEN}"))[2][0]
        check("a different subject finds nothing", postman.thread_headers(M, other)[0] is None)
    finally:
        print(f"\nbinned {trash_strays(M)} test artefact(s)")
        check("the sweep really emptied the mailbox of test artefacts",
              strays_remaining(M) == 0, f"{strays_remaining(M)} left behind")
        M.logout()

    bad = [r for r in results if r[0] == "FAIL"]
    print(f"\n{len(results) - len(bad)}/{len(results)} passed")
    for _, name, detail in bad:
        print(f"  FAILED: {name} {detail}")
    if not bad:
        print("live threading round trip: OK")
        print(f"one real [TESTTHREAD] email was sent to {TEST_TO} and is still there.")
    return 1 if bad else 0


if __name__ == "__main__":
    sys.exit(main())
