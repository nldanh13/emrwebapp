# -*- coding: utf-8 -*-
"""WorkerSession.switch_account_to / switch_to_creator_account / restore_account
là ĐIỂM DUY NHẤT xử lý đổi/khôi phục tài khoản EMR — mọi luồng nhập liệu
(chăm sóc, phòng khám, dịch truyền, công cụ dọn phiếu...) đều gọi qua đây
thay vì tự cài lại logic riêng, để sau này EMR đổi cách xác thực/đổi tài
khoản thì chỉ cần sửa 1 chỗ."""
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WORKER = os.path.join(ROOT, 'worker')
if WORKER not in sys.path:
    sys.path.insert(0, WORKER)

from shared.worker_session import WorkerSession


def _make_ws(username="acct.goc"):
    return WorkerSession({"username": username, "password": "pw_goc"}, "unused_result.json")


def test_switch_account_to_noop_when_already_correct_account(monkeypatch):
    ws = _make_ws("acct.a")
    called = []
    monkeypatch.setattr(ws, "switch_account", lambda u, p: called.append((u, p)) or True)
    assert ws.switch_account_to("acct.a", "pw", "BN1") is True
    assert called == []


def test_switch_account_to_switches_and_calls_custom_reopen(monkeypatch):
    ws = _make_ws("acct.a")
    switch_calls = []
    monkeypatch.setattr(ws, "switch_account", lambda u, p: switch_calls.append((u, p)) or True)
    reopen_calls = []
    ok = ws.switch_account_to(
        "acct.b", "pw_b", "BN1",
        reopen=lambda w, ma_bn: reopen_calls.append((w is ws, ma_bn)),
    )
    assert ok is True
    assert switch_calls == [("acct.b", "pw_b")]
    assert reopen_calls == [(True, "BN1")]


def test_switch_account_to_fails_when_switch_account_fails(monkeypatch):
    ws = _make_ws("acct.a")
    monkeypatch.setattr(ws, "switch_account", lambda u, p: False)
    reopen_calls = []
    ok = ws.switch_account_to("acct.b", "pw_b", "BN1", reopen=lambda w, mb: reopen_calls.append(True))
    assert ok is False
    assert reopen_calls == []


def test_switch_account_to_fails_when_reopen_raises(monkeypatch):
    ws = _make_ws("acct.a")
    monkeypatch.setattr(ws, "switch_account", lambda u, p: True)

    def _boom(w, ma_bn):
        raise RuntimeError("kaboom")

    assert ws.switch_account_to("acct.b", "pw_b", "BN1", reopen=_boom) is False


def test_switch_account_to_default_reopen_uses_open_care_form(monkeypatch):
    ws = _make_ws("acct.a")
    monkeypatch.setattr(ws, "switch_account", lambda u, p: True)
    calls = []
    monkeypatch.setattr(
        ws, "open_care_form",
        lambda ma_bn, allow_completed=False: calls.append((ma_bn, allow_completed)),
    )
    ok = ws.switch_account_to("acct.b", "pw_b", "BN1", allow_completed=True)
    assert ok is True
    assert calls == [("BN1", True)]


def test_switch_to_creator_account_looks_up_and_delegates_to_switch_account_to(monkeypatch):
    import shared.worker_session as ws_module

    accounts = {"le ngoc dieu": {"username": "acct.dieu", "password": "pw_dieu"}}
    monkeypatch.setattr(
        ws_module, "get_emr_account_for_nurse",
        lambda name: accounts.get((name or "").strip().lower()),
    )

    ws = _make_ws("acct.a")
    calls = []
    monkeypatch.setattr(ws, "switch_account_to", lambda *a, **k: calls.append((a, k)) or True)

    assert ws.switch_to_creator_account("le ngoc dieu", "BN1") is True
    assert calls == [
        (("acct.dieu", "pw_dieu", "BN1"), {"allow_completed": False, "reopen": None})
    ]


def test_switch_to_creator_account_returns_false_when_no_account_configured(monkeypatch):
    import shared.worker_session as ws_module

    monkeypatch.setattr(ws_module, "get_emr_account_for_nurse", lambda name: None)
    ws = _make_ws("acct.a")
    assert ws.switch_to_creator_account("Người Lạ", "BN1") is False


def test_restore_account_noop_when_no_original_username(monkeypatch):
    ws = _make_ws("acct.a")
    calls = []
    monkeypatch.setattr(ws, "switch_account_to", lambda *a, **k: calls.append(True) or True)

    ws.restore_account("", "pw", "BN1")

    assert calls == []


def test_restore_account_noop_when_already_on_original_account(monkeypatch):
    """Không mock switch_account_to — dùng logic thật để chứng minh nó tự
    nhận ra đã đúng tài khoản (qua switch_account_to) và không gọi
    switch_account/đổi phiên đăng nhập gì cả."""
    ws = _make_ws("acct.a")
    switch_calls = []
    monkeypatch.setattr(ws, "switch_account", lambda u, p: switch_calls.append((u, p)) or True)

    ws.restore_account("acct.a", "pw", "BN1")

    assert switch_calls == []


def test_restore_account_switches_back_via_switch_account_to(monkeypatch):
    ws = _make_ws("acct.b")
    calls = []
    monkeypatch.setattr(ws, "switch_account_to", lambda *a, **k: calls.append((a, k)) or True)

    ws.restore_account("acct.a", "pw_a", "BN1", allow_completed=True)

    assert calls == [(("acct.a", "pw_a", "BN1"), {"allow_completed": True, "reopen": None})]


def test_restore_account_warns_when_switch_account_to_fails(monkeypatch, capsys):
    ws = _make_ws("acct.b")
    monkeypatch.setattr(ws, "switch_account_to", lambda *a, **k: False)

    ws.restore_account("acct.a", "pw_a", "BN1")

    assert "Không khôi phục được tài khoản EMR gốc acct.a" in capsys.readouterr().out
