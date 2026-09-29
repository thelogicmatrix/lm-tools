"""Offline tests for inbox.py, the read path. `python postman.py --selftest` runs this
file and test_postman.py. Every mailbox here is a fake, and identities come from
support.fixture_home().

The methods are numbered because they ran as one function before #53 and still run in
that order. Each one stands alone.
"""
import email
import imaplib
import io
import os
import re
import sys
import tempfile
import unittest
from datetime import datetime
from pathlib import Path
from unittest import mock

SKILL = Path(__file__).resolve().parent.parent / "skills" / "postman"
sys.path.insert(0, str(SKILL))
import postman                                  # noqa: E402
import common                                   # noqa: E402
import inbox                                    # noqa: E402
import support                                  # noqa: E402


def setUpModule():
    # enterModuleContext is 3.11+, addModuleCleanup is 3.8+, README says 3.9.
    ctx = support.fixture_home()
    ctx.__enter__()
    unittest.addModuleCleanup(ctx.__exit__, None, None, None)


REPLY_RAW = (b"From: Dana R. <Dana.r@venuegroup.example>\r\n"
             b"To: ada@example.com, events@example.com\r\n"
             b"Subject: RE: Private client dinner for 100 - September 2026 availability &\r\n"
             b" quote\r\n"
             b"Date: Tue, 11 Aug 2026 14:22:00 +0800\r\n"
             b"Message-ID: <m3@venuegroup.example>\r\n"
             b"References: <m1@example.com> <m2@venuegroup.example>\r\n"
             b"In-Reply-To: <m2@venuegroup.example>\r\n")


