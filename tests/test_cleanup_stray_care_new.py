# -*- coding: utf-8 -*-
"""cleanup_stray_care_new.py — quét dọn phiếu chăm sóc 'Mới' tồn đọng trên
nhiều ngày/nhiều BN (khác input_care.py, vốn chỉ dọn quanh ±1 ngày)."""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

from cleanup_stray_care_new import (
    _find_stray_new_entries, _lay_danh_sach_ten, _load_patients, _build_stray_infos,
)
import cleanup_stray_care_new
from care_cache import scan_cham_soc_cache
from selenium.webdriver.common.by import By


def test_build_stray_infos_groups_by_emr_account_and_flags_unconfigured(monkeypatch):
    accounts = {
        "le ngoc dieu": {"username": "dieu.emr", "password": "pass1"},
    }

    def fake_get_account(name):
        return accounts.get((name or "").strip().lower())

    monkeypatch.setattr(cleanup_stray_care_new, "get_emr_account_for_nurse", fake_get_account)

    stray = [
        {"creator": "le ngoc dieu", "time_full": "08:00 19/09/2026", "cham_soc": "a", "dien_bien": "", "id_delete": "id1"},
        {"creator": "le ngoc dieu", "time_full": "09:00 19/09/2026", "cham_soc": "b", "dien_bien": "", "id_delete": "id2"},
        {"creator": "nguoi da nghi", "time_full": "10:00 19/09/2026", "cham_soc": "c", "dien_bien": "", "id_delete": "id3"},
    ]

    infos, by_username, passwords = _build_stray_infos(stray)

    assert len(infos) == 3
    assert passwords == {"dieu.emr": "pass1"}
    assert [i["id_delete"] for i in by_username["dieu.emr"]] == ["id1", "id2"]

    unconfigured = next(i for i in infos if i["creator"] == "nguoi da nghi")
    assert unconfigured["emr_account"] is None
    assert "nguoi da nghi" in unconfigured["delete_blocked_reason"]
    assert "nguoi da nghi" not in by_username


def test_lay_danh_sach_ten_flattens_work_and_oncall_across_days():
    config = {
        "ds_dieu_duong": ["Lê Ngọc Diệu"],
        "ten_dieu_duong": {
            "Monday": {"work": ["Lê Ngọc Diệu"], "oncall": ["Lê Thị Tuyết Đoan"]},
            "Default": {"work": ["Lê Ngọc Diệu"], "oncall": ["Võ Phương Duy"]},
            "days": {
                "2026-09-20": {"work": ["Nguyễn Ngọc Xuyến"], "oncall": []},
            },
        },
    }
    names = _lay_danh_sach_ten(config)
    assert set(names) == {"Lê Ngọc Diệu", "Lê Thị Tuyết Đoan", "Võ Phương Duy", "Nguyễn Ngọc Xuyến"}


def test_lay_danh_sach_ten_includes_roster_names_not_in_current_schedule():
    """Điều dưỡng đã nghỉ/đổi ca có thể còn trong roster nhưng không còn ở lịch
    trực hiện tại — vẫn phải nhận diện được để không bỏ sót phiếu tồn đọng cũ."""
    config = {
        "ds_dieu_duong": ["Lê Ngọc Diệu", "Người Đã Nghỉ"],
        "ten_dieu_duong": {"Default": {"work": ["Lê Ngọc Diệu"], "oncall": []}},
    }
    names = _lay_danh_sach_ten(config)
    assert "Người Đã Nghỉ" in names


def test_lay_danh_sach_ten_merges_extra_names():
    config = {"ds_dieu_duong": ["Lê Ngọc Diệu"], "ten_dieu_duong": {}}
    names = _lay_danh_sach_ten(config, extra_names=["Nguyễn Văn Cũ"])
    assert set(names) == {"Lê Ngọc Diệu", "Nguyễn Văn Cũ"}


def test_load_patients_accepts_plain_strings_and_objects(tmp_path):
    p = tmp_path / "patients.json"
    p.write_text('["BN001", {"ma_bn": "BN002", "ho_ten": "Nguyễn Văn A"}, {"ho_ten": "thiếu mã"}]', encoding="utf-8")
    patients = _load_patients(str(p))
    assert patients == [
        {"ma_bn": "BN001", "ho_ten": ""},
        {"ma_bn": "BN002", "ho_ten": "Nguyễn Văn A"},
    ]


