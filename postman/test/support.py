"""Shared fixture for the offline tests: a throwaway identities.json."""
import contextlib
import json
import os
from pathlib import Path


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
