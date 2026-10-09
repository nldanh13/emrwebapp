# -*- coding: utf-8 -*-
"""Lấy chi tiết: một ca không đọc được qua HTTP chỉ chuyển RIÊNG ca đó sang Chrome.

Trước đây gặp một ca không có trong danh sách link HTTP thì `break`, bỏ hết phần đã đọc
và chạy lại cả lô bằng Chrome — một ca lạ kéo cả lô sang đường chậm.
"""
import json
from unittest import mock

import main_worker

Y_HTML = """
<div class="vertical-timeline-block"><div class="vertical-timeline-content">
<span class="vertical-date">08:00 01/10/2026</span><p>Y lệnh test</p></div></div>
"""


class FakeSess:
    def __init__(self):
        self.fetched = []

    def login(self):
        return True

    def scan_all_inpatients(self):
        return [], {"BN1": "/view/1", "BN3": "/view/3"}

    def fetch_patient_page(self, view_url, denngay=None):
        self.fetched.append(view_url)
        return "<html></html>", view_url

    def try_get_ylenh_html(self, html, url):
        return Y_HTML, url + "/ylenh"


class FakeWorkerSession:
    def __init__(self, *_a, **_k):
        self.driver = mock.MagicMock()
        self.driver.current_url = "https://emr.example/Default.aspx"
        self.driver.page_source = ""
        self.wait = mock.MagicMock()

    def __enter__(self):
        return self

    def __exit__(self, *_a):
        return False


def _fake_timeline(_html, bridge_end_date=None, start_boundary_date=None):
    return {"01/10/2026": {"Y lệnh": "Y lệnh test", "Diễn biến": "", "Bác sĩ": "BS A"}}, "BS A"


def _run(tmp_path, monkeypatch, *, skip_v2=True):
    rows = [
        {"Mã BN": "BN1", "Họ tên": "A", "Vi_Tri": "P01"},
        {"Mã BN": "BN2", "Họ tên": "B", "Vi_Tri": "P01"},  # không có link HTTP → Chrome
        {"Mã BN": "BN3", "Họ tên": "C", "Vi_Tri": "P02"},
    ]
    inp = tmp_path / "in.json"
    out = tmp_path / "out.json"
    inp.write_text(json.dumps(rows, ensure_ascii=False), encoding="utf-8")

    sess = FakeSess()
    monkeypatch.setattr(main_worker, "_get_http_session", lambda _cfg: sess)
    monkeypatch.setattr(main_worker, "WorkerSession", FakeWorkerSession)
    monkeypatch.setattr(main_worker, "extract_timeline_map_from_html", _fake_timeline)
    monkeypatch.setattr(main_worker, "_http_read_enabled", lambda _cfg: True)
    monkeypatch.setattr(main_worker, "_allow_selenium_read_fallback", lambda _cfg: True)
    v2_calls = []
    monkeypatch.setattr(main_worker, "generate_runtime_v2_files", lambda *a, **k: v2_calls.append(a))
    if skip_v2:
        monkeypatch.setenv("DETAILS_SKIP_V2", "1")
    else:
        monkeypatch.delenv("DETAILS_SKIP_V2", raising=False)

    worker = main_worker.AutoWorker.__new__(main_worker.AutoWorker)
    worker.config = {}
    worker.driver = None
    worker.wait = None
    opened = []

    def fake_open(ma_bn, denngay=None, row=None):
        opened.append(ma_bn)
        return False  # không mở được: bỏ qua, không ghi gì cho ca này

    worker._search_and_open_patient = fake_open
    try:
        worker.task_details(str(inp), str(out), "01/10/2026", "01/10/2026")
    except RuntimeError:
        pass
    records = json.loads(out.read_text(encoding="utf-8")) if out.exists() else []
    return sess, opened, records, v2_calls


def test_chi_ca_khong_co_link_moi_mo_chrome(tmp_path, monkeypatch):
    sess, opened, records, _ = _run(tmp_path, monkeypatch)
    assert opened == ["BN2"]
    assert sess.fetched == ["/view/1", "/view/3"]
    ids = sorted({r.get("ma_bn") or r.get("Mã BN") for r in records})
    assert ids == ["BN1", "BN3"]  # phần đọc qua HTTP không bị bỏ


def test_khong_dung_v2_khi_may_chu_bao_bo_qua(tmp_path, monkeypatch):
    _, _, _, v2_calls = _run(tmp_path, monkeypatch, skip_v2=True)
    assert v2_calls == []
    _, _, _, v2_calls = _run(tmp_path, monkeypatch, skip_v2=False)
    assert len(v2_calls) == 1
