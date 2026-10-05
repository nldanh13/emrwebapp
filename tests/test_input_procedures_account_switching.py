# -*- coding: utf-8 -*-
"""input_procedures.py: EMR hiện chỉ cho đúng tài khoản người tạo phiếu tự
Thu hồi/sửa phiếu thủ thuật của họ. _process_task phải đổi sang tài khoản
EMR của thủ thuật viên đang ghi trên phiếu (đọc từ combobox cbbTTChinh)
trước khi Thu hồi/sửa, rồi khôi phục lại tài khoản gốc — qua
WorkerSession.switch_to_creator_account/restore_account (điểm tập trung
duy nhất, xem worker/shared/worker_session.py)."""
import os
import sys
from datetime import datetime

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WORKER = os.path.join(ROOT, 'worker')
if WORKER not in sys.path:
    sys.path.insert(0, WORKER)


class _FakeElement:
    def click(self):
        pass


class _FakeWait:
    def until(self, _condition):
        return _FakeElement()


class _FakeDriver:
    def find_element(self, *_a, **_k):
        return _FakeElement()

    def execute_script(self, *_a, **_k):
        pass


class _FakeWS:
    """WorkerSession giả: switch_to_creator_account/restore_account mô
    phỏng đúng hành vi tập trung ở WorkerSession thật — tra tài khoản qua
    `accounts` (thay cho nurse_emr_accounts.get_emr_account_for_nurse thật)
    rồi gọi switch_account + reopen."""

    def __init__(self, username="acct.goc", accounts=None):
        self.config = {"username": username, "password": "pw_goc", "repair_existing": True}
        self.driver = _FakeDriver()
        self.wait = _FakeWait()
        self.switch_calls = []
        self.accounts = accounts or {}

    def switch_account(self, username, password):
        self.switch_calls.append((username, password))
        self.config = dict(self.config, username=username, password=password)
        self.driver = _FakeDriver()
        self.wait = _FakeWait()
        return True

    def _switch_account_to(self, username, password, ma_bn, reopen):
        if username == self.config.get("username"):
            return True
        if not self.switch_account(username, password):
            return False
        try:
            (reopen or (lambda w, mb: None))(self, ma_bn)
        except Exception:
            return False
        return True

    def switch_to_creator_account(self, creator, ma_bn, reopen=None):
        account = self.accounts.get((creator or "").strip().lower())
        if not account:
            return False
        return self._switch_account_to(account["username"], account["password"], ma_bn, reopen)

    def restore_account(self, original_username, original_password, ma_bn, reopen=None):
        if not original_username or self.config.get("username") == original_username:
            return
        self._switch_account_to(original_username, original_password, ma_bn, reopen)


class _DummyWebDriverWait:
    def __init__(self, *_a, **_k):
        pass

    def until(self, *_a, **_k):
        return True


def test_clean_staff_display_name_strips_title_prefix_keeps_accents():
    import input_procedures as ip

    assert ip._clean_staff_display_name("BS. Nguyễn Văn A") == "Nguyễn Văn A"
    assert ip._clean_staff_display_name("ĐD. Lê Thị B") == "Lê Thị B"
    assert ip._clean_staff_display_name("  ThS. Trần D  ") == "Trần D"
    assert ip._clean_staff_display_name("Nguyễn Văn C") == "Nguyễn Văn C"
    assert ip._clean_staff_display_name("") == ""


def _patch_common(monkeypatch, ip, *, existing_staff_text):
    monkeypatch.setattr(ip, "_goto_procedure_list", lambda driver, wait, config: None)
    monkeypatch.setattr(ip, "_apply_procedure_date_range_filter", lambda driver, wait, ngay, config: None)
    monkeypatch.setattr(ip, "_try_search_on_list", lambda driver, wait, ma_bn, ho_ten: None)
    monkeypatch.setattr(
        ip, "_open_procedure_row",
        lambda driver, wait, ma_bn, ngay, service_name, clinic_mode=False,
               allow_completed_update=False, return_meta=False: (
            datetime(2026, 9, 21, 8, 0), True, "Hoàn tất"
        ),
    )
    monkeypatch.setattr(ip, "_enter_execution_form_for_check", lambda driver, wait: None)
    monkeypatch.setattr(ip, "_compare_procedure_form", lambda driver, expected: ["giờ bắt đầu sai"])
    monkeypatch.setattr(ip, "_select_current_text", lambda driver, field_id: existing_staff_text)
    monkeypatch.setattr(ip, "WebDriverWait", _DummyWebDriverWait)


