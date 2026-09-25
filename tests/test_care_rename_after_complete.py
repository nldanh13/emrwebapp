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


def test_form_fills_explicit_creator_instead_of_shift_nurse(monkeypatch):
    class DummyDriver:
        def find_element(self, *args, **kwargs):
            raise RuntimeError("field unavailable in unit test")

    chosen = []
    monkeypatch.setattr(actions, "get_nurse_by_shift", lambda *_a, **_k: "Điều Dưỡng B")
    monkeypatch.setattr(actions, "_chon_nguoi_lap_select2", lambda d, name: chosen.append(name) or True)

    assert actions.dien_thong_tin(
        DummyDriver(), 20, "20:00 03/08/2026", "Thực hiện chỉ định thuốc",
        ["Điều Dưỡng A"], "Người bệnh tỉnh", config_ten_goc={}, nguoi_lap="Điều Dưỡng A",
    ) is True
    assert chosen == ["Điều Dưỡng A"]


def test_input_care_no_longer_logs_in_per_shift_nurse():
    source = (WORKER / "input_care.py").read_text(encoding="utf-8")
    assert "get_emr_account_for_nurse" not in source
    assert "doi_nguoi_lap_sau_hoan_tat(driver, nguoi_lap_cuoi)" in source
