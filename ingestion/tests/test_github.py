import hashlib
import hmac
import json

import httpx

from aios_ingest.sources.github import GithubSource


def test_verify_webhook_hmac_sha256():
    secret = "topsecret"
    src = GithubSource("o/r", webhook_secret=secret)
    body = b'{"hello":"world"}'
    sig = "sha256=" + hmac.new(secret.encode(), body, hashlib.sha256).hexdigest()
    assert src.verify_webhook({"x-hub-signature-256": sig}, body) is True
    assert src.verify_webhook({"x-hub-signature-256": "sha256=bad"}, body) is False


def test_verify_webhook_false_without_secret():
    assert GithubSource("o/r").verify_webhook({}, b"{}") is False


def test_fetch_for_webhook_pulls_changed_markdown(monkeypatch):
    src = GithubSource("o/r", path_glob="*.md", webhook_secret="s")

    import base64

    def fake_get(url, params=None):
        # contents API for the changed file
        content = base64.b64encode(b"# Doc\nbody").decode()
        return httpx.Response(
            200,
            json={"encoding": "base64", "content": content, "html_url": "https://gh/o/r/doc.md"},
            request=httpx.Request("GET", url),
        )

    monkeypatch.setattr(src._http, "get", fake_get)
    payload = {"commits": [{"added": ["doc.md"], "modified": ["skip.txt"]}]}
    docs = list(src.fetch_for_webhook({}, payload))
    assert len(docs) == 1
    assert docs[0].external_id == "o/r/doc.md"
    assert docs[0].body == "# Doc\nbody"
    assert docs[0].source == "github"
