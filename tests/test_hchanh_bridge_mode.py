# -*- coding: utf-8 -*-
"""Chế độ cầu nối tab EMR (Data Hub trên cloud): robot không mở Chrome, không cần tài khoản EMR
trên máy chủ; các bước phải bấm trên giao diện EMR trả "bridge_unsupported" thay vì lỗi phiên."""

import hchanh_fetch as hf


def test_no_hchanh_account_needed_in_bridge_mode(monkeypatch):
    monkeypatch.setenv("EMR_BRIDGE_URL", "http://127.0.0.1:1/api/emr-bridge/internal/fetch")
    cfg = hf._build_hchanh_config({"url_login": "http://emr/login.aspx"})
    assert cfg["url_login"] == "http://emr/login.aspx"


def test_account_still_required_without_bridge(monkeypatch):
    monkeypatch.delenv("EMR_BRIDGE_URL", raising=False)
    try:
        hf._build_hchanh_config({})
    except RuntimeError as e:
        assert "hchanh.username" in str(e)
    else:
        raise AssertionError("phải báo thiếu tài khoản khi không qua cầu nối")


def test_click_steps_skipped_in_bridge_mode(monkeypatch):
    monkeypatch.setenv("EMR_BRIDGE_URL", "http://127.0.0.1:1/api/emr-bridge/internal/fetch")
    assert hf._ensure_hchanh_click_context(None, "123", {}) is None
    assert hf._find_patient_links_via_selenium(None, "123", {}, "") == {}
    sess = object()
    out = hf.fetch_surgery(sess, "123", "", "", {}, {})
    assert out["_fetch_status"] == "bridge_unsupported"
    out = hf.fetch_cls(sess, "123", "", "", {}, {})
    assert out["_fetch_status"] == "bridge_unsupported"
