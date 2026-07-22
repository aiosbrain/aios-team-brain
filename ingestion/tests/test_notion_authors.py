"""Spec for Notion author enrichment: created_by/last_edited_by → resolvable author refs, best-effort.

The brain attributes a Notion item to a roster member from these refs, so the contract is: emit the
Notion user id (always, for a person), plus email/name when known; the same user in both roles appears
once; bot/integration accounts are skipped; and any API failure yields NO authors, never a crash.
"""

from aios_ingest.sources.notion_authors import resolve_page_authors

USERS = {
    "u1": {"name": "Alice", "type": "person", "person": {"email": "alice@corp.com"}},
    "u2": {"name": "Bob", "type": "person", "person": {"email": "bob@corp.com"}},
    "bot": {"name": "AIOS Integration", "type": "bot"},  # the integration itself
}


def test_resolves_creator_and_editor_with_email_and_name():
    page = {"created_by": {"id": "u1"}, "last_edited_by": {"id": "u2"}}
    refs = resolve_page_authors("p", get_page=lambda _: page, get_user=lambda uid: USERS[uid])
    assert refs == [
        {"role": "author", "provider": "notion", "external_id": "u1", "email": "alice@corp.com", "display_name": "Alice"},
        {"role": "editor", "provider": "notion", "external_id": "u2", "email": "bob@corp.com", "display_name": "Bob"},
    ]


def test_same_user_created_and_edited_is_emitted_once_as_author():
    page = {"created_by": {"id": "u1"}, "last_edited_by": {"id": "u1"}}
    refs = resolve_page_authors("p", get_page=lambda _: page, get_user=lambda uid: USERS["u1"])
    assert [(r["role"], r["external_id"]) for r in refs] == [("author", "u1")]


def test_bot_actors_are_skipped_but_real_editor_survives():
    # An API-created page: created_by = the integration bot (skip), last_edited_by = a real person (keep).
    page = {"created_by": {"id": "bot"}, "last_edited_by": {"id": "u1"}}
    refs = resolve_page_authors("p", get_page=lambda _: page, get_user=lambda uid: USERS[uid])
    assert [(r["role"], r["external_id"]) for r in refs] == [("editor", "u1")]


def test_page_fetch_failure_yields_no_authors():
    def boom(_):
        raise RuntimeError("notion 500")

    assert resolve_page_authors("p", get_page=boom, get_user=lambda u: {}) == []


def test_user_lookup_failure_still_keeps_the_id_ref():
    # The Notion user id alone is a resolvable signal (if an admin mapped it) — don't drop it; and with
    # the type unknown (lookup failed) we do NOT treat it as a bot.
    page = {"created_by": {"id": "u1"}}

    def boom(_):
        raise RuntimeError("user 404")

    refs = resolve_page_authors("p", get_page=lambda _: page, get_user=boom)
    assert refs == [{"role": "author", "provider": "notion", "external_id": "u1"}]


def test_missing_actors_are_skipped():
    refs = resolve_page_authors("p", get_page=lambda _: {"created_by": {}}, get_user=lambda u: USERS.get(u, {}))
    assert refs == []
