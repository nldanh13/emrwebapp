# -*- coding: utf-8 -*-
"""Xử trí ra viện nhưng trang điều dưỡng chưa có giờ ra: đọc Thời gian ra ở
Tổng kết → Ra Khoa để có mốc ra viện thật (không phải mốc ước tính)."""
from pathlib import Path

import pytest

from ra_khoa_reader import parse_ra_khoa_time, read_ra_khoa_time

ROOT = Path(__file__).resolve().parents[1]


@pytest.mark.parametrize("raw,expected", [
    ("09:15 04/11/2026", "09:15 04/11/2026"),
    ("04/11/2026 09:15", "09:15 04/11/2026"),
    ("9:05 4-11-26", "09:05 04/11/2026"),
    ("09:15:00 04/11/2026", "09:15 04/11/2026"),
    ("09:15 04/11", "09:15 04/11/2026"),
    ("04/11/2026", ""),
    ("", ""),
    ("25:00 04/11/2026", ""),
])
def test_parse_ra_khoa_time(raw, expected):
    assert parse_ra_khoa_time(raw, default_year="2026") == expected


class _FakeDriver:
    def __init__(self, menu=True, values=None):
        self.menu = menu
        self.values = list(values or [])
        self.scripts = []

    def execute_script(self, script, *args):
        self.scripts.append(script)
        if "onShowXuTri" in script:
            return self.menu
        return self.values.pop(0) if self.values else ""


def test_read_ra_khoa_time_waits_for_value_and_never_saves():
    driver = _FakeDriver(values=["", "10:40 04/11/2026"])
    assert read_ra_khoa_time(driver, default_year="2026", timeout=3) == "10:40 04/11/2026"
    assert not any("btnSave" in s or "Luu" in s for s in driver.scripts)


def test_read_ra_khoa_time_without_menu_returns_empty():
    assert read_ra_khoa_time(_FakeDriver(menu=False), timeout=1) == ""


def test_main_worker_reads_ra_khoa_when_discharge_time_missing():
    import main_worker as mw

    row = {"ma_bn": "X1", "xu_tri": "Ra viện"}
    mw._attach_discharge_info(row, "<html><span id='lblNgayRaVien'></span></html>", "04/11/2026", default_year="2026")
    assert mw._needs_ra_khoa_time(row)
    mw._set_discharge_datetime(row, "10:40 04/11/2026", "04/11/2026", "Tổng kết → Ra Khoa")
    assert row["gio_ra_vien"] == "10:40"
    assert row["ngay_ra_vien_date"] == "04/11/2026"
    assert row["ra_vien_hom_nay"] is True
    assert not mw._needs_ra_khoa_time(row)
    assert not mw._needs_ra_khoa_time({"ma_bn": "X2", "xu_tri": "Điều trị tiếp"})

    src = (ROOT / "worker" / "main_worker.py").read_text(encoding="utf-8")
    # Chrome: đọc Ra Khoa ngay sau khi trang điều dưỡng thiếu giờ ra.
    assert "ra_khoa_dt = read_ra_khoa_time(self.driver, default_year=default_year)" in src
    # HTTP: chỉ chuyển sang Chrome khi máy được phép mở Chrome đọc.
    assert 'getattr(self, "_ra_khoa_chrome_ok", False) and _needs_ra_khoa_time(bn)' in src
    assert "self._ra_khoa_chrome_ok = bool(allow_selenium_fallback and not helper_mode)" in src