def _fill_spy(monkeypatch, ip):
    fill_calls = []
    monkeypatch.setattr(
        ip, "_fill_one_procedure",
        lambda driver, wait, config, start_dt, discharge_dt=None, service_name="", task=None: fill_calls.append(True),
    )
    return fill_calls


TASK = {"ma_bn": "BN001", "ngay_lam": "21/09/2026", "ho_ten": "Test", "service_name": "Thay băng"}


def test_process_task_recalls_with_current_account_without_switching(monkeypatch):
    """Một phiên đăng nhập: tài khoản đang dùng Thu hồi được thì sửa luôn, không đổi tài khoản."""
    import input_procedures as ip

    _patch_common(monkeypatch, ip, existing_staff_text="BS. Nguyễn Văn A")
    monkeypatch.setattr(ip, "_click_recall_procedure_if_available", lambda driver, wait: True)
    fill_calls = _fill_spy(monkeypatch, ip)

    accounts = {"nguyễn văn a": {"username": "acct.a", "password": "pw_a"}}
    ws = _FakeWS(username="acct.goc", accounts=accounts)

    assert ip._process_task(ws, dict(TASK)) == "updated"
    assert fill_calls == [True]
    assert ws.switch_calls == []


def test_process_task_falls_back_to_staff_account_when_current_cannot_recall(monkeypatch):
    import input_procedures as ip

    _patch_common(monkeypatch, ip, existing_staff_text="BS. Nguyễn Văn A")
    ws = _FakeWS(username="acct.goc", accounts={"nguyễn văn a": {"username": "acct.a", "password": "pw_a"}})
    recall_calls = []

    def recall(driver, wait):
        recall_calls.append(ws.config["username"])
        return ws.config["username"] == "acct.a"

    monkeypatch.setattr(ip, "_click_recall_procedure_if_available", recall)
    fill_calls = _fill_spy(monkeypatch, ip)

    assert ip._process_task(ws, dict(TASK)) == "updated"
    assert recall_calls == ["acct.goc", "acct.a"]
    assert fill_calls == [True]
    assert ws.switch_calls == [("acct.a", "pw_a"), ("acct.goc", "pw_goc")]
    assert ws.config["username"] == "acct.goc"


def test_process_task_fails_when_current_cannot_recall_and_staff_has_no_account(monkeypatch):
    import input_procedures as ip

    _patch_common(monkeypatch, ip, existing_staff_text="Người Không Có Tài Khoản")
    monkeypatch.setattr(ip, "_click_recall_procedure_if_available", lambda driver, wait: False)
    ws = _FakeWS(username="acct.goc")

    try:
        ip._process_task(ws, dict(TASK))
        assert False, "expected RuntimeError"
    except RuntimeError as e:
        assert "không cho Thu hồi" in str(e)
        assert "Người Không Có Tài Khoản" in str(e)

    assert ws.switch_calls == []
    assert ws.config["username"] == "acct.goc"


def test_process_task_perfect_does_not_switch_account(monkeypatch):
    import input_procedures as ip

    monkeypatch.setattr(ip, "_goto_procedure_list", lambda driver, wait, config: None)
    monkeypatch.setattr(ip, "_apply_procedure_date_range_filter", lambda driver, wait, ngay, config: None)
    monkeypatch.setattr(ip, "_try_search_on_list", lambda driver, wait, ma_bn, ho_ten: None)
    monkeypatch.setattr(
        ip, "_open_procedure_row",
        lambda driver, wait, ma_bn, ngay, service_name, clinic_mode=False,
               allow_completed_update=False, return_meta=False: (
            datetime(2026, 9, 21, 8, 0), True, "Hoàn tất"
        ),
    )
    monkeypatch.setattr(ip, "_enter_execution_form_for_check", lambda driver, wait: None)
    monkeypatch.setattr(ip, "_compare_procedure_form", lambda driver, expected: [])

    ws = _FakeWS(username="acct.goc")
    task = {"ma_bn": "BN001", "ngay_lam": "21/09/2026", "ho_ten": "Test", "service_name": "Thay băng"}

    assert ip._process_task(ws, task) == "perfect"
    assert ws.switch_calls == []
