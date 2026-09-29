"""Offline tests for common.py, the helpers postman.py and inbox.py share (#53)."""
import sys
import tempfile
import unittest
from pathlib import Path

SKILL = Path(__file__).resolve().parent.parent / "skills" / "postman"
sys.path.insert(0, str(SKILL))
import common                                   # noqa: E402


class _Box:
    """Answers SELECT with select_typ and UID FETCH per chunk from `answers`, a list of
    (typ, uids to return). Records every FETCH set it was asked for."""

    def __init__(self, select_typ="OK", answers=()):
        self.select_typ, self.answers, self.asked = select_typ, list(answers), []

    def select(self, mailbox, readonly=False):
        self.selected = (mailbox, readonly)
        return self.select_typ, [b"0"]

    def uid(self, cmd, uid_set, spec):
        assert cmd == "FETCH", cmd
        self.asked.append(uid_set.split(","))
        typ, give = self.answers.pop(0)
        return typ, [(f"{u} (UID {u} BODY[] {{3}}".encode(), f"m{u}".encode())
                     for u in give]


class CommonTest(unittest.TestCase):
    def test_open_mailbox(self):
        box = _Box()
        self.assertEqual(common.open_mailbox(box, '"Sent"', ValueError), '"Sent"')
        self.assertEqual(box.selected, ('"Sent"', True))
        common.open_mailbox(box, "INBOX", ValueError, readonly=False)
        self.assertEqual(box.selected, ("INBOX", False))
        # a refused SELECT raises through the caller's own exception, naming the mailbox
        with self.assertRaises(SystemExit) as cm:
            common.open_mailbox(_Box(select_typ="NO"), "INBOX",
                                lambda why: SystemExit(f"--x: {why}. Nothing read."))
        self.assertEqual(str(cm.exception), "--x: SELECT INBOX failed: NO. Nothing read.")

    def test_fetched(self):
        self.assertEqual(common.fetched("OK", [(b"1 (BODY[] {3}", b"abc"), b")"]), b"abc")
        for typ, data in (("NO", [(b"1 (BODY[] {3}", b"abc")]), ("OK", []),
                          ("OK", None), ("OK", [None]), ("OK", [b"1 (FLAGS ())"])):
            self.assertIsNone(common.fetched(typ, data), (typ, data))

    def test_fetch_headers_chunks_and_gaps(self):
        # five UIDs two at a time is three FETCHes. The second chunk answers NO and the
        # third leaves UID 5 out: both are gaps in the result, never invented entries.
        box = _Box(answers=[("OK", ["1", "2"]), ("NO", ["3", "4"]), ("OK", [])])
        got = common.fetch_headers(box, ["1", "2", "3", "4", "5"], "(BODY[])", size=2)
        self.assertEqual(box.asked, [["1", "2"], ["3", "4"], ["5"]])
        self.assertEqual(got, {"1": b"m1", "2": b"m2"})
        # into is filled in place, so a caller keeps what landed before a later failure
        into = {"9": b"old"}
        box = _Box(answers=[("OK", ["1"])])
        self.assertIs(common.fetch_headers(box, ["1"], "(BODY[])", into=into), into)
        self.assertEqual(into, {"9": b"old", "1": b"m1"})
        self.assertEqual(common.fetch_headers(_Box(), [], "(BODY[])"), {})
        self.assertEqual(common.FETCH_CHUNK, 500)

    def test_by_uid_reads_the_uid_on_either_side_of_the_literal(self):
        data = [(b"11 (UID 1 BODY[] {1}", b"a"), b")",
                (b"12 (BODY[] {1}", b"b"), b" UID 2)"]
        self.assertEqual(common._by_uid(data), {"1": b"a", "2": b"b"})

    def test_atomic_write(self):
        with tempfile.TemporaryDirectory() as td:
            p = Path(td) / "batch.md"
            p.write_bytes(b"old\r\n")
            common.atomic_write(p, "one\r\ntwo\n")
            self.assertEqual(p.read_bytes(), b"one\r\ntwo\n")   # newlines as given
            self.assertEqual([f.name for f in Path(td).iterdir()], ["batch.md"])
            # the temp file cannot be written: the original is left whole
            (Path(td) / "batch.md.tmp").mkdir()
            with self.assertRaises(OSError):
                common.atomic_write(p, "new\n")
            self.assertEqual(p.read_bytes(), b"one\r\ntwo\n")


if __name__ == "__main__":
    unittest.main()
