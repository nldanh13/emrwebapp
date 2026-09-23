# -*- coding: utf-8 -*-
"""Regression: khi gộp nhiều BN/Chrome, chuyển sang BN kế tiếp phải về danh sách
nội trú bằng URL sạch. Trước đây URL dựng từ trang chi tiết BN trước (D/s phẫu
thuật) giữ lại keyword/tungay/denngay cũ nên BN kế tiếp "không tìm thấy".
"""

from urllib.parse import parse_qs, urlparse

import hchanh_fetch
from hchanh_fetch import _clean_inpatient_list_url


def test_clean_url_keeps_only_session_params():
    stale = (
        "http://192.168.2.26:2026/home.aspx?scope=sys&lang=vi&wpid=danhsachphauthuatdraw"
        "&phauthuatid=60550f6a&keyword=26000765&tg=7&tungay=05%2F01%2F2026&denngay=07%2F01%2F2026"
        "&role=323&usid=172.31.255.1_abc&st=192959&noitruid=62d0&nextlink=lichsuylenh"
    )
    out = urlparse(_clean_inpatient_list_url(stale))
    q = parse_qs(out.query)
    assert out.path == "/home.aspx"
    assert q == {
        "scope": ["sys"], "lang": ["vi"], "role": ["323"],
        "usid": ["172.31.255.1_abc"], "st": ["192959"],
        "wpid": ["danhsachdieutrinoitrudraw"],
    }


def test_clean_url_empty_without_session():
    assert _clean_inpatient_list_url("http://192.168.2.26:2026/login.aspx") == ""
    assert _clean_inpatient_list_url("") == ""


def test_switch_navigates_to_clean_list_before_setting_filters(monkeypatch):
    calls = []

    class FakeDriver:
        current_url = (
            "http://h/home.aspx?scope=sys&lang=vi&role=323&usid=u1&st=9"
            "&wpid=danhsachphauthuatdraw&keyword=OLD&tungay=05%2F01%2F2026&denngay=07%2F01%2F2026"
        )
        current_window_handle = "main"

        def get(self, url):
            calls.append(("get", url))
            self.current_url = url

    monkeypatch.setattr(hchanh_fetch, "_selenium_wait_after_action", lambda *a, **k: None)
    monkeypatch.setattr(hchanh_fetch, "_selenium_set_status_filter",
                        lambda d, w, status, **k: calls.append(("status", status, d.current_url)))
    monkeypatch.setattr(hchanh_fetch, "_selenium_set_time_range_filter",
                        lambda d, w, a, b, **k: calls.append(("range", a, b)))
    monkeypatch.setattr(hchanh_fetch, "_selenium_search_patient", lambda *a, **k: calls.append(("search",)))
    monkeypatch.setattr(hchanh_fetch, "_selenium_patient_row_exists", lambda d, code: True)
    monkeypatch.setattr(hchanh_fetch, "_extract_patient_links_from_selenium_page",
                        lambda d, code: {"doctor": "http://h/d", "nursing": "http://h/n"})
    hchanh_fetch._HCHANH_CLICK_CACHE.clear()

    driver = FakeDriver()
    ctx = hchanh_fetch._switch_hchanh_click_context_on_open_driver(
        driver, object(), "26000650", {}, "23/09/2026", "05/01/2026", "Hoàn tất",
        "05/01/2026", "23/09/2026", {}, "", "",
    )

    assert ctx is not None
    assert calls[0][0] == "get"
    clean_q = parse_qs(urlparse(calls[0][1]).query)
    assert clean_q["wpid"] == ["danhsachdieutrinoitrudraw"]
    assert "keyword" not in clean_q and "tungay" not in clean_q
    # Bộ lọc được đặt SAU khi đã ở danh sách sạch.
    assert calls[1][0] == "status" and "danhsachdieutrinoitrudraw" in calls[1][2]
    assert ("range", "05/01/2026", "23/09/2026") in calls
    assert ctx["nav_url"] == calls[0][1]
