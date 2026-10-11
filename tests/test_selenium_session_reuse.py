# -*- coding: utf-8 -*-
"""Regression tests for reusable sessions and no-op Selenium actions.

All tests use fake Chrome/EMR sessions; no patient records or EMR network calls.
"""
from types import SimpleNamespace

import pytest

import hchanh_fetch as hf
import selenium_emr_helpers as helpers


class FakeSearch:
    def __init__(self, value):
        self.value = value
        self.clear_calls = 0
        self.sent = []

    def get_attribute(self, name):
        return self.value if name == "value" else ""

    def clear(self):
        self.clear_calls += 1
        self.value = ""

    def send_keys(self, value):
        self.sent.append(value)
        self.value += str(value)


def test_search_reuses_text_but_still_submits_to_refresh_results(monkeypatch):
    search = FakeSearch("26090048")
    driver = SimpleNamespace()
    wait = SimpleNamespace(until=lambda condition: search)
    monkeypatch.setattr(helpers, "ensure_inpatient_list", lambda *a, **kw: None)
    monkeypatch.setattr(helpers, "wait_after_action", lambda *a, **kw: None)
    helpers.search_patient(driver, wait, {}, "26090048")
    assert search.clear_calls == 0
    assert search.sent == [helpers.Keys.ENTER]


def test_search_changes_code_only_when_necessary(monkeypatch):
    search = FakeSearch("26090047")
    driver = SimpleNamespace()
    wait = SimpleNamespace(until=lambda condition: search)
    monkeypatch.setattr(helpers, "ensure_inpatient_list", lambda *a, **kw: None)
    monkeypatch.setattr(helpers, "wait_after_action", lambda *a, **kw: None)
    helpers.search_patient(driver, wait, {}, "26090048")
    assert search.clear_calls == 1
    assert search.sent == ["26090048", helpers.Keys.ENTER]


def test_unchanged_date_filter_skips_wait_and_ui_events(monkeypatch):
    executed = []
    driver = SimpleNamespace(execute_script=lambda script, *args: (
        executed.append(args) or {"unchanged": True, "okF": False, "okT": False, "chose": False}
    ))
    monkeypatch.setattr(helpers, "wait_after_action", lambda *a, **k: pytest.fail("No-op filter must not wait"))
    assert helpers.set_time_range_filter(driver, date_from="2026-09-01", date_to="2026-09-30")
    assert executed == [("01/09/2026", "30/09/2026")]


def test_changed_date_filter_still_waits(monkeypatch):
    waits = []
    driver = SimpleNamespace(execute_script=lambda *args: {"okF": True, "okT": False, "chose": False})
    monkeypatch.setattr(helpers, "wait_after_action", lambda *a, **k: waits.append(True))
    assert helpers.set_time_range_filter(driver, date_from="01/09/2026", date_to="30/09/2026")
    assert waits == [True]


class FakeHttp:
    def __init__(self):
        self.logins = 0
        self.validations = 0
        self.valid = True

    def login(self):
        self.logins += 1

    def verify_logged_in(self):
        self.validations += 1
        return self.valid


@pytest.fixture
def cached_batch(monkeypatch):
    sessions = []
    def factory(config):
        session = FakeHttp()
        sessions.append(session)
        return session
    monkeypatch.setattr(hf, "_HAS_HTTP", True)
    monkeypatch.setattr(hf, "_bridge_mode", lambda: False)
    monkeypatch.setattr(hf, "_build_hchanh_config", lambda config: dict(config))
    monkeypatch.setattr(hf, "EmrHttpSession", SimpleNamespace(from_config_dict=factory))
    monkeypatch.setattr(hf, "_HCHANH_BATCH_HTTP_ACTIVE", True)
    hf._HCHANH_BATCH_HTTP_CACHE.clear()
    yield sessions
    hf._HCHANH_BATCH_HTTP_CACHE.clear()


def _cfg(username="worker.one"):
    return {
        "url_login": "http://emr.example/login.aspx",
        "url_inpatient_list": "http://emr.example/home.aspx",
        "username": username,
        "password": "example_only",
    }


def test_batch_uses_same_http_session_and_login(cached_batch):
    first = hf._init_session(_cfg())
    second = hf._init_session(_cfg())
    assert first is second
    assert len(cached_batch) == 1
    assert first.logins == 1
    assert first.validations == 0


def test_batch_sessions_isolated_by_account(cached_batch):
    first = hf._init_session(_cfg("worker.one"))
    second = hf._init_session(_cfg("worker.two"))
    assert first is not second
    assert len(cached_batch) == 2
    assert all(session.logins == 1 for session in cached_batch)


def test_batch_revalidates_old_session(cached_batch, monkeypatch):
    t = [0.0]
    monkeypatch.setattr(hf.time, "monotonic", lambda: t[0])
    first = hf._init_session(_cfg())
    t[0] = 121.0
    second = hf._init_session(_cfg())
    assert first is second
    assert first.validations == 1
    assert first.logins == 1


def test_batch_relogs_when_old_session_expired(cached_batch, monkeypatch):
    t = [0.0]
    monkeypatch.setattr(hf.time, "monotonic", lambda: t[0])
    first = hf._init_session(_cfg())
    first.valid = False
    t[0] = 121.0
    second = hf._init_session(_cfg())
    assert first is not second
    assert len(cached_batch) == 2


def test_batch_clears_sessions_even_on_failure(monkeypatch):
    monkeypatch.setattr(hf, "_HCHANH_BATCH_HTTP_ACTIVE", False)
    hf._HCHANH_BATCH_HTTP_CACHE.clear()
    calls = []
    def fail(*args, **kwargs):
        hf._HCHANH_BATCH_HTTP_CACHE["temporary"] = (object(), 0)
        raise RuntimeError("test error")
    monkeypatch.setattr(hf, "_run_hchanh_fetch_batch_impl", fail)
    monkeypatch.setattr(hf, "_shutdown_hchanh_click_driver", lambda: calls.append("closed"))
    with pytest.raises(RuntimeError, match="test error"):
        hf.run_hchanh_fetch_batch("unused.json", "unused_out.json", "discharge", [], "", "")
    assert not hf._HCHANH_BATCH_HTTP_ACTIVE
    assert hf._HCHANH_BATCH_HTTP_CACHE == {}
    assert calls == ["closed"]


def test_expired_chrome_is_not_reused():
    assert not hf._is_driver_alive(SimpleNamespace(current_url="http://emr.example/login.aspx"))
    assert hf._is_driver_alive(SimpleNamespace(current_url="http://emr.example/home.aspx?usid=x"))
    assert not hf._is_driver_alive(SimpleNamespace(current_url=""))
