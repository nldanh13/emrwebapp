# -*- coding: utf-8 -*-
"""Regression tests for EMR traffic safeguards (no hospital EMR/network access)."""
import json
import time

import pytest
import requests

import emr_http_reader as reader
from emr_access_budget import (
    EmrAccessProtectionError, _state_path, pause_origin, reserve_slot,
)


def session(monkeypatch):
    cfg = reader.EmrHttpConfig(
        url_login="http://hospital.test/login.aspx",
        username="test",
        password="dummy",
        url_inpatient_list="http://hospital.test/home.aspx",
        max_retries=1,
    )
    s = reader.EmrHttpSession(cfg)
    monkeypatch.setattr(s, "_throttle", lambda: None)
    monkeypatch.setattr(reader, "_retry_delay", lambda attempt: None)
    return s


def fake_response(code, headers=None):
    res = requests.Response()
    res.status_code = code
    res.url = "http://hospital.test/home.aspx"
    res._content = b"ok"
    if headers:
        res.headers.update(headers)
    return res


@pytest.mark.parametrize("status", [401, 403, 404])
def test_http_auth_or_client_error_never_replayed(monkeypatch, status):
    s = session(monkeypatch)
    calls = []
    def get(method, url, **kwargs):
        calls.append(method)
        return fake_response(status)
    monkeypatch.setattr(s.s, "request", get)
    with pytest.raises(requests.HTTPError):
        s.get_html("/home.aspx")
    assert calls == ["GET"]


def test_500_get_retries_at_most_once(monkeypatch):
    s = session(monkeypatch)
    seen = []
    def get(method, url, **kwargs):
        seen.append(method)
        return fake_response(500 if len(seen) == 1 else 200)
    monkeypatch.setattr(s.s, "request", get)
    assert s.get_html("/home.aspx")[0] == "ok"
    assert seen == ["GET", "GET"]


def test_post_does_not_replay_after_500_or_timeout(monkeypatch):
    s = session(monkeypatch)
    seen = []
    def fail_500(method, url, **kwargs):
        seen.append(method)
        return fake_response(500)
    monkeypatch.setattr(s.s, "request", fail_500)
    with pytest.raises(requests.HTTPError):
        s.post_html("/ajax", {"test": "1"})
    assert seen == ["POST"]

    seen.clear()
    def timeout(method, url, **kwargs):
        seen.append(method)
        raise requests.Timeout("timeout")
    monkeypatch.setattr(s.s, "request", timeout)
    with pytest.raises(requests.Timeout):
        s.post_html("/ajax", {"test": "2"})
    assert seen == ["POST"]


def test_429_pauses_origin_without_retry(monkeypatch, tmp_path):
    s = session(monkeypatch)
    monkeypatch.setenv("EMR_HTTP_BUDGET_DIR", str(tmp_path))
    calls = []
    def overloaded(method, url, **kwargs):
        calls.append(method)
        return fake_response(429, {"Retry-After": "12"})
    monkeypatch.setattr(s.s, "request", overloaded)
    with pytest.raises(EmrAccessProtectionError, match="429"):
        s.get_html("/home.aspx")
    assert calls == ["GET"]
    state = json.loads(_state_path(s.base_origin, str(tmp_path)).read_text())
    assert state["pause_until"] >= time.time() + 9
    with pytest.raises(EmrAccessProtectionError):
        reserve_slot(s.base_origin, str(tmp_path), gap_ms=500)


def test_bridge_post_not_retried_on_emr_error(monkeypatch):
    s = session(monkeypatch)
    calls = []
    def bridge(name, payload, **kwargs):
        calls.append(payload["method"])
        return {"http_status": 500, "text": "", "url": ""}
    monkeypatch.setattr(reader, "_bridge_call", bridge)
    with pytest.raises(RuntimeError, match="500"):
        s._bridge_request("POST", "http://hospital.test/ajax", data={"x": "1"})
    assert calls == ["POST"]


def test_shared_budget_applies_between_process_like_sessions(tmp_path):
    origin = "http://hospital.test"
    reserve_slot(origin, str(tmp_path), gap_ms=1000)
    # Another request from a different worker would have to wait for the reservation.
    with pytest.raises(EmrAccessProtectionError, match="quá dài"):
        reserve_slot(origin, str(tmp_path), gap_ms=1000, max_wait_sec=0)
    assert "hospital.test" not in _state_path(origin, str(tmp_path)).name


def test_shared_cooldown_blocks_without_network(tmp_path):
    origin = "http://hospital.test"
    pause_origin(origin, str(tmp_path), 30)
    with pytest.raises(EmrAccessProtectionError, match="giảm tải"):
        reserve_slot(origin, str(tmp_path), gap_ms=500)
