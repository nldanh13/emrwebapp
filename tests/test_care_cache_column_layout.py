# -*- coding: utf-8 -*-
"""scan_cham_soc_cache() phải đọc đúng cột của bảng "Thông tin chăm sóc" trên
EMR hiện tại, và lấy đúng id để Sửa/Xóa phiếu.

EMR đã thêm cột "Tác vụ" (chứa link Sao/Sửa/Xóa) ngay sau checkbox, đẩy lùi
mọi cột phía sau 1 bậc — [0]checkbox [1]Tác vụ [2]TT [3]Thời gian
[4]Người lập [5]N.T [6]T. [7]M [8]H.A [9]C.N [10]Diễn biến [11]Chăm sóc.
Nếu code vẫn đọc theo cấu trúc cũ (không có cột Tác vụ, [1]=TT [2]=Thời gian
[3]=Người lập...) thì mốc giờ đọc ra sẽ là chữ trạng thái ("Hoàn tất") —
không parse được thành giờ → toàn bộ phiếu bị bỏ qua, cache luôn rỗng, và
id sửa/xóa (lấy từ cột checkbox cũ, vốn không có link nào) luôn None.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

from care_cache import scan_cham_soc_cache
from selenium.webdriver.common.by import By


class _FakeLink:
    def __init__(self, text, onclick):
        self.text = text
        self._onclick = onclick

    def get_attribute(self, name):
        return self._onclick if name == "onclick" else ""


class _FakeCell:
    def __init__(self, text="", links=None):
        self.text = text
        self._links = links or []

    def find_element(self, by, tag):
        if self._links:
            return self._links[0]
        raise RuntimeError("no <a> in this fake cell")

    def find_elements(self, by, tag):
        return self._links


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
    def __init__(self, rows):
        self._rows = rows

    def find_element(self, by, selector):
        if selector == "ul.pagination li a.currentPaging":
            return _FakePaginationLabel("Trang 1/1")
        raise RuntimeError(f"unexpected find_element: {selector}")

    def find_elements(self, by, selector):
        if selector == "#divDanhSachChamSocContent table tbody tr":
            return self._rows
        raise RuntimeError(f"unexpected find_elements: {selector}")


def _real_row(rec_id, time_full, creator, dien_bien, cham_soc):
    """Dựng 1 dòng đúng y cấu trúc HTML thật EMR trả về (12 cột)."""
    tac_vu_links = [
        _FakeLink("Sao", f"fnOnSaoChepCSDD('{rec_id}');"),
        _FakeLink("Sửa", f"onDrawWebpartChamSoc('{rec_id}')"),
        _FakeLink("Xóa", f"fnSideDeleteChamSoc('{rec_id}');"),
    ]
    cells = [
        _FakeCell(""),                                          # 0 checkbox
        _FakeCell("", links=tac_vu_links),                       # 1 Tác vụ
        _FakeCell("Hoàn tất"),                                   # 2 TT
        _FakeCell(time_full, links=[tac_vu_links[1]]),           # 3 Thời gian (cũng có onDrawWebpartChamSoc)
        _FakeCell(creator),                                      # 4 Người lập
        _FakeCell("20"), _FakeCell("37"), _FakeCell("86"), _FakeCell("140/90"), _FakeCell(""),  # 5-9 vitals
        _FakeCell(dien_bien),                                    # 10 Diễn biến
        _FakeCell(cham_soc),                                     # 11 Chăm sóc
    ]
    return _FakeRow(cells)


def test_scan_reads_correct_columns_and_ids_from_current_emr_table():
    rows = [
        _real_row(
            "a30af2b0-7a1e-4c64-a986-b4cb00b2b943",
            "05:00 21/09/2026", "Thạch Thị Thúy Đa",
            "Người bệnh tỉnh", "Lấy dấu hiệu sinh tồn",
        ),
    ]
    driver = _FakeDriver(rows)

    cache, entries = scan_cham_soc_cache(driver, "21/09/2026")

    assert len(entries) == 1
    e = entries[0]
    assert e["time_full"] == "05:00 21/09/2026"
    assert e["status"] == "Hoàn tất"
    assert e["creator"] == "Thạch Thị Thúy Đa"
    assert e["dien_bien"] == "Người bệnh tỉnh"
    assert e["cham_soc"] == "Lấy dấu hiệu sinh tồn"
    assert e["id_edit"] == "a30af2b0-7a1e-4c64-a986-b4cb00b2b943"
    assert e["id_delete"] == "a30af2b0-7a1e-4c64-a986-b4cb00b2b943"
    assert "05:00 21/09/2026" in cache


def test_id_delete_still_found_when_time_cell_has_no_link():
    """Nếu chỉ cột Tác vụ có link Xóa (không có link trên chữ giờ), vẫn lấy được id_delete."""
    tac_vu_links = [_FakeLink("Xóa", "fnSideDeleteChamSoc('only-in-tac-vu');")]
    cells = [
        _FakeCell(""),
        _FakeCell("", links=tac_vu_links),
        _FakeCell("Mới"),
        _FakeCell("08:00 20/09/2026"),  # không có <a>
        _FakeCell("Điều Dưỡng Test"),
        _FakeCell(""), _FakeCell(""), _FakeCell(""), _FakeCell(""), _FakeCell(""),
        _FakeCell("Người bệnh tỉnh"),
        _FakeCell("Lấy dấu hiệu sinh tồn"),
    ]
    driver = _FakeDriver([_FakeRow(cells)])

    cache, entries = scan_cham_soc_cache(driver, "20/09/2026")

    assert len(entries) == 1
    assert entries[0]["id_edit"] is None
    assert entries[0]["id_delete"] == "only-in-tac-vu"
