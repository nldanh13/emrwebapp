# -*- coding: utf-8 -*-
"""Bộ đọc kết quả xét nghiệm trong ngày (worker/lab_result_reader.py), không cần EMR thật."""
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))

import lab_result_reader as lr  # noqa: E402

LISTING = """
<table id="tbDichVu"><tbody>
  <tr><td colspan="6">Khoa Ngoại Chấn Thương</td></tr>
  <tr id="P1"><td></td><td><span class="ylenh-a">1</span></td><td>07:12 09/11/2026</td><td>Trần Nguyễn Anh Duy</td><td>Huyết học</td><td>Hoàn tất</td></tr>
  <tr id="P2"><td></td><td><span class="ylenh-a">2</span></td><td>07:12 09/11/2026</td><td>Trần Nguyễn Anh Duy</td><td>Sinh hóa</td><td>Đang thực hiện</td></tr>
  <tr id="P0"><td></td><td><span class="ylenh-a">3</span></td><td>16:00 08/11/2026</td><td>Phạm Việt Tân</td><td>Sinh hóa</td><td>Hoàn tất</td></tr>
  <tr id="P3"><td></td><td><span class="ylenh-a">4</span></td><td>05:00 10/11/2026</td><td>Phạm Việt Tân</td><td>Sinh hóa</td><td>Hoàn tất</td></tr>
</tbody></table>
"""

DETAIL_P1 = """
<div id="divDsChiSoContent"><table>
  <tr><td>STT</td><td>Chỉ số</td><td>Kết quả</td><td>Tham chiếu</td><td>Đơn vị</td></tr>
  <tr><td>1</td><td>WBC</td><td style="color:red">15.2</td><td>4 - 10</td><td>G/L</td></tr>
  <tr><td>2</td><td>HGB</td><td>132</td><td>120 - 160</td><td>g/L</td></tr>
</table></div>
"""

DETAIL_OTHER = """
<div id="divDsChiSoContent"><table>
  <tr><td>1</td><td>Glucose</td><td>6.1</td><td>3.9 - 6.4</td><td>mmol/L</td></tr>
</table></div>
"""


def test_listing_keeps_only_requested_day_and_marks_completed():
    items = lr.parse_lab_listing(LISTING, "9/11/2026")
    assert [i["ma_phieu"] for i in items] == ["P1", "P2"]
    assert items[0]["hoan_tat"] is True and items[1]["hoan_tat"] is False
    assert items[0]["loai_xn"] == "Huyết học"
    assert items[0]["phong"] == "Khoa Ngoại Chấn Thương"


def test_listing_empty_message_means_no_lab():
    assert lr.parse_lab_listing("<div>Không có dữ liệu</div>", "09/11/2026") == []
    assert lr.parse_lab_listing("", "09/11/2026") == []


def test_listing_unknown_layout_is_error_not_empty():
    html = "<table><tr><td>a</td><td>b</td><td>c</td><td>d</td><td>e</td><td>f</td></tr></table>"
    with pytest.raises(lr.LabStructureError):
        lr.parse_lab_listing(html, "09/11/2026")
    with pytest.raises(lr.LabStructureError):
        lr.parse_lab_listing("<div>Bảng gì đó lạ</div>", "09/11/2026")


def test_detail_rows_keep_value_unit_reference_and_flag_abnormal():
    rows = lr.parse_lab_detail(DETAIL_P1)
    assert rows == [
        {"chi_so": "WBC", "ket_qua": "15.2", "tham_chieu": "4 - 10", "don_vi": "G/L", "bat_thuong": "bat_thuong"},
        {"chi_so": "HGB", "ket_qua": "132", "tham_chieu": "120 - 160", "don_vi": "g/L", "bat_thuong": ""},
    ]


