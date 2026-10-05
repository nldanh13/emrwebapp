# -*- coding: utf-8 -*-
"""Phiếu ca trực: tạo + Hoàn tất dưới tên chủ tài khoản, rồi mới Thu hồi đổi
Người lập (EMR báo lỗi nếu đổi tên ngay lúc tạo phiếu)."""
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

import care_form_actions as actions
import care_web_actions


def test_rename_runs_thu_hoi_then_select_then_complete(monkeypatch):
    """Đúng các bước người dùng ghi macro: Thu hồi → xác nhận → chọn Người lập
    → Hoàn tất → xác nhận, cùng tài khoản đang đăng nhập (không bấm Lưu trước)."""
    calls = []
    monkeypatch.setattr(care_web_actions, "click_thu_hoi_cham_soc", lambda d: calls.append("thu_hoi") or True)
    monkeypatch.setattr(actions, "_bam_xac_nhan_cham_soc", lambda d: calls.append("xac_nhan") or True)
    monkeypatch.setattr(actions, "_chon_nguoi_lap_select2", lambda d, name: calls.append(("chon", name)) or True)
    monkeypatch.setattr(actions, "hoan_tat_ngay", lambda d: calls.append("hoan_tat") or True)
    monkeypatch.setattr(actions, "luu_va_hoan_tat", lambda d: calls.append("luu_hoan_tat") or True)

    assert actions.doi_nguoi_lap_sau_hoan_tat(object(), "Điều Dưỡng B") is True
    assert calls == ["thu_hoi", "xac_nhan", ("chon", "Điều Dưỡng B"), "hoan_tat"]


def test_rename_falls_back_to_save_then_complete(monkeypatch):
    calls = []
    monkeypatch.setattr(care_web_actions, "click_thu_hoi_cham_soc", lambda d: True)
    monkeypatch.setattr(actions, "_bam_xac_nhan_cham_soc", lambda d: True)
    monkeypatch.setattr(actions, "_chon_nguoi_lap_select2", lambda d, name: True)
    monkeypatch.setattr(actions, "hoan_tat_ngay", lambda d: calls.append("hoan_tat") or False)
    monkeypatch.setattr(actions, "luu_va_hoan_tat", lambda d: calls.append("luu_hoan_tat") or True)

    assert actions.doi_nguoi_lap_sau_hoan_tat(object(), "Điều Dưỡng B") is True
    assert calls == ["hoan_tat", "luu_hoan_tat"]


def test_rename_stops_when_thu_hoi_fails(monkeypatch):
    calls = []
    monkeypatch.setattr(care_web_actions, "click_thu_hoi_cham_soc", lambda d: False)
    monkeypatch.setattr(actions, "_chon_nguoi_lap_select2", lambda d, name: calls.append("chon") or True)
    monkeypatch.setattr(actions, "luu_va_hoan_tat", lambda d: calls.append("hoan_tat") or True)

    assert actions.doi_nguoi_lap_sau_hoan_tat(object(), "Điều Dưỡng B") is False
    assert calls == []


def test_same_creator_ignores_accents_and_titles():
    assert actions.cung_nguoi_lap("ĐD. Lê Ngọc Diệu", "le ngoc dieu")
    assert not actions.cung_nguoi_lap("Lê Ngọc Diệu", "Thạch Thị Thúy Đa")
    assert not actions.cung_nguoi_lap("", "Thạch Thị Thúy Đa")


def test_rename_only_save_mode_still_available(monkeypatch):
    calls = []
    monkeypatch.setattr(care_web_actions, "click_thu_hoi_cham_soc", lambda d: calls.append("thu_hoi") or True)
    monkeypatch.setattr(actions, "_bam_xac_nhan_cham_soc", lambda d: True)
    monkeypatch.setattr(actions, "_chon_nguoi_lap_select2", lambda d, name: calls.append(("chon", name)) or True)
    monkeypatch.setattr(actions, "chi_luu", lambda d: calls.append("luu") or True)

    assert actions.doi_nguoi_lap_sau_hoan_tat(object(), "Điều Dưỡng B", hoan_tat=False) is True
    assert calls == ["thu_hoi", ("chon", "Điều Dưỡng B"), "luu"]


def test_input_care_renames_and_completes_without_switching_account():
    """Macro người dùng: tài khoản ca làm Thu hồi, đổi Người lập sang người trực
    rồi Hoàn tất luôn — không đăng nhập tài khoản người trực."""
    source = (WORKER / "input_care.py").read_text(encoding="utf-8")
    assert "doi_nguoi_lap_sau_hoan_tat(driver, nguoi_lap_cuoi)" in source
    assert "hoan_tat=False" not in source
    assert "PHASE 2b" not in source
    assert "pending_hoan_tat" not in source
    assert "get_emr_account_for_nurse(nguoi_lap_cuoi)" not in source


def test_input_care_renames_only_after_hoan_tat():
    source = (WORKER / "input_care.py").read_text(encoding="utf-8")
    fill = source.index("form_ok = dien_thong_tin(")
    hoan_tat = source.index('By.ID, "btnPopupHOANTAT"', fill)
    rename = source.index("doi_nguoi_lap_sau_hoan_tat(driver, nguoi_lap_cuoi)")
    assert fill < hoan_tat < rename
    assert "nguoi_lap=" not in source[fill:hoan_tat]


# Log 05/10/2026: phiếu 05:00/06:00 06/10 còn 'Mới' đứng tên Võ Thị Yến Nhi (bản cũ để lại),
# tài khoản ca làm (tttda) sửa rồi Lưu/Hoàn tất thất bại 3 lần. Làm như macro: đưa Người lập về
# chủ tài khoản → Hoàn tất → Thu hồi → đổi Người lập sang người trực → Hoàn tất.

def test_reset_creator_to_account_owner_when_other_name(monkeypatch):
    calls = []
    monkeypatch.setattr(actions, "doc_nguoi_lap_hien_tai", lambda d: "Võ Thị Yến Nhi")
    monkeypatch.setattr(actions, "_chon_nguoi_lap_select2", lambda d, name: calls.append(name) or True)
    assert actions.dat_nguoi_lap_ve_chu_tai_khoan(object(), "Thạch Thị Thúy Đa") is True
    assert calls == ["Thạch Thị Thúy Đa"]


def test_reset_creator_noop_when_already_owner_or_owner_unknown(monkeypatch):
    calls = []
    monkeypatch.setattr(actions, "doc_nguoi_lap_hien_tai", lambda d: "ĐD. Thạch Thị Thúy Đa")
    monkeypatch.setattr(actions, "_chon_nguoi_lap_select2", lambda d, name: calls.append(name) or True)
    assert actions.dat_nguoi_lap_ve_chu_tai_khoan(object(), "Thạch Thị Thúy Đa") is True
    assert actions.dat_nguoi_lap_ve_chu_tai_khoan(object(), "") is False
    assert calls == []


def test_input_care_update_resets_creator_before_filling():
    source = (WORKER / "input_care.py").read_text(encoding="utf-8")
    update = source.index('if stt == "UPDATE":')
    reset = source.index("dat_nguoi_lap_ve_chu_tai_khoan(driver, current_owner_name)", update)
    fill = source.index("form_ok = dien_thong_tin(", update)
    assert reset < fill
