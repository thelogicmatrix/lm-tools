"""Pre-send preflight for a postman batch: gates AND threading, before anything is sent.

The 11 Aug round reported its threading outcome after the send, which is too late to be a
decision. This runs the same lookup read-only so the answer arrives while the send is still
a choice.

    python preflight.py BATCH

Nothing runs at import, so the selftest imports this and calls main() against fakes.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent))
import postman                                  # noqa: E402


def main(argv=None):
    """1 when a reply would send unthreaded, else 0."""
    argv = sys.argv[1:] if argv is None else argv
    if len(argv) != 1:
        raise SystemExit("usage: python preflight.py BATCH")
    ident_name, _, recs = postman.parse_batch(
        Path(argv[0]).read_text(encoding="utf-8"))
    ident = postman.resolve_identity(None, ident_name)
    # the credential read follows the parse: which vault item to open is a property of the
    # batch's Identity: line, so a malformed batch now fails before the vault is touched.
    # The bootstrap itself now lives in postman.gmail_password - this file used to be the
    # only place that had one, which is what every other caller kept re-implementing.
    pw = postman.gmail_password(ident)

    print(f"sending as: {ident['sender']}  (identity: {ident['name']})")
    print(f"{len(recs)} block(s)\n")

    print("voice")
    for r in recs:
        hits = postman.check_voice(r["body_md"] + "\n" + r.get("subject", ""))
        print(f"  {r['slug']:20s} {'clean' if not hits else hits}")

    print("\nlayer 1 + 2, MX and provenance")
    rows = postman.verify(recs)
    postman.print_table(rows)

    print("\nthreading, read-only, the check that was missing on 11 Aug")
    # the shared session helper: the identity's host, the timeout, and one line instead
    # of a traceback when the mailbox stalls or drops
    with postman.read_failed("preflight", "Nothing was sent."), \
            postman.imap_session(pw, ident["sender"], ident.get("imap_host")) as M:
        unthreaded, amend, replies = threading(recs, M)

    print()
    if amend:
        print(f"{len(amend)} thread(s) still awaiting a reply: {', '.join(amend)}. Not a "
              f"block. Re-read those blocks and make the amendment explicit before sending.")
    if unthreaded:
        print(f"HOLD: {', '.join(unthreaded)} would send unthreaded. Ask before sending.")
        return 1
    if replies:
        print("every reply would thread. Safe to send on approval.")
    else:
        print("no replies in this batch - nothing to thread. Cold blocks gate on Source:.")
    return 0


def threading(recs, M):
    """The two IMAP reports. Returns (unthreaded slugs, awaiting slugs, reply blocks)."""
    unthreaded = []
    # replies only. A cold email has no thread to find by definition, so looping every
    # block put one HOLD on the screen per cold recipient and exited 1 on any batch that
    # mixed the two - a preflight that always fails is a preflight nobody reads.
    replies = [r for r in recs if postman.is_reply(r)]
    for r in replies:
        mid, refs = postman.thread_headers(M, r)
        if mid:
            print(f"  {r['slug']:20s} THREADS onto "
                  f"...@{mid.split('@')[-1].rstrip('>'):40s} chain {len(refs.split())}")
        else:
            unthreaded.append(r["slug"])
            print(f"  {r['slug']:20s} NO THREAD - would start a new conversation")

    # Not a gate. On 2026-08-13 round 4 restated round 3's ask with new dates two hours
    # later and 11 venues had to work out which mail counted. The fix is in how the mail
    # is WRITTEN, so this reports which threads are still waiting on us and the writer
    # decides.
    print("\nreply status, so a change to an unanswered mail reads as one")
    amend = []
    for r in replies:
        when = postman.awaiting_reply(M, r)
        if when:
            amend.append(r["slug"])
            # astimezone() with no argument is local time. The Date header carries the
            # sender's own offset, so printing it raw showed a 15:27 SGT send as "00:27"
            # and read as a different mail entirely.
            print(f"  {r['slug']:20s} AWAITING since {when.astimezone():%d %b %H:%M} - "
                  f"amend that mail, do not restate it with new numbers")
        else:
            # None covers two cases, answered and never-written-to, and this branch
            # cannot tell them apart. It says only what it knows.
            print(f"  {r['slug']:20s} nothing of ours awaiting, this is the next turn")
    return unthreaded, amend, replies


if __name__ == "__main__":
    sys.exit(main())
