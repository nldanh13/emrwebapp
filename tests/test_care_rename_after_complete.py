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
    calls = []
    monkeypatch.setattr(care_web_actions, "click_thu_hoi_cham_soc", lambda d: calls.append("thu_hoi") or True)
    monkeypatch.setattr(actions, "_chon_nguoi_lap_select2", lambda d, name: calls.append(("chon", name)) or True)
    monkeypatch.setattr(actions, "luu_va_hoan_tat", lambda d: calls.append("hoan_tat") or True)

    assert actions.doi_nguoi_lap_sau_hoan_tat(object(), "Điều Dưỡng B") is True
    assert calls == ["thu_hoi", ("chon", "Điều Dưỡng B"), "hoan_tat"]


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


def test_rename_for_other_account_only_saves(monkeypatch):
    """Đổi sang người có tài khoản khác: chỉ Lưu, để người đó đăng nhập Hoàn tất."""
    calls = []
    monkeypatch.setattr(care_web_actions, "click_thu_hoi_cham_soc", lambda d: calls.append("thu_hoi") or True)
    monkeypatch.setattr(actions, "_chon_nguoi_lap_select2", lambda d, name: calls.append(("chon", name)) or True)
    monkeypatch.setattr(actions, "luu_va_hoan_tat", lambda d: calls.append("hoan_tat") or True)
    monkeypatch.setattr(actions, "chi_luu", lambda d: calls.append("luu") or True)

    assert actions.doi_nguoi_lap_sau_hoan_tat(object(), "Điều Dưỡng B", hoan_tat=False) is True
    assert calls == ["thu_hoi", ("chon", "Điều Dưỡng B"), "luu"]


def test_input_care_queues_hoan_tat_for_owner_account():
    source = (WORKER / "input_care.py").read_text(encoding="utf-8")
    assert "doi_nguoi_lap_sau_hoan_tat(driver, nguoi_lap_cuoi, hoan_tat=False)" in source
    assert "keep_moi_time_keys=keep_moi_time_keys" in source
    phase2b = source.index("PHASE 2b")
    assert source.index("ws.switch_account(username_ht", phase2b) < source.index("hoan_tat_phieu_cho_duyet(ws, it)", phase2b)


def test_input_care_renames_only_after_hoan_tat():
    source = (WORKER / "input_care.py").read_text(encoding="utf-8")
    fill = source.index("form_ok = dien_thong_tin(")
    hoan_tat = source.index('By.ID, "btnPopupHOANTAT"', fill)
    rename = source.index("doi_nguoi_lap_sau_hoan_tat(driver, nguoi_lap_cuoi)")
    assert fill < hoan_tat < rename
    assert "nguoi_lap=" not in source[fill:hoan_tat]
