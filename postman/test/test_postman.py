"""Offline tests for postman.py. `python postman.py --selftest` runs this file and
test_inbox.py.

Everything runs against support.fixture_home(), never against your real identities: a
suite that reads the live config would go red on someone else's machine for reasons that
have nothing to do with the code. IMAP and SMTP are fakes, and the one socket test talks
to a local server that never answers.

The methods are numbered because they ran as one function before #53 and still run in
that order. Each one stands alone.
"""
import contextlib
import email
import email.header
import email.utils
import imaplib
import io
import json
import os
import re
import smtplib
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import date, datetime, timedelta, timezone
from pathlib import Path
from unittest import mock

SKILL = Path(__file__).resolve().parent.parent / "skills" / "postman"
sys.path.insert(0, str(SKILL))
import postman                                  # noqa: E402
import support                                  # noqa: E402


def setUpModule():
    unittest.enterModuleContext(support.fixture_home())


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


_S = "RE: Dinner for 100"


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


class PostmanTest(unittest.TestCase):
    def test_01_identities(self):
        # resolve_identity, not identities()["branded"], so require_assets can name the
        # identity in its error message. Everything below builds against the branded one.
        work = postman.resolve_identity(None, None)
        sig_txt_path = work["assets"] / "SIGNATURE.txt"
        logo_path = work["assets"] / postman.logo_name(work)

        postman.require_assets(work)
        assert logo_path.stat().st_size > 0, "logo is empty"
        assert sig_txt_path.read_text(encoding="utf-8").strip(), "text signature is empty"
        assert postman.signature_cid(work), "no cid in signature"

        # Task 2: identities
        assert postman.resolve_identity(None, None)["sender"] == "ada@example.com"
        assert postman.resolve_identity(None, "plain")["sender"] == "ada.personal@example.com"
        # --as beats the file
        assert postman.resolve_identity("branded", "plain")["sender"] == "ada@example.com"
        # --purge is destructive and must never fire without --drafts naming a mailbox.
        # Asserted at the arg layer, so the guard cannot be lost to a refactor of main().
        try:
            postman.main(["--purge"])
        except SystemExit as e:
            assert "only applies to --drafts" in str(e), str(e)
        else:
            raise AssertionError("--purge ran without --drafts")

        try:
            postman.resolve_identity("nope", None)
        except SystemExit as e:
            assert "branded" in str(e) and "plain" in str(e), str(e)
        else:
            raise AssertionError("unknown identity did not raise")

        # the default is the one that says so, never whichever key came first
        assert postman.default_identity(postman.load_identities()) == "branded"
        assert postman.default_identity({"only": {"sender": "a@b.example"}}) == "only"
        assert postman.default_identity({"a": {}, "b": {}}) is None, \
            "two identities and no default must force --as, not guess"
        try:
            postman.default_identity({"a": {"default": True}, "b": {"default": True}})
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
            assert postman.test_to(_tt) == "declared@example.com"
            os.environ["POSTMAN_TEST_TO"] = "exported@example.com"
            assert postman.test_to(_tt) == "exported@example.com", \
                "POSTMAN_TEST_TO must beat the identity, or an export silently sends elsewhere"
            assert postman.test_to({"name": "tt"}) == "exported@example.com"
            del os.environ["POSTMAN_TEST_TO"]
            try:
                postman.test_to({"name": "tt"})
            except SystemExit as e:
                assert "POSTMAN_TEST_TO" in str(e), str(e)
            else:
                raise AssertionError("--test with nowhere to send did not raise")
        finally:
            if _prior_tt is None:
                os.environ.pop("POSTMAN_TEST_TO", None)
            else:
                os.environ["POSTMAN_TEST_TO"] = _prior_tt

    def test_02_identity_config_and_messages(self):
        work = postman.resolve_identity(None, None)
        # the shipped example is the first file a new user copies, so it is held to the same
        # loader as a real config. An example that does not load is a first-run failure for
        # everyone, and nothing else would catch it drifting away from REQUIRED_IDENTITY_KEYS.
        example = Path(postman.__file__).resolve().parent.parent.parent / ".postman" / "identities.example.json"
        assert example.exists(), f"shipped example config is missing: {example}"
        with tempfile.TemporaryDirectory() as td:
            home = Path(td) / ".postman"
            home.mkdir()
            (home / "identities.json").write_text(
                example.read_text(encoding="utf-8"), encoding="utf-8")
            prior = os.environ.get("POSTMAN_HOME")
            os.environ["POSTMAN_HOME"] = str(home)
            try:
                shipped = postman.load_identities()
                assert postman.default_identity(shipped), \
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
                postman.load_identities()
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
            msg = postman.build_message(rec, plain)
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
                postman.build_message(rec, nameless | {"assets": empty})
            except SystemExit as e:
                assert "SIGNATURE.txt" in str(e) and "ada.personal@example.com" in str(e), \
                    str(e)
            else:
                raise AssertionError("a missing signature did not raise")

        # the branded identity is unchanged: multipart/alternative with the related logo
        work_msg = postman.build_message(
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
            assert postman.attach_paths(rec, base) == [base / "resume.pdf"]
            msg = postman.build_message(rec, plain, base_dir=base)
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
            wmsg = postman.build_message(dict(rec, slug="y"), work, base_dir=base)
            assert wmsg.get_content_type() == "multipart/mixed", wmsg.get_content_type()
            assert [p.get_content_type() for p in wmsg.iter_attachments()] == \
                ["application/pdf"], [p.get_content_type() for p in wmsg.iter_attachments()]
            assert any(p.get_content_type() == "image/png" for p in wmsg.walk())

            # an .ics goes out as a real invitation: text/calendar with the METHOD the
            # file declares and CRLF endings, not the octet-stream download Gmail used
            # to offer. The source file here is LF-only, as a git checkout leaves it.
            (base / "invite.ics").write_bytes(
                b"BEGIN:VCALENDAR\nMETHOD:CANCEL\nEND:VCALENDAR\n")
            imsg = postman.build_message(dict(rec, slug="i", attach="invite.ics"), plain,
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
                postman.build_message(rec, plain)
            except postman.BatchError as e:
                assert "x" in str(e) and "base_dir" in str(e), str(e)
            else:
                raise AssertionError("Attach: with no base_dir did not raise")

            # a declared file that is not on disk is caught before anything sends
            try:
                postman.check_attachments([{"slug": "x", "attach": "gone.pdf"}], base)
            except postman.BatchError as e:
                assert "gone.pdf" in str(e) and "x" in str(e), str(e)
            else:
                raise AssertionError("a missing attachment did not raise")

            # a repeated Attach: is rejected, not last-wins: _parse_block does
            # rec[key] = value, so the first path would vanish silently
            try:
                postman.parse_batch("## @x | A B <a@b.example>\nSource: b.example/c, read 2026-08-13\n"
                            "Subject: s\nAttach: a.pdf\nAttach: b.pdf\n\nHi.\n")
            except postman.BatchError as e:
                assert "Attach" in str(e), str(e)
            else:
                raise AssertionError("a repeated Attach: did not raise")
            # the repeat guard generalises: Subject:/Source:/any header repeated is the
            # same silent last-wins overwrite Attach: was guarded against
            for dup in ("Subject: s2", "Source: b.example/d, read 2026-08-13"):
                try:
                    postman.parse_batch("## @x | A B <a@b.example>\n"
                                "Source: b.example/c, read 2026-08-13\n"
                                f"Subject: s\n{dup}\n\nHi.\n")
                except postman.BatchError as e:
                    assert "repeated" in str(e).lower(), str(e)
                else:
                    raise AssertionError(f"a repeated {dup.split(':')[0]}: did not raise")
            # a header with a whitespace-only value is a hard error, not a falsy field -
            # a whitespace 'Sent:' otherwise reads as unstamped and re-sends silently
            try:
                postman.parse_batch("## @x | A B <a@b.example>\n"
                            "Source: b.example/c, read 2026-08-13\nSubject: s\n"
                            "Sent: \t\n\nHi.\n")
            except postman.BatchError as e:
                assert "empty" in str(e).lower(), str(e)
            else:
                raise AssertionError("a whitespace-only header value did not raise")

        assert postman.attach_paths({"attach": "-"}, Path(".")) == []
        assert postman.attach_paths({}, Path(".")) == []

    def test_03_batch_parsing(self):
        # Task 2: batch parsing
        _, _, recs = postman.parse_batch(sample)
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
        ident, brief, recs2 = postman.parse_batch(sample2)
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
        ident3, brief3, recs3 = postman.parse_batch(
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
                postman.parse_batch(bad_line + "\n\n" + one_rec)
            except postman.BatchError as e:
                assert "Identity" in str(e), str(e)
            else:
                raise AssertionError(f"a malformed {bad_line!r} did not raise")
        # and the valid form still parses, with the preamble line stripped either side
        assert postman.parse_batch("Identity:   plain  \n\n" + one_rec)[0] == "plain"

        # two VALID Identity: lines is first-wins, which is the same wrong-mailbox class the
        # malformed guard above exists to prevent - one batch, one mailbox
        try:
            postman.parse_batch("Identity: plain\nIdentity: branded\n\n" + one_rec)
        except postman.BatchError as e:
            assert "plain" in str(e) and "branded" in str(e), str(e)
        else:
            raise AssertionError("two valid Identity: lines did not raise")

        # a To: field overrides the heading, for the multi-address case (three on one reply)
        _, _, recs4 = postman.parse_batch(
            "## @x | A B <a@b.example>\nTo: a@b.example, c@d.example\n"
            "Source: b.example/c, read 2026-08-13\nSubject: s\n\nHi.\n")
        assert recs4[0]["to"] == "a@b.example, c@d.example", recs4[0]["to"]
        assert postman._to_addrs(recs4[0]) == ["a@b.example", "c@d.example"]

        # a lost recipient is a hard error naming the slug, never a quiet short batch
        doctored = sample2.replace("\n---\n## @bistro", "\n## @bistro")
        try:
            postman.parse_batch(doctored)
        except postman.BatchError as e:
            assert "bistro" in str(e), str(e)
        else:
            raise AssertionError("a lost recipient block did not raise")

        # a malformed recipient heading is named, not silently treated as prose
        try:
            postman.parse_batch("## @x\nSource: b.example/c, read 2026-08-13\nSubject: s\n\nHi.\n")
        except postman.BatchError as e:
            assert "malformed recipient heading" in str(e), str(e)
        else:
            raise AssertionError("a malformed heading did not raise")

        # a multi-address To must split, because IMAP SEARCH takes one address per key and a
        # joined atom is a BAD-command abort, not a bad thread (three addresses on one reply)
        assert postman._to_addrs({"to": "a@x.example, b@y.example , c@z.example"}) == ["a@x.example", "b@y.example", "c@z.example"]
        assert postman._to_addrs({"to": "solo@x.example"}) == ["solo@x.example"]
        assert recs[0]["cc"] is None
        assert recs[0]["body_md"].startswith("Hi,")
        assert recs[1]["cc"] == "bookings@heritagehall.example"
        assert recs[1]["third_party"].startswith("Example Events Co")

        # a block missing a required header is a clear error, not a silent skip
        try:
            postman.parse_batch("## @nosubject | A B <a@b.example>\n"
                        "Source: b.example/x, read 2026-08-05\n\nHi")
        except postman.BatchError as e:
            assert "subject" in str(e).lower(), f"unhelpful error: {e}"
        else:
            raise AssertionError("a block with no Subject: must raise BatchError")

        # no Source: line at all - the load-bearing rule, so it gets its own assertion
        try:
            postman.parse_batch("## @nosource | A B <a@b.example>\nSubject: Hi\n\nHi")
        except postman.BatchError as e:
            assert "source" in str(e).lower(), f"unhelpful error: {e}"
        else:
            raise AssertionError("a block with no Source: must raise BatchError")

    def test_04_voice_gate(self):
        # Task 2: voice gate
        assert postman.check_voice("Hi, thanks for the quick reply. Thank you.") == []
        assert postman.check_voice("I hope this email finds you well.") == ["I hope this email finds you well"]
        assert postman.check_voice("Please reach out if that helps.") == ["reach out"]
        # a plain semicolon is NOT a shipped default - it is a legal English sentence, and the
        # punctuation entries that used to sit in the shipped list were one person's rules
        assert postman.check_voice("Cost is high; the date is free.") == []

    def test_05_provenance(self):
        # punctuation still works as an entry for someone who adds it to their own VOICE.md;
        # that is proven in the voice_md override block below, against a real user file

        # Task 3: layer 2
        today = date(2026, 8, 5)

        def rec(to, source, third_party=None):
            return {"slug": "t", "to": to, "source": source, "third_party": third_party}

        v, _ = postman.check_provenance(
            rec("enquiry@grandhall.example",
                "grandhall.example/corporate-dinner-dance/, read 2026-08-05"), today)
        assert v == "sourced", v

        # www. is stripped, and a subdomain of the address domain still counts as own-site
        v, _ = postman.check_provenance(
            rec("events@cityhotel.example", "https://www.cityhotel.example/weddings, read 2026-08-01"),
            today)
        assert v == "sourced", v

        # the real 2026-08-05 failure: a directory listing an address on another domain
        v, why = postman.check_provenance(
            rec("weddings@cityhotel.example",
                "venueblog.example/venues/cityhotel/, read 2026-08-05"), today)
        assert v == "unsourced", v
        assert "venueblog.example" in why and "cityhotel.example" in why, why

        # a Third-party: line is the recorded-decision escape hatch
        v, _ = postman.check_provenance(
            rec("events@heritagehall.example", "heritagehall.example/contact/, read 2026-08-05",
                third_party="Example Events Co operates the hall's events"), today)
        assert v == "sourced", v

        # freshness: 30 days passes, 31 does not
        v, _ = postman.check_provenance(rec("a@b.example", "b.example/x, read 2026-07-06"), today)
        assert v == "sourced", v
        v, why = postman.check_provenance(rec("a@b.example", "b.example/x, read 2026-07-05"), today)
        assert v == "stale", v
        assert "31" in why, why

        # a Source: with no read date is a hard error, not a soft verdict
        try:
            postman.check_provenance(rec("a@b.example", "b.example/x"), today)
        except postman.BatchError as e:
            assert "read" in str(e).lower(), e
        else:
            raise AssertionError("Source: without a read date must raise BatchError")

        assert postman.source_host("https://www.Example.COM/a/b") == "example.com"
        assert postman.source_host("example.com/a") == "example.com"

    def test_06_replies_and_the_fence(self):
        # Task 4: replies, the quoted fence, and the header rules
        reply_src = ("## @grandhall | Dana R. <dana.r@venuegroup.example>\n"
                     "Subject: RE: Private client dinner for 100\n\n"
                     "```quoted\nDana R., 11 Aug 14:22\nMinimum spend is $8,000.\n```\n\n"
                     "Hi Dana,\n\n100 guests.\n")
        _, _, rr = postman.parse_batch(reply_src)
        assert rr[0]["is_reply_block"] is True
        assert "8,000" in rr[0]["quoted"]
        # THE fence guarantee: nothing inside it reaches the body that gets sent
        assert "8,000" not in rr[0]["body_md"], rr[0]["body_md"]
        assert rr[0]["body_md"].startswith("Hi Dana,")
        # a reply gets the 'threaded' verdict and gate_or_die accepts it. has_mx is stubbed
        # around the call because '.example' is a reserved TLD that never resolves: layer 1
        # would block this on DNS and the assertion under test is a layer 2 one.
        assert postman.check_provenance(rr[0], date(2026, 8, 13))[0] == "threaded"
        with mock.patch.object(postman, "has_mx", lambda domain: True):
            rows = postman.gate_or_die(rr)
        assert rows[0]["layer2"] == "threaded", rows[0]

        # Source: on a reply is rejected - it cannot be satisfied honestly and on 11 Aug
        # all 11 were rubber-stamped bare domains that verified nothing
        try:
            postman.parse_batch(reply_src.replace("Subject: RE:",
                                          "Source: venuegroup.example, read 2026-08-13\nSubject: RE:"))
        except postman.BatchError as e:
            assert "Source" in str(e) and "grandhall" in str(e), str(e)
        else:
            raise AssertionError("Source: on a reply did not raise")

        # Subject: is required on EVERY block, replies included: thread_headers picks among
        # candidates from one address with subject_matches, and venuegroup runs two
        # deliberate parallel threads
        try:
            postman.parse_batch(reply_src.replace("Subject: RE: Private client dinner for 100\n", ""))
        except postman.BatchError as e:
            assert "subject" in str(e).lower(), str(e)
        else:
            raise AssertionError("a missing Subject: did not raise")

        # an unclosed fence is a hard error, never a fallback to sending the remainder
        try:
            postman.parse_batch(reply_src.replace("Minimum spend is $8,000.\n```", "Minimum spend."))
        except postman.BatchError as e:
            assert "fence" in str(e).lower(), str(e)
        else:
            raise AssertionError("an unclosed quoted fence did not raise")

        # a fence with no body after it never sends an empty message
        try:
            postman.parse_batch("## @x | A B <a@b.example>\nSubject: RE: s\n\n"
                        "```quoted\ntheir words\n```\n")
        except postman.BatchError as e:
            assert "empty body" in str(e) or "no body" in str(e), str(e)
        else:
            raise AssertionError("a fence with no body did not raise")

        # the two reply signals must agree: a fence with no RE: prefix is ambiguous, and
        # is_reply drives threading while the fence drives Source rejection
        try:
            postman.parse_batch(reply_src.replace("Subject: RE: Private", "Subject: Private"))
        except postman.BatchError as e:
            assert "quoted" in str(e).lower(), str(e)
        else:
            raise AssertionError("a fence without a reply subject did not raise")

        # a fence anywhere but the top is rejected too: the leading-fence check alone would
        # send it verbatim, and their words would leave as the sender's own
        for below in ("## @x | A B <a@b.example>\nSubject: RE: s\n\nHi.\n\n"
                      "```quoted\ntheir words\n```\n",
                      reply_src + "\n```quoted\nmore of their words\n```\n"):
            try:
                postman.parse_batch(below)
            except postman.BatchError as e:
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
            postman.parse_batch(inner_fence)
        except postman.BatchError as e:
            assert "x" in str(e) and "```" in str(e), str(e)
        else:
            raise AssertionError("a ``` line inside the quoted fence did not raise")

        # cold bodies are checked too: they never had a fence to extract, so nothing else in
        # the parser would ever look at a stray ``` in one
        for cold_fence in ("Hi.\n\n```\ncode\n```\n", "Hi.\n\n```python\ncode\n```\n"):
            try:
                postman.parse_batch("## @x | A B <a@b.example>\n"
                            "Source: b.example/c, read 2026-08-13\nSubject: s\n\n" + cold_fence)
            except postman.BatchError as e:
                assert "```" in str(e), str(e)
            else:
                raise AssertionError("a ``` fence in a cold body did not raise")

        # ...and a clean fenced reply is untouched by all of that
        assert postman.parse_batch(reply_src)[2][0]["quoted"].endswith("$8,000."), \
            postman.parse_batch(reply_src)[2][0]["quoted"]

        # the agreement runs both ways: a RE: subject with no fence would otherwise demand
        # Source:, and the natural unblock is a bare own-domain line that reads as 'sourced'
        # and threads anyway - the 2026-08-11 pattern the errors above cite
        try:
            postman.parse_batch("## @x | A B <a@b.example>\nSubject: RE: s\n\nHi.\n")
        except postman.BatchError as e:
            assert "fence" in str(e).lower() and "x" in str(e), str(e)
        else:
            raise AssertionError("a reply subject with no fence did not raise")
        # ...and neither side of the agreement broke: reply-with-fence and cold-without-fence
        assert postman.parse_batch(reply_src)[2][0]["is_reply_block"] is True
        cold = postman.parse_batch("## @x | A B <a@b.example>\n"
                           "Source: b.example/c, read 2026-08-13\nSubject: s\n\nHi.\n")[2][0]
        assert cold["is_reply_block"] is False and cold["quoted"] == ""

    def test_07_mx(self):
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
            _got = postman.has_mx("b.example", resolve=_res)
            assert _got is _want, f"{_script}: got {_got!r}, wanted {_want!r}"
            assert len(_calls) == _n, f"{_script}: {len(_calls)} lookups, wanted {_n}"
            assert all(c[2] == postman.MX_LIFETIME for c in _calls), _calls
        assert postman.MX_LIFETIME == 5, postman.MX_LIFETIME

        # verify: one lookup per domain, all domains at once. The barrier only opens when
        # all three lookups are in flight together, so a serial verify fails it.
        _looked, _gate = [], threading.Barrier(3, timeout=5)

        def _stub_mx(domain):
            _looked.append(domain)
            _gate.wait()
            return {"a.example": True, "b.example": False, "c.example": None}[domain]
        with mock.patch.object(postman, "has_mx", _stub_mx):
            _recs = postman.parse_batch("\n---\n".join(
                f"## @r{i} | P Q <p{i}@{d}>\nSource: {d.lower()}/x, read "
                f"{date.today():%Y-%m-%d}\nSubject: s\n\nHi.\n"
                for i, d in enumerate(["a.example"] * 10 + ["B.example", "c.example"])))[2]
            _rows = postman.verify(_recs)
        assert sorted(_looked) == ["a.example", "b.example", "c.example"], _looked
        assert [r["mx"] for r in _rows] == [True] * 10 + [False, None], _rows
        import io
        with contextlib.redirect_stdout(io.StringIO()) as _out:
            postman.print_table(_rows)
        assert "NO-MX" in _out.getvalue() and "UNKNOWN" in _out.getvalue(), _out.getvalue()
        assert "1 domain(s) did not answer DNS" in _out.getvalue(), _out.getvalue()
        # unknown still blocks, and says which it was
        with mock.patch.object(postman, "has_mx", lambda d: {"a.example": True}.get(d)):
            try:
                with contextlib.redirect_stdout(io.StringIO()):
                    postman.gate_or_die([_recs[0], _recs[11]])
            except SystemExit as e:
                assert "r11 (" in str(e) and "MX unknown" in str(e), str(e)
                assert "r0 (" not in str(e), str(e)
            else:
                raise AssertionError("an unknown MX must block the batch")

    def test_08_assembly(self):
        work = postman.resolve_identity(None, None)
        sig_html_path = work["assets"] / "SIGNATURE.html"
        sig_txt_path = work["assets"] / "SIGNATURE.txt"
        logo_path = work["assets"] / postman.logo_name(work)
        # Task 4: assembly
        built = postman.build_message(postman.parse_batch(sample)[2][0], work)
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
        expected = postman.body_to_html(postman.parse_batch(sample)[2][0]["body_md"]) + sig
        assert html_src.rstrip("\n") == expected.rstrip("\n"), \
            "html body must be exactly converted-markdown + SIGNATURE.html, concatenated"
        assert "<p>Body text here.</p>" in html_src, "markdown body missing from html part"
        # a newline inside a paragraph is a real line break. Without this the details block
        # (Guests / Dates / Budget / Timing) collapses into one run-on line in the client.
        assert "<br" in postman.body_to_html("Guests: 100\nDates: flexible"), \
            "a newline in a body must survive into the html as a line break"

        plain = built.get_body(preferencelist=("plain",)).get_content()
        assert "Body text here." in plain
        assert sig_txt_path.read_text(encoding="utf-8").strip().splitlines()[0] in plain

        # exactly one cid reference, and the attached part's Content-ID matches it
        cid = postman.signature_cid(work)
        assert html_src.count(f"cid:{cid}") == 1, "signature must reference its cid once"
        images = [p for p in built.walk() if p.get_content_maintype() == "image"]
        assert len(images) == 1, f"expected 1 inline image, got {len(images)}"
        assert images[0]["Content-ID"] == f"<{cid}>", images[0]["Content-ID"]
        assert images[0].get_payload(decode=True) == logo_path.read_bytes(), "logo bytes differ"

    def test_09_threading_headers(self):
        work = postman.resolve_identity(None, None)
        # Task 7: threading. The IMAP lookup needs a live mailbox, so what is checked here
        # is everything that decides WHETHER and WHAT to thread.
        assert postman.base_subject("RE: Dinner for 100") == "Dinner for 100"
        assert postman.base_subject("Re: Fwd: RE:Dinner for 100") == "Dinner for 100"
        assert postman.base_subject("Automatic reply: Dinner for 100") == "Dinner for 100"
        assert postman.base_subject("Dinner for 100") == "Dinner for 100"
        # a subject that merely CONTAINS 're:' is not a reply
        assert postman.base_subject("Venue re: the atrium") == "Venue re: the atrium"

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
        assert postman.header_subject(hdrs) == "RE: " + want, postman.header_subject(hdrs)
        assert postman.subject_matches(hdrs, want), "a folded subject must still match its thread"
        assert postman.base_subject(postman.header_subject(hdrs)) == want

        # MIME encoded-words unfold and decode too, since a venue may send either
        enc = email.message_from_bytes(b"Subject: =?utf-8?q?Dinner_for_100?=\r\n")
        assert postman.subject_matches(enc, "Dinner for 100"), postman.header_subject(enc)
        # and a genuinely different thread still must not match
        assert not postman.subject_matches(hdrs, "Some other enquiry entirely")
        # an autoresponder is in the thread but is not the venue talking to us
        auto = email.message_from_bytes(b"Subject: Automatic reply: " + want.encode() + b"\r\n")
        assert postman.is_autoreply(auto) and not postman.is_autoreply(hdrs)

        first = postman.parse_batch(sample)[2][0]
        assert postman.is_reply(first) is False, "a fresh enquiry must not be threaded"
        assert postman.is_reply(dict(first, subject="RE: " + first["subject"])) is True

        threaded = postman.build_message(first, work, in_reply_to="<abc@example.com>")
        assert threaded["In-Reply-To"] == "<abc@example.com>"
        # References defaults to In-Reply-To rather than being left off: Outlook threads on
        # References, so omitting it breaks threading at the venue but not for us.
        assert threaded["References"] == "<abc@example.com>"
        chained = postman.build_message(first, work, in_reply_to="<b@x>", references="<a@x> <b@x>")
        assert chained["References"] == "<a@x> <b@x>"
        assert postman.build_message(first, work)["In-Reply-To"] is None, \
            "a non-reply must carry no threading headers"

        # a banned phrase refuses the build
        bad = dict(postman.parse_batch(sample)[2][0], body_md="I hope this email finds you well.")
        try:
            postman.build_message(bad, work)
        except postman.BatchError as e:
            assert "finds you well" in str(e), e
        else:
            raise AssertionError("a banned phrase must refuse the build")

        # ...and so does one hiding in the subject, where they are likeliest to appear
        bad = dict(postman.parse_batch(sample)[2][0], subject="Do reach out about availability")
        try:
            postman.build_message(bad, work)
        except postman.BatchError as e:
            assert "subject" in str(e), e
        else:
            raise AssertionError("a banned phrase in the subject must refuse the build")

        try:
            postman.verify([bad], date(2026, 8, 5))
        except postman.BatchError:
            pass
        else:
            raise AssertionError("--verify must refuse a banned phrase in the subject")

    def test_10_unsourced_batch_refused(self):
        # Task 5: a batch with an unsourced recipient must refuse to send
        directory_batch = """## @cityhotel | Weddings <weddings@cityhotel.example>
Source: venueblog.example/venues/cityhotel/, read 2026-08-05
Subject: Enquiry

Hi,

Body.
"""
        try:
            postman.gate_or_die(postman.parse_batch(directory_batch)[2], date(2026, 8, 5))
        except SystemExit as e:
            assert "unsourced" in str(e), e
        else:
            raise AssertionError("an unsourced recipient must block the send")

        # and the clean batch passes the same gate. has_mx stubbed, not guarded on a live
        # resolver: the fixtures are .example domains that must never resolve, and a suite
        # that asks the network about someone else's domain fails for reasons that have
        # nothing to do with this code.
        with mock.patch.object(postman, "has_mx", lambda domain: True):
            postman.gate_or_die(postman.parse_batch(sample)[2], date(2026, 8, 5))

    def test_11_hunter(self):
        # Task 6: no default path may call Hunter. Layer 3 costs a credit per address, so
        # the ask being an ask is a property of the code, not of remembering to be careful.
        # Matched on the two callables, not the word: gate_or_die's error message points
        # you at --hunter, and a substring check reads that hint as a violation.
        import inspect
        for fn in (postman.verify, postman.gate_or_die, postman.build_message, postman.append_draft, postman.thread_headers):
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
                _rc = postman.main(["--hunter", "ok@b.example", "slow@b.example", "busy@b.example",
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

    def test_12_stamping_and_resume(self):
        # Task 5: stamping
        with tempfile.TemporaryDirectory() as td:
            bp = Path(td) / "batch.md"
            bp.write_text(
                "## @one | A B <a@b.example>\nSource: b.example/c, read 2026-08-13\n"
                "Subject: s1\n\nHi.\n\n---\n"
                "## @two | C D <c@d.example>\nSource: d.example/c, read 2026-08-13\n"
                "Subject: s2\n\nHi.\n", encoding="utf-8")
            postman.stamp_block(bp, "one", "2026-08-13 09:14")
            _, _, sr = postman.parse_batch(bp.read_text(encoding="utf-8"))
            assert sr[0]["sent"] == "2026-08-13 09:14", sr[0].get("sent")
            assert sr[1]["sent"] is None
            # the stamp survives a re-parse and does not corrupt the block
            assert sr[0]["body_md"] == "Hi."
            assert sr[0]["subject"] == "s1"
            # stamping the second leaves the first alone
            postman.stamp_block(bp, "two", "2026-08-13 09:15")
            _, _, sr2 = postman.parse_batch(bp.read_text(encoding="utf-8"))
            assert [r["sent"] for r in sr2] == ["2026-08-13 09:14", "2026-08-13 09:15"]
            # stamping must not translate the file's line endings: a CRLF batch that gets
            # one stamp must not arrive as a whole-file LF diff
            crlf = Path(td) / "crlf.md"
            crlf.write_bytes(
                b"## @one | A B <a@b.example>\r\nSource: b.example/c, read 2026-08-13\r\n"
                b"Subject: s1\r\n\r\nHi.\r\n")
            postman.stamp_block(crlf, "one", "2026-08-13 09:14")
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
            postman.stamp_block(lf, "one", "2026-08-13 09:14")
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
        _, _, rs = postman.parse_batch(resume_src)
        rs_pending = [r for r in rs if not r["sent"]]
        assert [r["slug"] for r in rs_pending] == ["two"], rs_pending
        # has_mx stubbed for the same reason as the reply gate above: .example never resolves
        with mock.patch.object(postman, "has_mx", lambda domain: True):
            postman.gate_or_die(rs_pending, date(2026, 8, 13))
            try:
                postman.gate_or_die(rs, date(2026, 8, 13))
            except SystemExit as e:
                assert "one" in str(e) and "stale" in str(e), str(e)
            else:
                raise AssertionError("a stale source on an unstamped block must block the send")
        with tempfile.TemporaryDirectory() as td:
            postman.check_attachments(rs_pending, Path(td))
            try:
                postman.check_attachments(rs, Path(td))
            except postman.BatchError as e:
                assert "gone.pdf" in str(e) and "one" in str(e), str(e)
            else:
                raise AssertionError("a missing attachment on an unstamped block must raise")

        # a repeated Sent: must NOT kill the parse - it blocked resuming every other block
        _, _, _ds = postman.parse_batch(
            "## @one | A B <a@b.example>\nSource: b.example/c, read 2026-08-13\n"
            "Subject: s\nSent: 2026-08-13 14:01\nSent: 2026-08-13 16:22\n\nHi.\n")
        assert _ds[0]["sent"] == "2026-08-13 14:01", \
            f"a double stamp must keep the FIRST stamp, got {_ds[0].get('sent')!r}"

        # the attachment cap is per message and measured base64-encoded
        with tempfile.TemporaryDirectory() as td:
            big = Path(td) / "big.pdf"
            big.write_bytes(b"x" * 20_000_000)          # 20 MB raw, ~26.7 MB on the wire
            _, _, _ar = postman.parse_batch(
                "## @one | A B <a@b.example>\nSource: b.example/c, read 2026-08-13\n"
                "Subject: s\nAttach: big.pdf\n\nHi.\n")
            try:
                postman.check_attachments(_ar, Path(td))
            except postman.BatchError as e:
                assert "26." in str(e) and "per-message" in str(e), str(e)
            else:
                raise AssertionError("20 MB raw is over 25 MB once base64-encoded")
            # and the same file across two recipients is two messages, not one 40 MB batch
            small = Path(td) / "small.pdf"
            small.write_bytes(b"x" * 9_000_000)         # 9 MB raw, 12 MB encoded, fine
            _, _, _ar2 = postman.parse_batch(
                "## @one | A B <a@b.example>\nSource: b.example/c, read 2026-08-13\n"
                "Subject: s\nAttach: small.pdf\n\nHi.\n---\n"
                "## @two | C D <c@d.example>\nSource: d.example/c, read 2026-08-13\n"
                "Subject: s\nAttach: small.pdf\n\nHi.\n")
            postman.check_attachments(_ar2, Path(td))           # must not raise: 12 MB each

    def test_13_awaiting_reply(self):
        # the reply check. It answers one authoring question: has our last mail on this thread
        # been answered. If it has not, the next mail has to be written as an amendment to it
        # rather than the same ask with the numbers changed, which is what went wrong on
        # 2026-08-13. It gates nothing and never blocks a send.
        class _FakeBox:
            """SENT and ALL_MAIL, each absent or holding one (hours_ago, subject)."""

            def __init__(self, sent=None, inbound=None):
                self.msgs = {postman.SENT: sent, postman.ALL_MAIL: inbound}
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

        _rec = {"slug": "grandhall", "to": "dana.r@venuegroup.example", "subject": _S}
        # we wrote 2h ago and nothing has come back: this one amends that one
        assert postman.awaiting_reply(_FakeBox(sent=(2, _S)), _rec) is not None, \
            "an unanswered send must be reported"
        # they answered after we wrote, so this is simply the next turn
        assert postman.awaiting_reply(_FakeBox(sent=(26, _S), inbound=(2, _S)), _rec) is None, \
            "a reply since our last send means nothing is awaiting"
        # their message predates our last one, so ours is still unanswered
        assert postman.awaiting_reply(_FakeBox(sent=(2, _S), inbound=(26, _S)), _rec) is not None, \
            "an older inbound does not answer a newer send"
        # we have never written to them, so there is nothing to amend
        assert postman.awaiting_reply(_FakeBox(), _rec) is None, "no prior send means nothing awaiting"
        # outside THREAD_LOOKBACK_DAYS, our old mail is not something to amend
        assert postman.awaiting_reply(_FakeBox(sent=(24 * 100, _S)), _rec) is None, \
            "a send older than the lookback is not awaiting"
        # an autoresponder is in the thread but is not the venue answering us
        assert postman.awaiting_reply(
            _FakeBox(sent=(26, _S), inbound=(2, "Automatic reply: Dinner for 100")),
            _rec) is not None, "an out-of-office is not a reply"
        # a different thread is a different conversation
        assert postman.awaiting_reply(_FakeBox(sent=(2, _S)),
                              dict(_rec, subject="Other enquiry")) is None, \
            "another thread's send is not this thread's"

    def test_14_special_folders_and_drafts(self):
        work = postman.resolve_identity(None, None)
        built = postman.build_message(postman.parse_batch(sample)[2][0], work)
        # #52: folders by SPECIAL-USE flag (RFC 6154), not by Gmail's English names. A German
        # account calls All Mail "Alle Nachrichten", and a SELECT on the English name fails
        # there, which read back as "nothing found" or died. One LIST per session.
        assert (postman.DRAFTS, postman.SENT, postman.ALL_MAIL) == ('"[Gmail]/Drafts"', '"[Gmail]/Sent Mail"',
                                            '"[Gmail]/All Mail"'), "the fallbacks moved"


        _lb = _LocalBox()
        assert postman.special_folder(_lb, "\\All") == '"[Gmail]/Alle Nachrichten"'
        assert postman.special_folder(_lb, "\\Sent") == '"[Gmail]/Gesendet"'
        # modified UTF-7 goes back to SELECT exactly as LIST sent it, never decoded
        assert postman.special_folder(_lb, "\\Drafts") == '"[Gmail]/Entw&APw-rfe"'
        assert _lb.calls.count(("LIST",)) == 1, f"one LIST per session, got {_lb.calls}"
        # every read path and the draft append use what LIST named, never the English name
        _lb = _LocalBox()
        postman.thread_headers(_lb, {"to": "a@b.example, c@d.example", "subject": "RE: x"})
        postman.awaiting_reply(_lb, {"to": "a@b.example", "subject": "RE: x"})
        postman.append_draft(built, "x", conn=_lb)
        _sel = {c[1] for c in _lb.calls if c[0] in ("SELECT", "APPEND")}
        assert _sel == {"INBOX", '"[Gmail]/Alle Nachrichten"', '"[Gmail]/Gesendet"',
                        '"[Gmail]/Entw&APw-rfe"'}, _sel
        assert _lb.calls.count(("LIST",)) == 1, "the whole session costs one LIST"
        # an unquoted atom and a NIL delimiter are both legal LIST replies
        assert postman.special_folder(_LocalBox([b"(\\Sent) NIL Sent"]), "\\Sent") == '"Sent"'
        # a LIST that marks nothing, or fails, keeps the behaviour before #52
        for _box in (_LocalBox([b'(\\HasNoChildren) "/" "INBOX"']), _LocalBox(list_typ="NO")):
            assert [postman.special_folder(_box, f) for f in ("\\All", "\\Sent", "\\Drafts")] \
                == [postman.ALL_MAIL, postman.SENT, postman.DRAFTS], _box.calls

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
                    # one FETCH for the whole set, each item tagged with its UID
                    return "OK", [(f"{u} (UID {u} BODY[HEADER]".encode(),
                                   b"To: v@venue.example\r\nSubject: Dinner "
                                   + u.encode() + b"\r\n\r\n") for u in args[0].split(",")]
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
                _rows, _f = postman.sweep_drafts("x", "a@b.example", match="dinner", purge=True)
                assert [u for u, _ in _rows] == ["1", "2", "3"], _rows
                _stores = [c for c in _db.calls if c[0] == "STORE"]
                assert _stores == [("STORE", "1,2,3", "+X-GM-LABELS", "(\\Trash)")], _stores
                assert _f == _failed, f"stuck={_stuck} typ={_typ}: {_f} failed"
                assert ("SELECT", '"[Gmail]/Entw&APw-rfe"') in _db.calls, _db.calls
            # listing only: no STORE, nothing failed
            _db = _DraftBox()
            imaplib.IMAP4_SSL = _connect(_db)
            assert postman.sweep_drafts("x", "a@b.example")[1] == 0
            assert not [c for c in _db.calls if c[0] == "STORE"]
            # through main: the final line carries the real count and the exit is non-zero
            os.environ[postman.pw_env(work)] = "x"
            imaplib.IMAP4_SSL = _connect(_DraftBox((b"3",)))
            with contextlib.redirect_stdout(io.StringIO()) as _out:
                assert postman.main(["--drafts", work["name"], "dinner", "--purge"]) == 1
            assert "2 draft(s) matching 'dinner' moved to Trash" in _out.getvalue(), \
                _out.getvalue()
            assert "1 failed" in _out.getvalue(), _out.getvalue()
            # bounces read the localized All Mail, and the summary names that folder
            imaplib.IMAP4_SSL = _connect(_LocalBox())
            with contextlib.redirect_stdout(io.StringIO()) as _out:
                postman.main(["--bounces", work["name"], "1"])
            assert '0 bounce(s) in "[Gmail]/Alle Nachrichten"' in _out.getvalue(), \
                _out.getvalue()
            # imap_host: absent is Gmail, present is used. "plain" declares one.
            os.environ[postman.pw_env(postman.resolve_identity("plain", None))] = "x"
            del _hosts[:]
            for _name in (work["name"], "plain"):
                imaplib.IMAP4_SSL = _connect(_DraftBox())
                with contextlib.redirect_stdout(io.StringIO()):
                    postman.main(["--drafts", _name])
            assert _hosts == ["imap.gmail.com", "imap.mail.example"], _hosts
        finally:
            imaplib.IMAP4_SSL = _real_ssl
            os.environ.pop(postman.pw_env(work), None)
            os.environ.pop(postman.pw_env(postman.resolve_identity("plain", None)), None)
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
                        postman.load_identities()
                    except SystemExit as e:
                        assert _needle in str(e), str(e)
                    else:
                        raise AssertionError(f"{_extra} was accepted")
            finally:
                os.environ["POSTMAN_HOME"] = _prev

    def test_15_preflight(self):
        work = postman.resolve_identity(None, None)
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

    def test_16_thread_lookup_round_trips(self):
        # #51: thread lookup round trips. Per mailbox one SELECT, then per address one SEARCH
        # and ONE FETCH for the newest SCAN_DEPTH headers, never one FETCH per message. The
        # headers are kept on the connection per (mailbox, key, address), so awaiting_reply
        # after thread_headers (what preflight does) costs nothing more.

        _v, _me = "dana.r@venuegroup.example", "ada@example.com"
        # 40 unrelated messages each way in every mailbox: the not-found (HOLD) path. This
        # was 3 x (SELECT + SEARCH + 30 FETCH) = 96 round trips per recipient.
        _noise = [(_v, _me, f"Other {i}", 500 - i, f"<n{i}@v.example>") for i in range(40)]
        _sent_noise = [(_me, _v, f"Other {i}", 500 - i, f"<s{i}@v.example>") for i in range(40)]
        _tb = _ThreadBox({"INBOX": _noise, postman.ALL_MAIL: _noise, postman.SENT: _sent_noise})
        assert postman.thread_headers(_tb, {"to": _v, "subject": _S}) == (None, None)
        assert _tb.calls == ["SELECT", "SEARCH", "FETCH"] * 3, _tb.calls
        # preflight's second pass on the same session is free
        assert postman.awaiting_reply(_tb, {"to": _v, "subject": _S}) is None
        assert len(_tb.calls) == 9, f"awaiting_reply re-read what was cached: {_tb.calls}"
        # two addresses: still one SELECT per mailbox, not one per address
        _w = "sam@venuegroup.example"
        _tb = _ThreadBox({"INBOX": _noise, postman.ALL_MAIL: _noise, postman.SENT: _sent_noise})
        postman.thread_headers(_tb, {"to": f"{_v}, {_w}", "subject": _S})
        assert _tb.calls.count("SELECT") == 3, _tb.calls
        assert _tb.calls.count("SEARCH") == 6 and _tb.calls.count("FETCH") == 3, _tb.calls
        # and the answers are the ones the serial lookup gave: the venue's newest message in
        # the thread, INBOX first, an autoreply skipped, our sent copy only as the fallback
        _thread = _noise + [(_v, _me, "RE: Dinner for 100", 30, "<old@v.example>"),
                            (_v, _me, "RE: Dinner for 100", 5, "<new@v.example>"),
                            (_v, _me, "Automatic reply: Dinner for 100", 1, "<ooo@v.example>")]
        _tb = _ThreadBox({"INBOX": [], postman.ALL_MAIL: _thread,
                          postman.SENT: [(_me, _v, "Dinner for 100", 40, "<ours@a.example>")]})
        assert postman.thread_headers(_tb, {"to": _v, "subject": _S})[0] == "<new@v.example>"
        _tb = _ThreadBox({"INBOX": [], postman.ALL_MAIL: _noise,
                          postman.SENT: [(_me, _v, "Dinner for 100", 40, "<ours@a.example>")]})
        assert postman.thread_headers(_tb, {"to": _v, "subject": _S})[0] == "<ours@a.example>"
        # our send 40h ago, their reply 5h ago: answered. thread_headers stopped at All Mail,
        # so only Sent is read now, and All Mail comes from the cache
        _tb = _ThreadBox({"INBOX": [], postman.ALL_MAIL: _thread,
                          postman.SENT: [(_me, _v, "Dinner for 100", 40, "<ours@a.example>")]})
        postman.thread_headers(_tb, {"to": _v, "subject": _S})
        _n = len(_tb.calls)
        assert postman.awaiting_reply(_tb, {"to": _v, "subject": _S}) is None
        assert _tb.calls[_n:] == ["SELECT", "SEARCH", "FETCH"], _tb.calls

    def test_17_send_path(self):
        work = postman.resolve_identity(None, None)
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

            def shutdown(self):
                self.events.append(("IMAP SHUTDOWN",))

            def append(self, mailbox, flags, when, raw):
                self.events.append(("APPEND", email.message_from_bytes(raw)["Subject"]))
                return "OK", [b""]

        _real_ssl, _real_smtp = imaplib.IMAP4_SSL, smtplib.SMTP
        _pw_saved = {k: os.environ.get(k) for k in (postman.pw_env(work), "POSTMAN_NO_VAULT")}

        def _run(argv, smtp=None, boxes=None, logout_error=None):
            """main(argv) over the fakes: (exit code or SystemExit, stdout, events)."""
            events = []
            box = _SendBox(boxes or {}, events, logout_error)
            imaplib.IMAP4_SSL = lambda host, **kw: box
            smtplib.SMTP = lambda host, port, **kw: _FakeSMTP(host, events, **(smtp or {}))
            with contextlib.redirect_stdout(io.StringIO()) as out:
                try:
                    rc = postman.main(argv)
                except (SystemExit, smtplib.SMTPException) as e:
                    rc = e
            return rc, out.getvalue(), events

        def _blocks(bp):
            return postman.parse_batch(bp.read_text(encoding="utf-8"))[2]

        _today = f"{date.today():%Y-%m-%d}"
        _two = (f"## @one | A B <a@b.example>\nSource: b.example/c, read {_today}\n"
                f"Cc: c@b.example\nSubject: s1\n\nHi.\n\n---\n"
                f"## @two | C D <c@d.example>\nSource: d.example/c, read {_today}\n"
                f"Subject: s2\n\nHi.\n")
        try:
            self.enterContext(mock.patch.object(postman, "has_mx", lambda domain: True))
            os.environ[postman.pw_env(work)], os.environ["POSTMAN_NO_VAULT"] = "x", "1"
            with tempfile.TemporaryDirectory() as td:
                bp = Path(td) / "batch.md"
                # a clean batch: both sent and stamped, and the IMAP session that resolved the
                # threads is closed before the SMTP one opens, not held idle for the batch
                bp.write_text(_two, encoding="utf-8")
                rc, out, ev = _run(["--send", str(bp)])
                assert rc == 0, (rc, out)
                assert [e[1] for e in ev if e[0] == "DATA"] == ["s1", "s2"], ev
                assert ev.index(("IMAP LOGOUT",)) < ev.index(("SMTP", "smtp.gmail.com")), ev
                assert all(r["sent"] for r in postman.parse_batch(bp.read_text(encoding="utf-8"))[2])
                assert "2 sent | 0 failed" in out, out
                # a partly refused list: the Cc bounced at RCPT, To took it. The block is
                # stamped (a rerun would send To a second copy) but not as clean, the refused
                # address is named, and the batch stops before block two
                bp.write_text(_two, encoding="utf-8")
                rc, out, ev = _run(["--send", str(bp)], smtp={"refuse": ["c@b.example"]})
                assert rc == 1 and "0 sent | 1 failed" in out, (rc, out)
                assert "PARTIAL: one" in out and "c@b.example (550" in out, out
                assert [e[1] for e in ev if e[0] == "DATA"] == ["s1"], ev
                _r = postman.parse_batch(bp.read_text(encoding="utf-8"))[2]
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
                rc, out, ev = _run(["--draft", str(bp)], boxes={postman.DRAFTS: [
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
                _old = {postman.SENT: [(_me, "a@b.example", "s1", 48, "<old@a.example>")]}
                rc, out, ev = _run(["--send", str(bp)], boxes=_old)
                assert isinstance(rc, SystemExit) and str(rc).startswith("UNKNOWN: one"), rc
                assert "Sent Mail" in str(rc) and "Nothing was sent" in str(rc), str(rc)
                assert not [e for e in ev if e[0] in ("SMTP", "DATA")], ev
                # Sent Mail holds it, by recipient, subject and time and not by Message-ID
                # (Gmail rewrites that): the block is stamped sent and the batch goes on
                _found = {postman.SENT: [(_me, "a@b.example", "s1", 0, "<gmail-rewrote@a.example>")]}
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
                os.environ[postman.pw_env(postman.resolve_identity("plain", None))] = "x"
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
                    os.environ.pop(postman.pw_env(postman.resolve_identity("plain", None)), None)
                # review of #81 to #83. A Sent copy dated an hour after the attempt is a later
                # mail in that thread, not this send, so it does not clear an UNKNOWN block
                bp.write_text(_two, encoding="utf-8")
                rc, out, ev = _run(["--send", str(bp)], smtp={"drop": "after-data"})
                assert rc == 1 and "UNKNOWN: one" in out, out
                _later = {postman.SENT: [(_me, "a@b.example", "s1", -1, "<later@a.example>")]}
                rc, out, ev = _run(["--send", str(bp)], boxes=_later)
                assert isinstance(rc, SystemExit) and str(rc).startswith("UNKNOWN: one"), rc
                assert not [e for e in ev if e[0] in ("SMTP", "DATA")], ev
                # a PARTIAL whose Sent: stamp fails: the stop names who was refused, the
                # Attempting: line carries it, and the rerun's Sent Mail stamp keeps it
                _real_stamp, _fails = postman.stamp_block, []

                def _flaky(path, slug, when, key="Sent"):
                    if key == "Sent" and when and not _fails:
                        _fails.append(slug)
                        raise PermissionError("the editor holds the file")
                    return _real_stamp(path, slug, when, key)
                bp.write_text(_two, encoding="utf-8")
                with mock.patch.object(postman, "stamp_block", _flaky):
                    rc, out, ev = _run(["--send", str(bp)], smtp={"refuse": ["c@b.example"]})
                assert rc == 1 and "UNKNOWN: one" in out and "c@b.example (550" in out, out
                assert "refused c@b.example" in (_blocks(bp)[0]["attempting"] or ""), _blocks(bp)
                _found = {postman.SENT: [(_me, "a@b.example", "s1", 0, "<gmail-rewrote@a.example>")]}
                rc, out, ev = _run(["--send", str(bp)], boxes=_found)
                assert rc == 0 and "refused c@b.example" in out, (rc, out)
                _r = _blocks(bp)[0]
                assert "Sent Mail" in _r["sent"] and "refused c@b.example" in _r["sent"], _r
                # the Attempting: write failing, or build_message raising, sends nothing and
                # is a counted FAILED stop with the summary line, not a traceback
                _real_build = postman.build_message

                def _locked(path, slug, when, key="Sent"):
                    if key == "Attempting" and slug == "two":
                        raise PermissionError("locked")
                    return _real_stamp(path, slug, when, key)

                def _broken(rec, *a, **kw):
                    if rec["slug"] == "two":
                        raise postman.BatchError("two: broken")
                    return _real_build(rec, *a, **kw)
                for _name, _bad in (("stamp_block", _locked), ("build_message", _broken)):
                    bp.write_text(_two, encoding="utf-8")
                    with mock.patch.object(postman, _name, _bad):
                        rc, out, ev = _run(["--send", str(bp)])
                    assert rc == 1 and "FAILED: two" in out and "1 sent | 1 failed" in out, \
                        (_name, rc, out)
                    assert [e[1] for e in ev if e[0] == "DATA"] == ["s1"], ev
                    assert _blocks(bp)[1]["attempting"] is None, _blocks(bp)[1]
            # a LOGOUT that fails still closes the socket
            _ev = []
            imaplib.IMAP4_SSL = lambda host, **kw: _SendBox(
                {}, _ev, logout_error=imaplib.IMAP4.abort("logout"))
            with postman.imap_session("x", work["sender"]):
                pass
            assert ("IMAP SHUTDOWN",) in _ev, _ev
            # cleanup never masks the error that killed the session
            for _cm, _kw in ((postman.smtp_session, {}), (postman.imap_session, {})):
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
                postman.bounce_sweep("x", date.today(), work["sender"])
            except SystemExit as e:
                assert "FETCH" in str(e) and "not a clean result" in str(e), str(e)
            else:
                raise AssertionError("a failed bounce FETCH read back as clean")
        finally:
            imaplib.IMAP4_SSL, smtplib.SMTP = _real_ssl, _real_smtp
            for _k, _v in _pw_saved.items():
                if _v is None:
                    os.environ.pop(_k, None)
                else:
                    os.environ[_k] = _v

    def test_18_credentials_and_config_dir(self):
        # credential resolution, offline. Never calls vault_password: POSTMAN_NO_VAULT is
        # what keeps this a unit test instead of a live secret-store round trip.
        _ident = postman.resolve_identity("branded", None)
        os.environ[postman.pw_env(_ident)] = "env-wins"
        assert postman.gmail_password(_ident) == "env-wins", "the environment must beat the store"
        os.environ.pop(postman.pw_env(_ident))
        os.environ["POSTMAN_NO_VAULT"] = "1"
        try:
            postman.gmail_password(_ident)
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
        _pw_ident = dict(postman.resolve_identity("branded", None))
        _pw_ident.pop("pw_env", None)
        os.environ.pop(postman.pw_env(_pw_ident), None)
        _pw_ident["pw_cmd"] = [_sys.executable, "-c", "print('a-secret')"]
        assert postman.gmail_password(_pw_ident) == "a-secret", "pw_cmd's stdout is the password"

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
                _r = postman.gmail_password(_case)
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
                assert postman.config_dir() == Path("~/.postman").expanduser().resolve(), \
                    f"a .postman/ in a parent directory must be ignored, got {postman.config_dir()}"
                assert postman.config_dir() != (_hostile / ".postman").resolve()
            finally:
                os.chdir(_prior_cwd)
                if _had_home:
                    os.environ["POSTMAN_HOME"] = _prior_home

    def test_19_voice_md(self):
        # voice_md's two branches: yours when present, the shipped default otherwise. Neither
        # was covered, and the README sells the override as load-bearing behaviour.
        assert postman.voice_md() == Path(postman.__file__).resolve().parent / "VOICE.md", \
            "with no user VOICE.md the shipped default must win"
        _user_voice = postman.config_dir() / "VOICE.md"
        # an em dash as the entry: proves a user file wins AND that a punctuation entry works,
        # which is what VOICE.md now tells people to do instead of inheriting one
        _user_voice.write_text("## Banned\n\n- a-phrase-only-here\n- —\n", encoding="utf-8")
        try:
            assert postman.voice_md() == _user_voice, "a user VOICE.md must beat the shipped one"
            assert "a-phrase-only-here" in postman.banned_phrases()
            assert postman.check_voice("A range 3 — 4pm.") == ["—"], \
                "a punctuation entry in a user's own file must still refuse the build"
            assert postman.check_voice("I hope this email finds you well.") == [], \
                "a user file REPLACES the shipped list, it does not merge with it"
        finally:
            _user_voice.unlink()
        assert postman.voice_md() == Path(postman.__file__).resolve().parent / "VOICE.md"

    def test_20_no_real_domains_ship(self):
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
        _plugin_root = Path(postman.__file__).resolve().parent.parent.parent
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

    def test_21_timeouts(self):
        work = postman.resolve_identity(None, None)
        # #47: a server that accepts the connection and then says nothing must end in a
        # timeout error, not a hang. The real imaplib and smtplib classes run against a local
        # socket that accepts and never answers. Only the host is redirected, so the timeout
        # under test is the one the code passes. Timeouts drop to 1 s for the run and are
        # pinned by value after. inbox reads them from this same module object (#53).
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
        _timeouts = mock.patch.multiple(postman, IMAP_TIMEOUT=1, SMTP_TIMEOUT=1)
        _pw_key = postman.pw_env(work)
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
            _timeouts.start()
            # a dummy credential, and no vault: nothing here may reach a real login
            os.environ[_pw_key], os.environ["POSTMAN_NO_VAULT"] = "x", "1"
            # the send path is not caught and not retried: it raises the raw error (#48)
            e = _timed(lambda: postman.smtp_session("x", work["sender"]).__enter__())
            assert isinstance(e, smtplib.SMTPServerDisconnected), repr(e)
            assert "timed out" in str(e), str(e)
            e = _timed(lambda: postman.imap_session("x", work["sender"]).__enter__())
            assert isinstance(e, OSError) and "timed out" in str(e), repr(e)
            # the three read modes end in one line that names the mode
            e = _timed(lambda: postman.main(["--bounces", work["name"], "1"]))
            assert isinstance(e, SystemExit), repr(e)
            assert str(e).startswith("--bounces:") and "timed out" in str(e), str(e)
            assert "not a clean result" in str(e) and "\n" not in str(e), str(e)
            e = _timed(lambda: postman.main(["--drafts", work["name"]]))
            assert isinstance(e, SystemExit), repr(e)
            assert str(e).startswith("--drafts:") and "timed out" in str(e), str(e)
            with tempfile.TemporaryDirectory() as td:
                bp = Path(td) / "batch.md"
                bp.write_text(f"## @one | A B <a@b.example>\nSource: b.example/c, read "
                              f"{date.today():%Y-%m-%d}\nSubject: s1\n\nHi.\n", encoding="utf-8")
                with mock.patch.object(postman, "has_mx", lambda domain: True):
                    e = _timed(lambda: postman.main(["--draft", str(bp)]))
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
            _timeouts.stop()
            for k, v in _env.items():
                if v is None:
                    os.environ.pop(k, None)
                else:
                    os.environ[k] = v
            _srv.close()
            for c in _held:
                c.close()
        assert (postman.IMAP_TIMEOUT, postman.SMTP_TIMEOUT) == (60, 30), \
            (postman.IMAP_TIMEOUT, postman.SMTP_TIMEOUT)
        assert _inbox.postman is postman, "inbox has a second copy of postman"

    def test_22_sweep_drafts_skips_a_draft_the_fetch_left_out(self):
        # --drafts fetches every draft's headers in one chunked UID FETCH (#53). A UID the
        # answer leaves out is skipped, as a failed per-draft FETCH was, never a KeyError.
        class _Drafts:
            def __init__(self):
                self.fetches = []

            def login(self, user, password):
                pass

            def logout(self):
                pass

            def list(self):
                return "OK", []

            def select(self, mailbox, readonly=False):
                return "OK", [b"3"]

            def uid(self, cmd, *args):
                if cmd == "SEARCH":
                    return "OK", [b"1 2 3"]
                self.fetches.append(args[0])
                return "OK", [(f"{u} (UID {u} BODY[HEADER]".encode(),
                               f"To: v@venue.example\r\nSubject: Dinner {u}\r\n\r\n".encode())
                              for u in ("1", "3")]
        box = _Drafts()
        with mock.patch.object(imaplib, "IMAP4_SSL", lambda host, **kw: box):
            rows, failed = postman.sweep_drafts("x", "a@b.example")
        self.assertEqual([u for u, _ in rows], ["1", "3"])
        self.assertEqual(rows[1][1], "To: v@venue.example Subject: Dinner 3")
        self.assertEqual((failed, box.fetches), (0, ["1,2,3"]))


class ModuleLoadTest(unittest.TestCase):
    def test_script_run_loads_postman_once(self):
        # Run as a script postman.py is __main__, and `import postman` in inbox.py used to
        # execute the file again as a second module with its own globals, so a stub set in
        # one copy was invisible to the other (#53). This runs the real script into a
        # subcommand that imports inbox (`search --help` exits inside argparse, before any
        # identity or mailbox), and a sitecustomize hook reports at exit which module
        # inbox got.
        with tempfile.TemporaryDirectory() as td:
            Path(td, "sitecustomize.py").write_text(
                "import atexit, sys\n"
                "def _report():\n"
                "    inbox = sys.modules.get('inbox')\n"
                "    main = sys.modules['__main__']\n"
                "    print('inbox imported:', inbox is not None)\n"
                "    print('one module:', inbox is not None and inbox.postman is main\n"
                "          and sys.modules.get('postman') is main)\n"
                "atexit.register(_report)\n", encoding="utf-8")
            env = dict(os.environ, PYTHONPATH=os.pathsep.join(
                p for p in (td, os.environ.get("PYTHONPATH")) if p))
            run = subprocess.run(
                [sys.executable, str(SKILL / "postman.py"), "search", "--help"],
                capture_output=True, text=True, env=env, timeout=60)
        self.assertEqual(run.returncode, 0, run.stderr)
        self.assertIn("inbox imported: True", run.stdout)
        self.assertIn("one module: True", run.stdout)


if __name__ == "__main__":
    unittest.main()
