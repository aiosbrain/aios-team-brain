"""Provider Retry-After: valid delays are honoured exactly; defective input is contained (AIO-1167 R48 D2).

Spec (accepted-spec AC-04:230; Astra R47 adjudication D2). Through the ONE provider-call owner
(``GoogleDriveSource._provider_call``) and its parser:

  * a valid delay-seconds or HTTP-date is the provider's deadline EXACTLY — ordinary or long
    (``99999999`` seconds is ~3.2 years and is not shortened); a short one inside the budget is
    slept, a long one defers with ``not_before`` at the named instant;
  * malformed input — text, a sign, an exponent, NaN/infinity spellings, an impossible date — never
    crashes and never yields a non-ISO timestamp: it is ignored for the existing bounded fallback
    and reported ``retry_after_malformed``;
  * a syntactically valid value no timestamp can hold (more seconds than ``timedelta`` takes, a
    deadline past year 9999) never crashes and is held at the last representable instant —
    fail closed, ``retry_after_unrepresentable`` — never read as permission to retry early.
"""

from __future__ import annotations

from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

import pytest

from aios_ingest.sources.gdrive import (
    LATEST_INSTANT,
    GoogleDriveSource,
    ProviderDeferred,
    parse_retry_after,
)

NOW = datetime(2026, 10, 31, 12, 0, tzinfo=timezone.utc)
MALFORMED = [
    "soon", "", "  ", "-5", "+5", "1e3", "12abc", "0x10", "1_000", "1 000",
    "nan", "NaN", "-nan", "inf", "Infinity", "-inf", "1e999",
    "Wed, 31 Feb 2026 10:00:00 GMT", "Sat, 31 Oct 2026 25:00:00 GMT", "Mon, 99 Foo 2026",
]
UNREPRESENTABLE = [
    "9" * 30,                                   # more seconds than timedelta can hold
    "300000000000",                             # ~9,500 years: past datetime's year 9999
    "9" * 400 + ".5",                           # a decimal that is infinite as a float
    "Fri, 31 Dec 99999 23:59:59 GMT",           # a five-digit year
    "Fri, 31 Dec 9999 23:59:59 -2359",          # 9999-12-31 local, past the last UTC instant
]


@pytest.mark.parametrize("value, expected", [
    ("120", NOW + timedelta(seconds=120)),
    (" 7 ", NOW + timedelta(seconds=7)),
    ("0", NOW),
    ("1.5", NOW + timedelta(seconds=1.5)),
    ("99999999", NOW + timedelta(seconds=99999999)),
    (format_datetime(NOW + timedelta(seconds=300), usegmt=True), NOW + timedelta(seconds=300)),
    ("Sat, 31 Oct 2026 12:00:00 +0530", datetime(2026, 10, 31, 6, 30, tzinfo=timezone.utc)),
    ("Fri, 31 Dec 9999 23:59:59 GMT", datetime(9999, 12, 31, 23, 59, 59, tzinfo=timezone.utc)),
])
def test_valid_delays_and_dates_are_the_named_deadline_exactly(value, expected):
    retry = parse_retry_after(value, NOW)
    assert retry.kind == "valid" and retry.deadline == expected


def test_a_long_valid_delay_is_not_shortened():
    retry = parse_retry_after("99999999", NOW)
    assert retry.deadline is not None and retry.deadline.year == 2029
    assert (retry.deadline - NOW).total_seconds() == 99999999


@pytest.mark.parametrize("value", MALFORMED)
def test_malformed_input_is_classified_malformed(value):
    assert parse_retry_after(value, NOW).kind == "malformed"


@pytest.mark.parametrize("value", UNREPRESENTABLE)
def test_unrepresentable_valid_input_is_classified_unrepresentable(value):
    assert parse_retry_after(value, NOW).kind == "unrepresentable"


def _source(attempts: int = 1, deadline: float = 1) -> GoogleDriveSource:
    return GoogleDriveSource(
        file_ids=["doc"], api_mode="docs", drive_service=object(), docs_service=object(),
        request_deadline_seconds=deadline, provider_retry_attempts=attempts,
    )


def _answer(status: int, retry_after: str | None):
    class Response:
        def __init__(self):
            self.status = status
            self.headers = {"Retry-After": retry_after} if retry_after is not None else {}

    class GoogleHttpError(Exception):
        resp = Response()

    return GoogleHttpError(f"HTTP {status}")