class InboxTest(unittest.TestCase):
    def test_01_stores_and_parse(self):
        raw = REPLY_RAW
        import tempfile
        with tempfile.TemporaryDirectory() as td:
            ident = {"sender": "ada.personal@example.com", "store": Path(td) / "postman",
                     "name": "plain"}
            # store_dir creates the directory; the stores default to empty, not to a crash
            assert inbox.store_dir(ident).is_dir()
            assert inbox.load_registry(ident) == {}
            assert inbox.load_seen(ident) == set()
            # round-trip both stores
            inbox.save_registry(ident, {"a@b.example": {"owner": "autumn-gala", "label": "grandhall"}})
            assert inbox.load_registry(ident)["a@b.example"]["owner"] == "autumn-gala"
            inbox.save_seen(ident, {"<m1@x>", "<m2@x>"})
            assert inbox.load_seen(ident) == {"<m1@x>", "<m2@x>"}
            # atomic write leaves no tmp file behind and the content is exact
            p = Path(td) / "postman" / "inbox.md"
            common.atomic_write(p, "# Inbox\n")
            assert p.read_text(encoding="utf-8") == "# Inbox\n"
            assert not list((Path(td) / "postman").glob("*.tmp"))
        # parse_message: display/addr split, folded subject unfolded, refs collected from
        # both References and In-Reply-To. The fold is the 2026-08-11 unthreading bytes.
        m = inbox.parse_message(raw)
        assert m["from_addr"] == "dana.r@venuegroup.example", m["from_addr"]
        assert m["from_display"] == "Dana R."
        assert "<" not in m["from_addr"]                      # bare, like rec["to"]
        assert m["to_addrs"] == ["ada@example.com", "events@example.com"]
        assert m["subject"].endswith("availability & quote"), m["subject"]  # unfolded
        assert m["message_id"] == "<m3@venuegroup.example>"
        assert m["refs"] == {"<m1@example.com>", "<m2@venuegroup.example>"}
        assert m["when"].day == 11 and m["when"].month == 8
        # a dateless, header-poor message still parses rather than crashing the pull
        m2 = inbox.parse_message(b"From: news@jobboard.example\r\nSubject: Jobs for you\r\n")
        assert m2["when"] is None and m2["refs"] == set() and m2["to_addrs"] == []
        assert m2["from_display"] == ""                        # no display name given
        # snippet: whitespace-collapsed body text, never raises
        assert inbox.decode_snippet(b"Subject: s\r\n\r\nline one\r\n  line\ttwo\r\n") \
            == "line one line two"
        assert inbox.decode_snippet(None) == ""
        assert inbox.decode_snippet(b"Subject: s\r\n\r\n\xff\xfebad") != ""   # no raise

    def test_02_fetch_fence_search_attachments(self):
        raw = REPLY_RAW
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
                    return ("OK", [(b"1 (UID 41 BODY[HEADER] {99}", raw), b")"])
                return ("OK", [(b"1 (UID 41 BODY[] {99}", self.body), b")"])

        M = FakeIMAP()
        got = inbox.fetch_window(M, "INBOX", inbox.INBOX_DAYS, with_snippets=True)
        assert len(got) == 1 and got[0]["uid"] == "41", got
        assert got[0]["from_addr"] == "dana.r@venuegroup.example"
        assert got[0]["snippet"] == "Table for one hundred confirmed", got[0]["snippet"]

        # Issue #11: text is extracted from the MIME part FIRST and the text is cut, not
        # the raw bytes. This fake honours the section and the <start.len> partial of
        # every FETCH the way a real server does, so the pre-fix BODY.PEEK[TEXT]<0.2000>
        # read gets exactly the 2000 raw bytes it asked for and fails both asserts below.
        class RangeIMAP:
            def __init__(self, raw):
                self.raw = raw

            def select(self, mailbox, readonly=False):
                return ("OK", None)

            def uid(self, cmd, *args):
                if cmd == "SEARCH":
                    return ("OK", [b"7"])
                spec = args[-1]
                head, _, text = self.raw.partition(b"\r\n\r\n")
                data = (head + b"\r\n\r\n" if "HEADER" in spec
                        else text if "[TEXT]" in spec else self.raw)
                rng = re.search(r"<(\d+)\.(\d+)>", spec)
                if rng:
                    data = data[int(rng[1]):int(rng[1]) + int(rng[2])]
                return ("OK", [(b"1 (UID 7 BODY[] {99}", data), b")"])

        # an html-only mail whose head and inline CSS run past the old 2000-byte window,
        # the shape that reduced a real rejection to 12 characters of markup
        css = "".join(f".c{i}{{color:#{i:06x};margin:0 auto}}\r\n" for i in range(120))
        html_mail = ("From: Talent Team <careers@hiring.example>\r\n"
                     "Subject: Application Status Update\r\n"
                     "Content-Type: text/html; charset=utf-8\r\n\r\n"
                     "<!DOCTYPE html><html><head><meta charset=\"utf-8\"><title>Update</title>"
                     f"<style>{css}</style></head><body><!--[if mso]><table><![endif]-->"
                     "<p>Dear Ada,</p><p>We regret to inform you that we will not be "
                     "moving forward.</p></body></html>\r\n").encode()
        assert html_mail.index(b"We regret") > 2000              # beyond the old cut
        got = inbox.fetch_window(RangeIMAP(html_mail), "INBOX", inbox.INBOX_DAYS, with_snippets=True)
        assert got[0]["snippet"] == ("Dear Ada, We regret to inform you that we will not "
                                     "be moving forward."), got[0]["snippet"]
        # a quoted-printable part with its own headers, behind a boundary: the part
        # headers, the boundary, =3D and the soft line break must all be gone
        qp_mail = (b"From: Recruiting <jobs@fintech.example>\r\n"
                   b"Subject: Your application\r\n"
                   b'Content-Type: multipart/alternative; boundary="91ae4e6db3e6"\r\n\r\n'
                   b"--91ae4e6db3e6\r\n"
                   b"Content-Transfer-Encoding: quoted-printable\r\n"
                   b'Content-Type: text/plain; charset="utf-8"\r\n\r\n'
                   b"Your appli=\r\ncation for Analyst =3D shortlisted.\r\n"
                   b"--91ae4e6db3e6\r\n"
                   b"Content-Type: text/html; charset=utf-8\r\n\r\n"
                   b"<p>html twin</p>\r\n"
                   b"--91ae4e6db3e6--\r\n")
        got = inbox.fetch_window(RangeIMAP(qp_mail), "INBOX", inbox.INBOX_DAYS, with_snippets=True)
        assert got[0]["snippet"] == "Your application for Analyst = shortlisted.", \
            got[0]["snippet"]
        # and the cut still happens, on the text
        long_mail = b"Subject: s\r\n\r\n" + b"word " * 1000
        assert len(inbox.decode_snippet(long_mail)) == inbox.SNIPPET_CHARS

        # Issue #23: search runs X-GM-RAW on All Mail, readonly, escapes the query as an
        # IMAP quoted string, fetches only the hits, and prints each hit's header line
        # and its URLs (html entities unescaped, deduped across the two parts).
        class SearchIMAP:
            def __init__(self, hits, body):
                self.hits, self.body, self.calls = hits, body, []

            def list(self):
                return ("OK", [])                   # names nothing: the Gmail fallback

            def select(self, mailbox, readonly=False):
                self.calls.append(("SELECT", mailbox, readonly))
                return ("OK", None)

            def uid(self, cmd, *args):
                self.calls.append((cmd,) + args)
                if cmd == "SEARCH":
                    return ("OK", [self.hits])
                return ("OK", [(args[0], self.body)])

        link_mail = (b"From: Portal <mailsend@flexiportal.example>\r\n"
                     b"Subject: Your booking link\r\n"
                     b"Date: Tue, 22 Sep 2026 09:00:00 +0800\r\n"
                     b'Content-Type: multipart/alternative; boundary="b2"\r\n\r\n'
                     b"--b2\r\nContent-Type: text/plain\r\n\r\n"
                     b"Book here: https://book.flexiportal.example/r?id=1&t=2\r\n"
                     b"--b2\r\nContent-Type: text/html\r\n\r\n"
                     b'<a href="https://book.flexiportal.example/r?id=1&amp;t=2">Book</a>'
                     b'<a href="https://help.flexiportal.example/faq">FAQ</a>\r\n'
                     b"--b2--\r\n")
        import io
        S, buf = SearchIMAP(b"3 5 9", link_mail), io.StringIO()
        n = inbox.search_mail(S, 'from:flexiportal.example "booking link"', limit=2, out=buf)
        assert n == 3
        assert S.calls[0] == ("SELECT", postman.ALL_MAIL, True), S.calls[0]
        assert S.calls[1] == ("SEARCH", "X-GM-RAW",
                              '"from:flexiportal.example \\"booking link\\""'), S.calls[1]
        # the newest two hits only, and nothing fetched for the rest
        assert [c[1] for c in S.calls if c[0] == "FETCH"] == [b"5", b"9"], S.calls
        lines = buf.getvalue().splitlines()
        assert lines[0].startswith("3 match(es)") and "newest 2" in lines[0], lines[0]
        assert lines[1] == ("[1/2] Tue, 22 Sep 2026 09:00:00 +0800 | Portal "
                            "<mailsend@flexiportal.example> | Your booking link"), lines[1]
        assert lines[2:4] == ["    https://book.flexiportal.example/r?id=1&t=2",
                              "    https://help.flexiportal.example/faq"], lines
        # no hits is a count line and no fetch, not silence
        S, buf = SearchIMAP(b"", link_mail), io.StringIO()
        assert inbox.search_mail(S, "nothing", out=buf) == 0
        assert buf.getvalue().startswith("0 match(es)") and len(S.calls) == 2
        # #52: a German account's All Mail is "Alle Nachrichten". Search selects and names
        # what LIST marked \All, never the English name, which SELECT refuses there.
        class LocalSearchIMAP(SearchIMAP):
            def list(self):
                return ("OK", [b'(\\All \\HasNoChildren) "/" "[Gmail]/Alle Nachrichten"'])
        S, buf = LocalSearchIMAP(b"", link_mail), io.StringIO()
        inbox.search_mail(S, "nothing", out=buf)
        assert S.calls[0] == ("SELECT", '"[Gmail]/Alle Nachrichten"', True), S.calls[0]
        assert '"[Gmail]/Alle Nachrichten"' in buf.getvalue(), buf.getvalue()
        # the fence takes the PLAIN alternative, not the html one. get_body/get_content
        # are EmailMessage-only, so dropping policy=email.policy.default from
        # fetch_fence_text fails this assert instead of crashing on a real venue's reply.
        assert inbox.fetch_fence_text(M, "41") == "Table for one hundred confirmed", \
            inbox.fetch_fence_text(M, "41")
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
            got_att = inbox.save_attachments(att, ad, "b.example__41")
            assert [n for n, _, _ in got_att] == ["Quote 2026.pdf"], got_att
            assert Path(got_att[0][2]).name == "b.example__41__Quote_2026.pdf", got_att
            assert Path(got_att[0][2]).read_bytes() == b"tiny"
        assert inbox._att_lines({"atts": got_att})[0].startswith(
            "- attachment: Quote 2026.pdf")
        assert inbox._att_prefix({"from_addr": "a.person@agency.example", "uid": "41"})         == "agency.example__41"

        # The real 2026-08-27 regression, in the bytes that caused it. Two venue answers
        # were lost because MIN_IMAGE_BYTES was 500_000: a pasted AV screenshot and a
        # pair of emailed room photos all fell under it and were binned as signature
        # logos. Content-Disposition cannot be the discriminator - the out-of-office row
        # below is a 965 B logo declaring itself an attachment, and the two content
        # images declare themselves inline. Only size splits them, so these five sizes
        # are asserted rather than the rule that produced them.
        sizes = {
            "sig_logo_inline":     (965,     False),   # Outlook gif, inline + cid
            "sig_logo_png":        (3_662,   False),   # company logo, inline + cid
            "ooo_logo_attachment": (965,     False),   # inline logo wearing 'attachment'
            "av_screenshot":       (79_677,  True),    # vendor's AV inclusions, inline
            "room_photo":          (214_733, True),    # emailed room photo
            "venue_photo_inline":  (496_029, True),    # venue floorplan, inline + cid
        }
        for label, (nbytes, keep) in sizes.items():
            raw = "\n".join([
                "From: a@b.example",
                "Subject: s",
                "MIME-Version: 1.0",
                "Content-Type: multipart/mixed; boundary=X",
                "",
                "--X",
                "Content-Type: text/plain",
                "",
                "body",
                "--X",
                "Content-Type: image/png",
                'Content-Disposition: attachment; filename="%s.png"' % label,
                "",
                "x" * nbytes,
                "--X--",
                "",
            ])
            one = email.message_from_string(raw, policy=email.policy.default)
            got = inbox.save_attachments(one, None, "b.example__41")
            assert bool(got) is keep, f"{label} at {nbytes}B: kept={bool(got)}, want {keep}"

        # att_dir=None selects without writing, and the line says so rather than going
        # quiet. A silent drop here is exactly how the two answers above were lost.
        unsaved = inbox.save_attachments(att, None, "b.example__41")
        assert [n for n, _, _ in unsaved] == ["Quote 2026.pdf"], unsaved
        assert unsaved[0][2] is None, unsaved
        line = inbox._att_lines({"atts": unsaved})[0]
        assert "NOT SAVED" in line and "--attachments" in line, line
        assert inbox.fetch_fence_text(FakeIMAP(body=bad), "41") == ""
        assert inbox.fetch_fence_text(FakeIMAP(body=b"Content-Type: \x00garbage"), "41") == ""
        # never lie: messages found but none fetchable is an error, NOT an empty inbox
        try:
            inbox.fetch_window(FakeIMAP(body=None), "INBOX", inbox.INBOX_DAYS)
            raise AssertionError("unfetchable mailbox reported as an empty one")
        except inbox.InboxError:
            pass
        # a genuinely empty window is genuinely empty
        assert inbox.fetch_window(FakeIMAP(uids=b""), "INBOX", inbox.INBOX_DAYS) == []

    def test_03_attribution_render_and_outputs(self):
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
        counts = inbox.attribute(inbound, own, registry)
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
        dcounts = inbox.attribute(dom_fix, [], dom_reg)
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
        assert inbox.suggest_registrations(dom_fix, dom_reg) == {}
        # the accounting identity, asserted not assumed (spec section 6):
        # messages = own + inbound, inbound = attributed + unaccounted + ignored
        assert counts == {"attributed": 4, "unaccounted": 1, "ignored": 1}, counts
        assert len(fixture) == len(own) + len(inbound)
        assert len(inbound) == sum(counts.values())
        # suggestion write-back: only the new suggested entry, never an overwrite
        new_entries = inbox.suggest_registrations(inbound, registry)
        assert set(new_entries) == {"new.person@venuegroup.example"}
        assert new_entries["new.person@venuegroup.example"] == {
            "owner": "autumn-gala", "suggested": True}
        # spec section 10, the other half: one owner AND one label on the domain, so the
        # label carries into the suggestion, the written entry and the render tag. Kept
        # off the shared fixture so the counts above stay the ones the spec states.
        cold = [_msg("Acme Talent", "talent@acme.example", [me], "Role for you", "<i8@acme>")]
        inbox.attribute(cold, [], registry)
        assert cold[0]["attribution"] == {"via": "suggested", "owner": "tracker",
                                          "label": "app-412"}, cold[0]["attribution"]
        assert inbox.suggest_registrations(cold, registry) == {
            "talent@acme.example": {"owner": "tracker", "suggested": True,
                                    "label": "app-412"}}
        cold_text = inbox.render_inbox("work", 30, datetime(2026, 8, 13, 9, 2),
                                 inbox.group_threads([], cold),
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
        threads = inbox.group_threads(own, inbound)
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
        text = inbox.render_inbox("work", 30, datetime(2026, 8, 13, 9, 2), threads,
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
        text2 = inbox.render_inbox("work", 30, datetime(2026, 8, 13, 9, 2), threads,
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
        with mock.patch.multiple(inbox, FENCE_LIMIT=2, UNACCOUNTED_LIMIT=1):
            capped = inbox.render_inbox("work", 30, datetime(2026, 8, 13, 9, 2), big,
                                        header_counts, new_ids=set(), unaccounted=many_unacc,
                                        registry=registry, show_all=True)
        assert capped.count("```quoted") == 2, capped.count("```quoted")   # == FENCE_LIMIT
        assert capped.count("## @") == len(big), "a trimmed thread must keep its heading"
        assert "TRIMMED:" in capped and f"{len(big) - 2} thread(s)" in capped
        assert f"and {len(many_unacc) - 1} more unaccounted" in capped
        # write order: inbox.md lands even when the seen-store write dies - ids must
        # re-report, never vanish (spec section 3)
        with tempfile.TemporaryDirectory() as td2:
            ident2 = {"sender": me, "store": Path(td2) / "postman", "name": "work"}
            with mock.patch.object(inbox, "save_seen", mock.Mock(side_effect=OSError("disk"))):
                try:
                    inbox.write_outputs(ident2, "# Inbox\n", {"<x@y>"})
                except OSError:
                    pass
            assert (Path(td2) / "postman" / "inbox.md").exists(), \
                "inbox.md must be written BEFORE the seen-store"
            assert inbox.load_seen(ident2) == set()
            inbox.write_outputs(ident2, "# Inbox\n", {"<x@y>"})
            assert inbox.load_seen(ident2) == {"<x@y>"}

        # a hand-edited registry entry is mixed case; from_addr is always lowercased, so
        # without normalisation on BOTH sides an 'ignore' entry silently never ignores
        mixed = _msg("Job Board", "news@jobboard2.example", [me], "Jobs", "<i7@li>")
        inbox.attribute([mixed], [], {"News@Jobboard2.example": {"owner": "ignore"}})
        assert mixed["bucket"] == "ignored", mixed["bucket"]

        # the consumer contract: per-message, the four legacy keys byte-for-byte in spirit
        # (a consumer feeds this straight into its own triage), two additive keys
        oj = inbox.to_json_stream([dict(fixture[2], snippet="We regret to inform")])
        assert set(oj[0]) == {"from", "subject", "date", "snippet", "thread_id",
                              "attribution"}, set(oj[0])
        assert oj[0]["from"] == "Bistro Sales <enquiry@bistro.example>"
        assert oj[0]["snippet"] == "We regret to inform"
        assert oj[0]["thread_id"] == "enquiry@bistro.example|dinner for 100"
        assert oj[0]["attribution"]["via"] == "thread"
        # an own-outbound message (no bucket ever set) emits attribution None, not a crash
        assert inbox.to_json_stream([fixture[0]])[0]["attribution"] is None
        # missing credential is exit 2 (a consumer tells 2=creds from 1=IMAP), and the
        # unknown-identity error still names the known ones.
        # POSTMAN_NO_VAULT is load-bearing here, not decoration: without it the helper
        # resolves the password, this assertion runs a LIVE mailbox pull and dumps it to
        # stdout. That is not a test, it is an exfiltration.
        ident = postman.resolve_identity(None, None)
        os.environ.pop(postman.pw_env(ident), None)
        os.environ["POSTMAN_NO_VAULT"] = "1"
        try:
            assert inbox.inbox_main([ident["name"], "--json"]) == 2
        finally:
            os.environ.pop("POSTMAN_NO_VAULT", None)
        try:
            inbox.inbox_main(["nope"])
        except SystemExit as e:
            assert ident["name"] in str(e), str(e)
        else:
            raise AssertionError("unknown identity did not raise")

    def test_04_window_pull(self):
        ident = postman.resolve_identity(None, None)
        # #50: the window pull. Batched UID FETCH, a header cache keyed by (UIDVALIDITY,
        # UID), one reconnect on a dropped connection, and no fence past FENCE_LIMIT.
        import contextlib
        import io

        def _hdr(i):
            return (f"From: Venue {i} <v{i}@venue{i}.example>\r\nTo: ada@example.com\r\n"
                    f"Subject: Dinner {i}\r\nDate: Tue, 01 Sep 2026 09:00:00 +0800\r\n"
                    f"Message-ID: <m{i}@venue{i}.example>\r\n\r\n").encode()

        def _body(i):
            return _hdr(i) + f"Body {i}".encode()

        class WindowIMAP:
            """UIDs 1 to n. Answers like a real server: the sequence number is not the UID,
        the UID sits before the literal on odd UIDs and after it on even ones, and the
        items come back in the server's order, reversed here. Every FETCH is recorded
        as (kind, UIDs asked for). The header FETCH numbered drop_at raises abort."""

            def __init__(self, n, validity=b"7", drop_at=None, absent=()):
                self.n, self.validity, self.drop_at = n, validity, drop_at
                self.absent, self.fetches = set(absent), []

            def list(self):
                return ("OK", [])                   # names nothing: the Gmail fallback

            def select(self, mailbox, readonly=False):
                return ("OK", [str(self.n).encode()])

            def response(self, code):
                return (code, [self.validity])

            def uid(self, cmd, *args):
                if cmd == "SEARCH":
                    return ("OK", [" ".join(str(u) for u in range(1, self.n + 1)).encode()])
                asked = args[0].decode() if isinstance(args[0], bytes) else args[0]
                spec = args[-1]
                kind = ("header" if "HEADER" in spec else "snippet" if "<0." in spec
                        else "fence")
                self.fetches.append((kind, asked.split(",")))
                if kind == "header" and self.drop_at == sum(
                        k == "header" for k, _ in self.fetches):
                    raise imaplib.IMAP4.abort("socket error: EOF")
                out = []
                for u in reversed(asked.split(",")):
                    if int(u) in self.absent:
                        continue
                    data = _hdr(int(u)) if kind == "header" else _body(int(u))
                    seq = int(u) + 1000
                    if int(u) % 2:
                        out += [(f"{seq} (UID {u} BODY[] {{{len(data)}}}".encode(), data),
                                b")"]
                    else:
                        out += [(f"{seq} (BODY[] {{{len(data)}}}".encode(), data),
                                f" UID {u})".encode()]
                return ("OK", out)

        def _fw(*a, **k):
            """fetch_window with its progress lines kept off the selftest's stderr"""
            with contextlib.redirect_stderr(io.StringIO()):
                return inbox.fetch_window(*a, **k)

        # identical to the serial read, which parsed each message on its own in UID order
        _M = WindowIMAP(1000)
        _got = _fw(_M, "INBOX", inbox.INBOX_DAYS, with_snippets=True)
        assert _got == [dict(inbox.parse_message(_hdr(i)), uid=str(i),
                             snippet=inbox.decode_snippet(_body(i))) for i in range(1, 1001)]
        # round trips: the serial pull was 1000 header FETCHes and 1000 snippet FETCHes
        assert (inbox.HEADER_CHUNK, inbox.BODY_CHUNK) == (500, 200), (inbox.HEADER_CHUNK, inbox.BODY_CHUNK)
        assert [k for k, _ in _M.fetches] == ["header"] * 2 + ["snippet"] * 5, _M.fetches
        assert [len(u) for _, u in _M.fetches] == [500, 500] + [200] * 5
        # a message the server leaves out is skipped, never invented
        with contextlib.redirect_stderr(io.StringIO()) as _err:
            _got = inbox.fetch_window(WindowIMAP(5, absent={3}), "INBOX", inbox.INBOX_DAYS)
        assert [m["uid"] for m in _got] == ["1", "2", "4", "5"], _got
        assert "skipped 1" in _err.getvalue(), _err.getvalue()

        # the header cache: the second pull asks only for what is new, and returns the same
        _cache = {}
        _first = _fw(WindowIMAP(600), "INBOX", inbox.INBOX_DAYS, cache=_cache)
        assert (_cache["uidvalidity"], len(_cache["headers"])) == ("7", 600), _cache.keys()
        _M = WindowIMAP(610)
        _again = _fw(_M, "INBOX", inbox.INBOX_DAYS, cache=_cache)
        assert _M.fetches == [("header", [str(u) for u in range(601, 611)])], _M.fetches
        assert _again[:600] == _first and len(_again) == 610
        # a new UIDVALIDITY means the UIDs were reassigned: the cache is dropped, not trusted
        _M = WindowIMAP(610, validity=b"8")
        _fw(_M, "INBOX", inbox.INBOX_DAYS, cache=_cache)
        assert sum(len(u) for _, u in _M.fetches) == 610 and _cache["uidvalidity"] == "8"
        # another mailbox is another UID space
        _M = WindowIMAP(3, validity=b"8")
        _fw(_M, "Other", inbox.INBOX_DAYS, cache=_cache)
        assert sum(len(u) for _, u in _M.fetches) == 3, _M.fetches
        # a full window trims the cache to itself, a --from slice only adds
        _fw(WindowIMAP(610, validity=b"8"), "INBOX", inbox.INBOX_DAYS, cache=_cache)
        _fw(WindowIMAP(5, validity=b"8"), "INBOX", inbox.INBOX_DAYS, cache=_cache)
        assert len(_cache["headers"]) == 5, len(_cache["headers"])
        _M = WindowIMAP(8, validity=b"8")
        _fw(_M, "INBOX", inbox.INBOX_DAYS, from_addr="v1@venue1.example", cache=_cache)
        assert len(_cache["headers"]) == 8, len(_cache["headers"])
        # no UIDVALIDITY from the server: nothing is cached, because nothing proves reuse safe
        _cache = {}
        _fw(WindowIMAP(4, validity=None), "INBOX", inbox.INBOX_DAYS, cache=_cache)
        assert not _cache.get("headers"), _cache

        # through inbox_main: the connection drops on the second header chunk, one
        # reconnect resumes from the cache without asking for a fetched UID again, and
        # fences stop at FENCE_LIMIT because the rest would render without one
        _sessions = [WindowIMAP(1200, drop_at=2), WindowIMAP(1200), WindowIMAP(1201)]
        _used = []

        @contextlib.contextmanager
        def _fake_session(*a, **k):
            _used.append(_sessions.pop(0))
            yield _used[-1]
        _real_session, postman.imap_session = postman.imap_session, _fake_session
        _pw_key = postman.pw_env(ident)
        os.environ[_pw_key] = "x"
        try:
            with contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()) as _err:
                assert inbox.inbox_main([ident["name"]]) == 0, _err.getvalue()
            assert "Reconnecting once, 500 header(s) kept" in _err.getvalue(), _err.getvalue()
            _s1, _s2 = ([u for k, us in s.fetches if k == "header" for u in us]
                        for s in _used)
            assert _s1 == [str(u) for u in range(1, 1001)], len(_s1)   # the second chunk died
            assert _s2 == [str(u) for u in range(501, 1201)], _s2[:3]  # 1 to 500 were kept
            assert sum(k == "fence" for k, _ in _used[1].fetches) == inbox.FENCE_LIMIT
            _md = (inbox.store_dir(ident) / "inbox.md").read_text(encoding="utf-8")
            assert f"TRIMMED: {1200 - inbox.FENCE_LIMIT} thread(s)" in _md, _md[:400]
            assert _md.count("```quoted") == inbox.FENCE_LIMIT
            # the next run reads one new header and fences only the one new thread
            with contextlib.redirect_stdout(io.StringIO()), \
                    contextlib.redirect_stderr(io.StringIO()) as _err:
                assert inbox.inbox_main([ident["name"]]) == 0, _err.getvalue()
            assert _used[2].fetches == [("header", ["1201"]), ("fence", ["1201"])], \
                _used[2].fetches
        finally:
            postman.imap_session = _real_session
            os.environ.pop(_pw_key, None)

    def test_05_failed_fetches_are_no_fence_and_no_window(self):
        # the fence and search now read their one-message FETCH through common.fetched
        # (#53): a NO or an empty answer is no fence and a "fetch failed" line, not a crash
        class _No:
            def select(self, mailbox, readonly=False):
                return "NO", [b"no such mailbox"]

            def list(self):
                return "OK", []

            def uid(self, cmd, *args):
                # a NO that still carries a literal: only the status says it failed
                return (("OK", [b"7"]) if cmd == "SEARCH" else
                        ("NO", [(b"7 (UID 7 BODY[] {20}", b"Subject: s\r\n\r\nstale")]))
        self.assertEqual(inbox.fetch_fence_text(_No(), "41"), "")
        # a refused SELECT is an InboxError naming the mailbox, never an empty window
        with self.assertRaises(inbox.InboxError) as cm:
            inbox.fetch_window(_No(), "INBOX", 30)
        self.assertEqual(str(cm.exception), "SELECT INBOX failed: NO")
        with self.assertRaises(inbox.InboxError) as cm:
            inbox.search_mail(_No(), "dinner")
        self.assertIn("SELECT", str(cm.exception))

        class _NoFetch(_No):
            def select(self, mailbox, readonly=False):
                return "OK", [b"1"]
        buf = io.StringIO()
        self.assertEqual(inbox.search_mail(_NoFetch(), "dinner", out=buf), 1)
        self.assertIn("[1/1] uid 7: fetch failed", buf.getvalue())


if __name__ == "__main__":
    unittest.main()
