# -*- coding: utf-8 -*-
"""scan_cham_soc_cache() phải dừng quét ngay khi gặp ranh giới chuyển khoa.

Bảng "Thông tin chăm sóc" liệt kê khoa điều trị HIỆN TẠI trước, rồi tới các
khoa điều trị CŨ (nếu BN từng chuyển khoa) — phân cách bằng dòng tiêu đề
"Khoa điều trị thứ N : ...". Các phiếu thuộc khoa cũ không còn sửa/xóa được
(BN đã rời khoa đó) nên không cần quét tiếp khi gặp dòng tiêu đề THỨ HAI.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

from care_cache import scan_cham_soc_cache
from selenium.webdriver.common.by import By


class _FakeCell:
    def __init__(self, text=""):
        self.text = text

    def find_element(self, *_args, **_kwargs):
        raise RuntimeError("no <a> in this fake cell")

    def find_elements(self, *_args, **_kwargs):
        return []


class _FakeRow:
    def __init__(self, cells, text=""):
        self._cells = cells
        self.text = text

    def find_elements(self, by, tag):
        assert tag == "td"
        return self._cells


class _FakePaginationLabel:
    def __init__(self, text):
        self.text = text


class _FakeDriver:
    def __init__(self, rows, total_pages=1, current_page1=1):
        self._rows = rows
        self._pagination_text = f"Trang {current_page1}/{total_pages}"

    def find_element(self, by, selector):
        if selector == "ul.pagination li a.currentPaging":
            return _FakePaginationLabel(self._pagination_text)
        raise RuntimeError(f"unexpected find_element: {selector}")

    def find_elements(self, by, selector):
        if selector == "#divDanhSachChamSocContent table tbody tr":
            return self._rows
        raise RuntimeError(f"unexpected find_elements: {selector}")


def _department_header_row(text):
    return _FakeRow([_FakeCell(""), _FakeCell(text)], text=text)


def _data_row(time_full, cham_soc, dien_bien="Người bệnh tỉnh", creator="Điều Dưỡng Test"):
    # Cấu trúc cột thật trên EMR: [0]checkbox [1]Tác vụ [2]TT [3]Thời gian
    # [4]Người lập [5]N.T [6]T. [7]M [8]H.A [9]C.N [10]Diễn biến [11]Chăm sóc.
    cells = [_FakeCell("") for _ in range(12)]
    cells[2] = _FakeCell("Hoàn tất")
    cells[3] = _FakeCell(time_full)
    cells[4] = _FakeCell(creator)
    cells[10] = _FakeCell(dien_bien)
    cells[11] = _FakeCell(cham_soc)
    return _FakeRow(cells)


def test_scan_stops_at_second_department_header_and_ignores_older_rows():
    rows = [
        _department_header_row(
            "Khoa điều trị thứ 2 : Khoa Ngoại Chấn Thương Chỉnh Hình và Thần Kinh "
            "(Ngày vào: 10:27 20/09/2026 - Chẩn đoán: Viêm mô bào ở các phần khác của chi)"
        ),
        _data_row("05:00 21/09/2026", "Lấy dấu hiệu sinh tồn"),
        _data_row("22:00 20/09/2026", "Thực hiện chỉ định thuốc"),
        _data_row("16:00 20/09/2026", "Lấy dấu hiệu sinh tồn\nThực hiện chỉ định thuốc"),
        _data_row("10:30 20/09/2026", "Nhận HS + 3 XQ (4phim) + 1MRI CS"),
        _department_header_row(
            "Khoa điều trị thứ 1 : Khoa Nội Tổng Hợp "
            "(Ngày vào: 21:49 08/09/2026 - Chẩn đoán: Nhiễm trùng huyết do vi trùng gram âm khác)"
        ),
        # Các dòng dưới đây thuộc khoa CŨ — không được đưa vào cache.
        _data_row("10:00 20/09/2026", "thực hiện y lệnh"),
        _data_row("08:47 20/09/2026", "thực hiện y lệnh"),
    ]
    driver = _FakeDriver(rows, total_pages=1)

    cache, entries = scan_cham_soc_cache(driver, "20/09/2026")

    scanned_times = {e["time_full"] for e in entries}
    assert scanned_times == {
        "05:00 21/09/2026",
        "22:00 20/09/2026",
        "16:00 20/09/2026",
        "10:30 20/09/2026",
    }
    assert "10:00 20/09/2026" not in cache
    assert "08:47 20/09/2026" not in cache


def test_scan_without_department_change_reads_all_rows_normally():
    rows = [
        _department_header_row("Khoa điều trị thứ 1 : Khoa Nội Tổng Hợp (Ngày vào: 08:00 20/09/2026)"),
        _data_row("08:00 20/09/2026", "Lấy dấu hiệu sinh tồn"),
        _data_row("16:00 20/09/2026", "Lấy dấu hiệu sinh tồn"),
    ]
    driver = _FakeDriver(rows, total_pages=1)

    cache, entries = scan_cham_soc_cache(driver, "20/09/2026")

    assert {e["time_full"] for e in entries} == {"08:00 20/09/2026", "16:00 20/09/2026"}