def _defer(status: int, retry_after: str | None, monkeypatch) -> ProviderDeferred:
    monkeypatch.setattr("aios_ingest.sources.gdrive.time.sleep", lambda _d: pytest.fail("must defer, not sleep"))
    calls = []

    def request():
        calls.append(1)
        raise _answer(status, retry_after)

    with pytest.raises(ProviderDeferred) as raised:
        _source()._provider_call(request)
    assert len(calls) == 1
    return raised.value


@pytest.mark.parametrize("status, category", [(429, "rate_limited"), (503, "provider_unavailable")])
@pytest.mark.parametrize("value, seconds", [("120", 120), ("99999999", 99999999)])
def test_a_valid_delay_beyond_the_budget_defers_to_exactly_the_named_instant(monkeypatch, status, category, value, seconds):
    before = datetime.now(timezone.utc)
    deferred = _defer(status, value, monkeypatch)
    after = datetime.now(timezone.utc)
    named = datetime.fromisoformat(deferred.not_before)
    assert before + timedelta(seconds=seconds) <= named <= after + timedelta(seconds=seconds)
    assert deferred.category == category and deferred.diagnostic is None


def test_a_valid_http_date_defers_to_that_instant(monkeypatch):
    target = (datetime.now(timezone.utc) + timedelta(hours=2)).replace(microsecond=0)
    deferred = _defer(429, format_datetime(target, usegmt=True), monkeypatch)
    assert datetime.fromisoformat(deferred.not_before) == target


def test_a_short_valid_delay_inside_the_budget_is_slept_exactly(monkeypatch):
    slept: list[float] = []
    monkeypatch.setattr("aios_ingest.sources.gdrive.time.sleep", slept.append)
    answers = [_answer(429, "2"), {"ok": True}]

    def request():
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    assert _source(attempts=3, deadline=30)._provider_call(request) == {"ok": True}
    assert len(slept) == 1 and 1.9 <= slept[0] <= 2.0


@pytest.mark.parametrize("value", MALFORMED)
def test_malformed_input_never_crashes_and_uses_the_bounded_fallback(monkeypatch, value):
    before = datetime.now(timezone.utc)
    deferred = _defer(429, value, monkeypatch)
    named = datetime.fromisoformat(deferred.not_before)  # a real ISO instant
    assert before <= named <= datetime.now(timezone.utc) + timedelta(seconds=4.2)
    assert deferred.diagnostic == "retry_after_malformed"
    assert deferred.category == "rate_limited"
    assert "malformed" in str(deferred)


@pytest.mark.parametrize("value", MALFORMED[:6])
def test_malformed_input_inside_the_budget_backs_off_instead_of_busy_looping(monkeypatch, value):
    slept: list[float] = []
    monkeypatch.setattr("aios_ingest.sources.gdrive.time.sleep", slept.append)
    monkeypatch.setattr("aios_ingest.sources.gdrive.random.uniform", lambda *_a: 0)
    answers = [_answer(503, value), {"ok": True}]

    def request():
        answer = answers.pop(0)
        if isinstance(answer, Exception):
            raise answer
        return answer

    assert _source(attempts=3, deadline=30)._provider_call(request) == {"ok": True}
    assert slept == [0.25]


@pytest.mark.parametrize("status, category", [(429, "rate_limited"), (503, "provider_unavailable")])
@pytest.mark.parametrize("value", UNREPRESENTABLE)
def test_unrepresentable_input_fails_closed_at_the_last_instant(monkeypatch, status, category, value):
    deferred = _defer(status, value, monkeypatch)
    assert deferred.not_before == LATEST_INSTANT.isoformat()
    assert datetime.fromisoformat(deferred.not_before) == LATEST_INSTANT
    assert deferred.diagnostic == "retry_after_unrepresentable" and deferred.category == category


def test_unrepresentable_input_is_not_retried_even_with_attempts_and_budget_left(monkeypatch):
    monkeypatch.setattr("aios_ingest.sources.gdrive.time.sleep", lambda _d: pytest.fail("no early retry"))
    calls = []

    def request():
        calls.append(1)
        raise _answer(429, "9" * 30)

    with pytest.raises(ProviderDeferred) as raised:
        _source(attempts=5, deadline=30)._provider_call(request)
    assert len(calls) == 1 and raised.value.not_before == LATEST_INSTANT.isoformat()


def test_retry_after_seconds_reports_only_valid_deadlines():
    assert GoogleDriveSource._retry_after(_answer(429, "7")) == pytest.approx(7, abs=0.5)
    assert GoogleDriveSource._retry_after(_answer(429, "inf")) is None
    assert GoogleDriveSource._retry_after(_answer(429, "9" * 30)) is None
    assert GoogleDriveSource._retry_after(_answer(429, None)) is None