class FakeDriver:
    """Trang EMR giả: khung chi tiết #divLSCT KHÔNG tự xóa khi mở phiếu mới.

    Phiếu P2 (nếu được mở) và các phiếu khác hiện chậm: lần hỏi đầu tiên sau khi bấm,
    khung chi tiết vẫn còn nội dung cũ. Bộ đọc phải xóa khung trước khi bấm.
    """

    def __init__(self, details):
        self.details = details
        self.detail_html = ""
        self.pending = None
        self.opened = []

    def execute_script(self, js, *args):
        if js is lr._CLICK_XN_TAB_JS:
            return "id"
        if js is lr._LISTING_STATE_JS:
            return {"exists": True, "rows": 5, "loading": False, "empty": False}
        if "divLichSuXNContent" in js and "innerHTML" in js:
            return LISTING
        if js is lr._CLEAR_DETAIL_JS:
            self.detail_html = ""
            return True
        if js is lr._OPEN_DETAIL_JS:
            self.opened.append(args[0])
            self.pending = self.details[args[0]]
            return "ok"
        if js is lr._DETAIL_STATE_JS:
            if self.pending is not None and self.detail_html == "":
                # chưa tải: lần hỏi sau mới có chỉ số
                self._next, self.pending = self.pending, None
                return {"exists": True, "rows": 0, "html": 0}
            if getattr(self, "_next", None):
                self.detail_html, self._next = self._next, None
            rows = self.detail_html.count("<tr>")
            return {"exists": True, "rows": rows, "html": len(self.detail_html)}
        if "divLSCT" in js and "innerHTML" in js:
            return self.detail_html
        raise AssertionError("JS không mong đợi: " + js[:60])


def test_read_day_opens_only_completed_slips_and_never_reuses_previous_detail(monkeypatch):
    monkeypatch.setattr(lr, "_open_results_popup", lambda driver: True)
    monkeypatch.setattr(lr.time, "sleep", lambda s: None)
    driver = FakeDriver({"P1": DETAIL_P1})
    out = lr.read_lab_results_for_day(driver, "09/11/2026")
    assert out["status"] == lr.STATUS_OK, out
    assert driver.opened == ["P1"]  # P2 chưa Hoàn tất: không mở
    p1, p2 = out["phieu"]
    assert [r["chi_so"] for r in p1["ket_qua"]] == ["WBC", "HGB"]
    assert p2["ket_qua"] == [] and p2["hoan_tat"] is False
    assert out["tom_tat"] == {"so_phieu": 2, "so_phieu_hoan_tat": 1, "so_phieu_cho": 1, "so_chi_so": 2, "so_bat_thuong": 1}


def test_stale_detail_from_previous_slip_is_not_read_as_next_slip(monkeypatch):
    """Tái hiện lỗi của cách chờ cũ ("khung chi tiết có chữ là xong"): phiếu thứ hai đọc lại chỉ số phiếu thứ nhất."""
    monkeypatch.setattr(lr, "_open_results_popup", lambda driver: True)
    monkeypatch.setattr(lr.time, "sleep", lambda s: None)
    listing = LISTING.replace("Đang thực hiện", "Hoàn tất")
    driver = FakeDriver({"P1": DETAIL_P1, "P2": DETAIL_OTHER})
    original = driver.execute_script

    def exec_with_listing(js, *args):
        if "divLichSuXNContent" in js and "innerHTML" in js:
            return listing
        return original(js, *args)

    driver.execute_script = exec_with_listing
    out = lr.read_lab_results_for_day(driver, "09/11/2026")
    assert out["status"] == lr.STATUS_OK, out
    assert [r["chi_so"] for r in out["phieu"][0]["ket_qua"]] == ["WBC", "HGB"]
    assert [r["chi_so"] for r in out["phieu"][1]["ket_qua"]] == ["Glucose"]


def test_popup_failure_is_error_not_none(monkeypatch):
    monkeypatch.setattr(lr, "_open_results_popup", lambda driver: False)
    out = lr.read_lab_results_for_day(object(), "09/11/2026")
    assert out["status"] == lr.STATUS_ERROR
    assert "Xem kết quả" in out["error"]


def test_day_without_slips_is_none(monkeypatch):
    monkeypatch.setattr(lr, "_open_results_popup", lambda driver: True)
    monkeypatch.setattr(lr.time, "sleep", lambda s: None)
    driver = FakeDriver({})
    out = lr.read_lab_results_for_day(driver, "01/01/2026")
    assert out["status"] == lr.STATUS_NONE and out["phieu"] == []
