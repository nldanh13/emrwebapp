# -*- coding: utf-8 -*-
"""Log người dùng 05/10/2026 (bản cũ):
- Phiếu 08:00/16:00 trạng thái 'Mới' bị coi là PERFECT nên không bao giờ được Hoàn tất.
- Sửa/xóa phiếu đứng tên người trực lại đổi sang tài khoản người đó (lndieu -> vtynhi)
  dù tài khoản ca làm đang dùng làm được (macro người dùng: không cần đổi tài khoản).
Quy tắc mới: làm bằng tài khoản đang dùng trước; chỉ khi EMR không cho mới đổi sang
tài khoản người lập, xong thì đổi lại."""
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

import care_cache
import care_web_actions
from shared import worker_session as ws_mod
from shared.worker_session import WorkerSession

TIME = "08:00 05/10/2026"


def _entry(status):
    return {
        "status": status, "creator": "Thạch Thị Thúy Đa", "cham_soc": "Theo dõi dấu hiệu sinh tồn",
        "dien_bien": "Người bệnh tỉnh", "hhmm": "08:00", "id_edit": "abc-123",
    }


def _check(status):
    return care_cache.kiem_tra_bang_cached(
        {TIME: [_entry(status)]}, TIME, 8, "Theo dõi dấu hiệu sinh tồn", ["Thạch Thị Thúy Đa"],
        "Người bệnh tỉnh", expected_creator="Thạch Thị Thúy Đa",
    )


def test_completed_matching_row_is_perfect():
    assert _check("Hoàn tất")[0] == "PERFECT"


def test_matching_row_still_moi_must_be_completed_not_perfect():
    stt, care_id, creator = _check("Mới")
    assert stt == "UPDATE"
    assert care_id == "abc-123"


def _session(username="lndieu"):
    ws = WorkerSession({"username": username, "password": "pw"}, os.devnull)
    ws.switches = []

    def fake_switch_to(username, password, ma_bn, **_kw):
        if username != ws.config["username"]:
            ws.switches.append(username)
            ws.config = dict(ws.config, username=username, password=password)
        return True

    ws.switch_account_to = fake_switch_to
    return ws


def test_action_done_with_current_account_does_not_switch(monkeypatch):
    monkeypatch.setattr(ws_mod, "get_emr_account_for_nurse", lambda n: {"username": "vtynhi", "password": "p"})
    ws = _session()
    calls = []
    assert ws.run_with_creator_fallback("Võ Thị Yến Nhi", "123", lambda: calls.append(ws.config["username"]) or True)
    assert calls == ["lndieu"]
    assert ws.switches == []


def test_action_refused_falls_back_to_creator_then_restores(monkeypatch):
    monkeypatch.setattr(ws_mod, "get_emr_account_for_nurse", lambda n: {"username": "vtynhi", "password": "p"})
    ws = _session()
    calls = []

    def action():
        calls.append(ws.config["username"])
        return ws.config["username"] == "vtynhi"

    assert ws.run_with_creator_fallback("Võ Thị Yến Nhi", "123", action)
    assert calls == ["lndieu", "vtynhi"]
    assert ws.switches == ["vtynhi", "lndieu"]
    assert ws.config["username"] == "lndieu"


def test_no_retry_when_creator_is_current_account_or_unknown(monkeypatch):
    ws = _session()
    monkeypatch.setattr(ws_mod, "get_emr_account_for_nurse", lambda n: {"username": "lndieu", "password": "pw"})
    calls = []
    assert ws.run_with_creator_fallback("Lê Ngọc Diệu", "123", lambda: calls.append(1) and False) is False
    monkeypatch.setattr(ws_mod, "get_emr_account_for_nurse", lambda n: None)
    assert ws.run_with_creator_fallback("Người Lạ", "123", lambda: calls.append(1) and False) is False
    assert calls == [1, 1] and ws.switches == []


class _Badge:
    def __init__(self, driver):
        self.driver = driver


def test_unlock_open_form_thu_hoi_then_checks_badge(monkeypatch):
    state = {"badge": "Hoàn tất", "allowed": True}
    monkeypatch.setattr(care_web_actions, "check_trang_thai_badge", lambda d: state["badge"])

    def fake_thu_hoi(d, timeout=5):
        if state["allowed"]:
            state["badge"] = "Mới"
        return True

    monkeypatch.setattr(care_web_actions, "click_thu_hoi_cham_soc", fake_thu_hoi)
    monkeypatch.setattr(care_web_actions, "_hien", lambda d, element_id: True)
    assert care_web_actions.mo_khoa_phieu_dang_mo(object()) is True

    state.update(badge="Hoàn tất", allowed=False)
    assert care_web_actions.mo_khoa_phieu_dang_mo(object()) is False


def test_input_care_tries_current_account_before_creator():
    src = (WORKER / "input_care.py").read_text(encoding="utf-8")
    update = src.index('if stt == "UPDATE":')
    # Sửa phiếu cũ: thử mở khóa bằng tài khoản đang dùng trước; không được thì để cuối lượt
    # (không đổi tài khoản giữa chừng).
    assert src.index("if _mo_khoa_phieu_cu():", update) < src.index("_defer(job, time_str, existing_creator)", update)
    assert "ws.switch_to_creator_account(existing_creator" not in src
    assert "run_with_creator_fallback(existing_creator" in src
    cleanup = (WORKER / "care_cache.py").read_text(encoding="utf-8")
    assert "ws.switch_to_creator_account(creator" not in cleanup
    assert cleanup.count("run_with_creator_fallback(") >= 3
