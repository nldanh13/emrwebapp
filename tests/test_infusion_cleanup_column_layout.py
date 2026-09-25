# -*- coding: utf-8 -*-
"""lay_danh_sach_chi_tiet_all_pages() phải đọc đúng cột của bảng "Phiếu theo
dõi truyền dịch" trên EMR hiện tại.

EMR đã thêm cột "Ngày tháng" ngay sau checkbox, đẩy lùi mọi cột phía sau 1
bậc so với trước — [0]checkbox [1]Ngày tháng [2]Tên dịch truyền [3]Thể tích
[4]Lô/Số sản xuất [5]Tốc độ [6]Bắt đầu [7]Kết thúc [8]Bác sĩ [9]Y tá
[10]Y lệnh [11]Thao tác. Nếu code vẫn đọc theo cấu trúc cũ (không có cột
Ngày tháng) sẽ lấy nhầm dữ liệu — vd tên dịch truyền đọc ra ngày tháng, thể
tích đọc ra chuỗi tên thuốc.
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

from infusion_cleanup import lay_danh_sach_chi_tiet_all_pages
from selenium.webdriver.common.by import By


class _FakeCell:
    def __init__(self, text=""):
        self.text = text

    def find_element(self, *_args, **_kwargs):
        raise RuntimeError("no <a> in this fake cell")


class _FakeCheckbox:
    def __init__(self, value):
        self._value = value

    def get_attribute(self, name):
        return self._value if name == "value" else ""


class _FakeRow:
    def __init__(self, cells, rec_id):
        self._cells = cells
        self._rec_id = rec_id

    def find_elements(self, by, tag):
        assert tag == "td"
        return self._cells

    def find_element(self, by, selector):
        if selector == "input.chkAddBn":
            return _FakeCheckbox(self._rec_id)
        raise RuntimeError(f"unexpected find_element: {selector}")

    @property
    def text(self):
        return " ".join(c.text for c in self._cells)


class _FakeDriver:
    def __init__(self, rows):
        self._rows = rows

    def find_element(self, by, selector):
        # Không có pagination div/ul trong bảng giả lập → chỉ 1 trang.
        raise RuntimeError(f"no element: {selector}")

    def find_elements(self, by, selector):
        if selector == "//tbody[@id='TableContentPhieuTruyenDich']/tr":
            return self._rows
        return []

    def execute_script(self, *_args, **_kwargs):
        return False


def _row(rec_id, ngay, ten, the_tich, lo_sx, toc_do, bat_dau, ket_thuc, bac_si, y_ta, y_lenh=""):
    cells = [
        _FakeCell(""),        # 0 checkbox
        _FakeCell(ngay),      # 1 Ngày tháng
        _FakeCell(ten),       # 2 Tên dịch truyền
        _FakeCell(the_tich),  # 3 Thể tích
        _FakeCell(lo_sx),     # 4 Lô/Số sản xuất
        _FakeCell(toc_do),    # 5 Tốc độ
        _FakeCell(bat_dau),   # 6 Bắt đầu
        _FakeCell(ket_thuc),  # 7 Kết thúc
        _FakeCell(bac_si),    # 8 Bác sĩ chỉ định
        _FakeCell(y_ta),      # 9 Y tá thực hiện
        _FakeCell(y_lenh),    # 10 Y lệnh
        _FakeCell(""),        # 11 Thao tác (Sao/Sửa/Xóa)
    ]
    return _FakeRow(cells, rec_id)


def test_scan_reads_correct_columns_from_current_emr_table():
    rows = [
        _row(
            "87e3bdf3-eed4-4af7-b9a8-b4c301126966",
            "12/09", "Paracetamol 10mg/ml", "100", "PA8430826", "100",
            "17:00", "17:20", "Ths. BS Phan Văn Tuấn", "Võ Thị Yến Nhi",
        ),
        _row(
            "95a9e613-46c8-4ceb-ab32-b4c30112bd51",
            "12/09", "Natri clorid 0,9% + Nefopam 20mg/2ml", "100", "SA11530826", "30",
            "20:00", "21:07", "Ths. BS Phan Văn Tuấn", "Võ Thị Yến Nhi",
        ),
    ]
    driver = _FakeDriver(rows)

    records, total_pages = lay_danh_sach_chi_tiet_all_pages(driver, wait=None)

    assert total_pages == 1
    all_infos = [info for infos in records.values() for info in infos]
    assert len(all_infos) == 2

    paracetamol = next(i for i in all_infos if i["id"] == "87e3bdf3-eed4-4af7-b9a8-b4c301126966")
    assert paracetamol["ten"].lower() == "paracetamol 10mg/ml"
    assert paracetamol["the_tich"] == 100
    assert paracetamol["toc_do"] == 100
    assert paracetamol["tg_bat_dau"] == "17:00"
    assert paracetamol["tg_ket_thuc"] == "17:20"
    assert "tuan" in paracetamol["bac_si"].lower()
    assert "nhi" in paracetamol["y_ta"].lower()
    assert "phan van tuan" in paracetamol["bac_si_key"]
    assert "vo thi yen nhi" in paracetamol["y_ta_key"]

    natri = next(i for i in all_infos if i["id"] == "95a9e613-46c8-4ceb-ab32-b4c30112bd51")
    assert natri["ten"].lower().startswith("natri clorid")
    assert natri["the_tich"] == 100
    assert natri["toc_do"] == 30
    assert "vo thi yen nhi" in natri["y_ta_key"]


class _FakeSubRow(_FakeRow):
    def __init__(self, cells):
        super().__init__(cells, "")


def test_scan_merges_two_row_record_of_drug_and_diluent():
    """Form mới: thuốc pha chiếm 2 dòng (rowspan) — dòng 2 chỉ có [Tên, Số lô]
    của dung dịch pha. Phải gộp thành 1 bản ghi "Trasolu + Natri clorid 0,9%"."""
    main = _row(
        "dca0513b-488a-4f11-9719-b4d000c86385",
        "25/09", "Trasolu", "100", "020326", "30",
        "12:02", "13:09", "TS. BS Trần Nguyễn Anh Duy", "Võ Thị Yến Nhi", "07:00 23/09/2026",
    )
    main._cells.append(_FakeCell(""))  # 12 Thao tác (cột 11 giờ là Ghi chú)
    sub = _FakeSubRow([_FakeCell("Natri clorid 0,9%"), _FakeCell("SA1210826")])
    records, _ = lay_danh_sach_chi_tiet_all_pages(_FakeDriver([main, sub]), wait=None)

    infos = [i for v in records.values() for i in v]
    assert len(infos) == 1
    info = infos[0]
    assert info["id"] == "dca0513b-488a-4f11-9719-b4d000c86385"
    assert info["the_tich"] == 100 and info["toc_do"] == 30
    assert info["y_lenh"] == "07:00 23/09/2026"

    from infusion_cleanup import _compare_med_vs_web
    med = {
        "Full_Name": "TRASOLU + Natri clorid 0.9%", "Time_Start_Str": "12:02",
        "The_Tich": 100, "Toc_Do": "30", "Bac_Si": "Trần Nguyễn Anh Duy",
    }
    assert _compare_med_vs_web(med, info, "Võ Thị Yến Nhi") == []
    med_rev = dict(med, Full_Name="Natri clorid 0,9% + Trasolu")
    assert _compare_med_vs_web(med_rev, info, "Võ Thị Yến Nhi") == []
