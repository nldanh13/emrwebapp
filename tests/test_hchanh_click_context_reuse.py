"""Cùng một ca: các phần lấy sau (bảng kê không truyền ngày, y lệnh truyền khoảng ngày khác)
không được quay về danh sách nội trú tìm lại người bệnh khi Chrome đang mở đúng người bệnh, đúng đợt."""
from pathlib import Path
import sys

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

import hchanh_fetch as core  # noqa: E402


def _setup(monkeypatch, cached):
    switched = []
    monkeypatch.setattr(core, "_bridge_mode", lambda: False)
    monkeypatch.setattr(core, "_HAS_SELENIUM_LOGIN", True)
    monkeypatch.setattr(core, "_HAS_SELENIUM_SEARCH", True)
    monkeypatch.setattr(core, "_is_driver_alive", lambda d: True)
    monkeypatch.setattr(core, "_build_hchanh_config", lambda cfg: {"username": "u", "password": "p"})

    def fake_switch(*args, **kwargs):
        switched.append(args)
        return {"driver": object(), "switched": True}

    monkeypatch.setattr(core, "_switch_hchanh_click_context_on_open_driver", fake_switch)
    core._HCHANH_CLICK_CACHE.clear()
    core._HCHANH_CLICK_CACHE.update({
        "driver": object(), "ma_bn": "990001", "inpatient_status": "Đang thực hiện",
        "date_from": "19/08/2026", "date_to": "22/08/2026",
        "config": {"username": "u", "password": "p"}, "patients_served": 1,
        "links": {"doctor": "https://emr.invalid/x"},
        **cached,
    })
    return switched


def test_billing_without_dates_reuses_open_patient(monkeypatch):
    switched = _setup(monkeypatch, {})
    ctx = core._ensure_hchanh_click_context(None, "990001", {"hchanh_batch_size": 25}, date_from="", date_to="")
    assert ctx is core._HCHANH_CLICK_CACHE
    assert switched == [], "không được về danh sách tìm lại BN đang mở"


def test_same_admission_other_end_date_reuses_open_patient(monkeypatch):
    switched = _setup(monkeypatch, {})
    ctx = core._ensure_hchanh_click_context(None, "990001", {"hchanh_batch_size": 25}, date_from="2026-08-19", date_to="2026-08-21")
    assert ctx is core._HCHANH_CLICK_CACHE
    assert switched == []


def test_other_admission_still_searches_again(monkeypatch):
    switched = _setup(monkeypatch, {})
    core._ensure_hchanh_click_context(None, "990001", {"hchanh_batch_size": 25}, date_from="07/08/2026", date_to="12/08/2026")
    assert len(switched) == 1, "đợt khác của cùng BN phải tìm lại đúng dòng"


def test_other_patient_still_searches(monkeypatch):
    switched = _setup(monkeypatch, {})
    core._ensure_hchanh_click_context(None, "990002", {"hchanh_batch_size": 25}, date_from="19/08/2026", date_to="22/08/2026")
    assert len(switched) == 1


def test_same_admission_day_with_clock_reuses(monkeypatch):
    switched = _setup(monkeypatch, {"date_from": "10:11 19/08/2026"})
    core._ensure_hchanh_click_context(None, "990001", {"hchanh_batch_size": 25}, date_from="2026-08-19", date_to="")
    assert switched == []