def test_find_stray_new_entries_only_matches_tool_created_new_status():
    list_nurse = ["Lê Ngọc Diệu"]
    all_entries = [
        # Đúng: Mới + người lập trong danh sách + nội dung kiểu tool.
        {"status": "Mới", "creator": "Lê Ngọc Diệu", "cham_soc": "Thực hiện chỉ định thuốc", "dien_bien": "Người bệnh tỉnh"},
        # Không phải Mới -> bỏ qua.
        {"status": "Hoàn tất", "creator": "Lê Ngọc Diệu", "cham_soc": "Thực hiện chỉ định thuốc", "dien_bien": ""},
        # Người lập không thuộc danh sách điều dưỡng -> bỏ qua (không phải phiếu do tool tạo).
        {"status": "Mới", "creator": "Người Lạ", "cham_soc": "Thực hiện chỉ định thuốc", "dien_bien": ""},
        # Nội dung không giống mẫu tool tạo -> bỏ qua (có thể do người thật gõ tay).
        {"status": "Mới", "creator": "Lê Ngọc Diệu", "cham_soc": "ghi chú lạ không liên quan", "dien_bien": ""},
    ]
    stray = _find_stray_new_entries(all_entries, list_nurse)
    assert len(stray) == 1
    assert stray[0]["creator"] == "Lê Ngọc Diệu"


def test_find_stray_new_entries_skips_records_too_recent_by_default():
    """Tránh xóa nhầm phiếu đang được thao tác dở — bỏ qua phiếu quá gần hiện tại."""
    from datetime import datetime

    now = datetime(2026, 9, 21, 15, 0)
    list_nurse = ["Lê Ngọc Diệu"]
    all_entries = [
        {  # Mới nhập 1 giờ trước -> quá gần, không tính là tồn đọng.
            "status": "Mới", "creator": "Lê Ngọc Diệu",
            "cham_soc": "Thực hiện chỉ định thuốc", "dien_bien": "",
            "time_full": "14:00 21/09/2026",
        },
        {  # Từ 2 ngày trước -> đủ cũ, tính là tồn đọng.
            "status": "Mới", "creator": "Lê Ngọc Diệu",
            "cham_soc": "Thực hiện chỉ định thuốc", "dien_bien": "",
            "time_full": "08:00 19/09/2026",
        },
    ]
    stray = _find_stray_new_entries(all_entries, list_nurse, min_age_hours=6, now=now)
    assert len(stray) == 1
    assert stray[0]["time_full"] == "08:00 19/09/2026"

    # min_age_hours=0 tắt bộ lọc, giữ cả 2.
    stray_no_filter = _find_stray_new_entries(all_entries, list_nurse, min_age_hours=0, now=now)
    assert len(stray_no_filter) == 2


class _FakeCell:
    def __init__(self, text=""):
        self.text = text

    def find_element(self, *_a, **_k):
        raise RuntimeError("no <a>")

    def find_elements(self, *_a, **_k):
        return []


class _FakeRow:
    def __init__(self, cells, text=""):
        self._cells = cells
        self.text = text

    def find_elements(self, by, tag):
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


def _row(time_full, status="Hoàn tất", creator="Test"):
    cells = [_FakeCell("") for _ in range(12)]
    cells[2] = _FakeCell(status)
    cells[3] = _FakeCell(time_full)
    cells[4] = _FakeCell(creator)
    cells[10] = _FakeCell("Người bệnh tỉnh")
    cells[11] = _FakeCell("Thực hiện chỉ định thuốc")
    return _FakeRow(cells)


def test_scan_all_dates_ignores_date_window_restriction():
    # Các mốc giờ trải trên NHIỀU ngày cách xa nhau — quét thường (all_dates=False)
    # sẽ chỉ giữ đúng 1 ngày + hôm sau; all_dates=True phải giữ hết.
    rows = [
        _row("08:00 01/01/2026"),
        _row("08:00 15/06/2026"),
        _row("08:00 21/09/2026"),
    ]
    driver = _FakeDriver(rows)

    _cache_normal, entries_normal = scan_cham_soc_cache(driver, "21/09/2026")
    assert {e["time_full"] for e in entries_normal} == {"08:00 21/09/2026"}

    _cache_all, entries_all = scan_cham_soc_cache(driver, "", all_dates=True)
    assert {e["time_full"] for e in entries_all} == {
        "08:00 01/01/2026", "08:00 15/06/2026", "08:00 21/09/2026",
    }
