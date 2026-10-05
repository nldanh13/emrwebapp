# -*- coding: utf-8 -*-
"""Nhập liệu đăng nhập bằng tài khoản EMR của người CA LÀM theo lịch, không dùng
tài khoản mặc định; người ca làm chưa có tài khoản thì dùng tài khoản mặc định
+ cảnh báo. Quét/lấy dữ liệu vẫn dùng tài khoản mặc định.
Xem worker/nurse_emr_accounts.py (resolve_entry_account) và docs/UX_RULES.md mục 4.4."""
import json
import os
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / 'worker'))

import nurse_emr_accounts
from nurse_emr_accounts import EntryAccountResolver, resolve_entry_account, sort_tasks_by_work_date
from shared.worker_session import WorkerSession

# 05/10/2026 là thứ Hai.
SCHEDULE = {
    'Monday': {'work': ['Lê Ngọc Diệu'], 'oncall': ['Trần Văn Trực']},
    'Tuesday': {'work': ['Nguyễn Chưa Có'], 'oncall': ['Trần Văn Trực']},
    'days': {'2026-10-07': {'work': ['Lê Thị Tuyết Đoan'], 'oncall': ['Trần Văn Trực']}},
}
ACCOUNTS = [
    {'name': 'Lê Ngọc Diệu', 'emr_username': 'dieu.emr', 'emr_password': 'pw-dieu'},
    {'name': 'Lê Thị Tuyết Đoan', 'emr_username': 'doan.emr', 'emr_password': 'pw-doan'},
    {'name': 'Trần Văn Trực', 'emr_username': 'truc.emr', 'emr_password': 'pw-truc'},
]
DEFAULT = {'username': 'chung.emr', 'password': 'pw-chung', 'ten_dieu_duong': SCHEDULE}


def _accounts(monkeypatch, tmp_path):
    path = tmp_path / 'nurse_emr_accounts.json'
    path.write_text(json.dumps(ACCOUNTS, ensure_ascii=False), encoding='utf-8')
    monkeypatch.setattr(nurse_emr_accounts, 'NURSE_EMR_ACCOUNTS_FILE', str(path))
    nurse_emr_accounts.load_nurse_emr_accounts.cache_clear()


def _resolve(date):
    return resolve_entry_account(date, schedule=SCHEDULE, default_username='chung.emr', default_password='pw-chung')


def test_scheduled_work_nurse_with_account_is_used(monkeypatch, tmp_path):
    _accounts(monkeypatch, tmp_path)
    info = _resolve('05/10/2026')
    assert info['source'] == 'schedule'
    assert info['username'] == 'dieu.emr' and info['password'] == 'pw-dieu'
    assert info['nurse_name'] == 'Lê Ngọc Diệu'
    assert info['warning'] == ''


def test_work_nurse_not_oncall_nurse_even_for_iso_dates_and_exact_days(monkeypatch, tmp_path):
    _accounts(monkeypatch, tmp_path)
    assert _resolve('2026-10-05')['username'] == 'dieu.emr'
    # Lịch theo ngày cụ thể (days[YYYY-MM-DD]) được ưu tiên hơn lịch theo thứ.
    assert _resolve('07/10/2026')['username'] == 'doan.emr'


def test_scheduled_nurse_without_account_falls_back_to_default_with_warning(monkeypatch, tmp_path):
    _accounts(monkeypatch, tmp_path)
    info = _resolve('06/10/2026')
    assert info['source'] == 'default'
    assert info['username'] == 'chung.emr'
    assert 'Nguyễn Chưa Có' in info['warning'] and 'Thiết lập tài khoản' in info['warning']
    assert 'pw-' not in info['warning']


def test_no_schedule_falls_back_to_default_with_warning(monkeypatch, tmp_path):
    _accounts(monkeypatch, tmp_path)
    info = resolve_entry_account('05/10/2026', schedule={}, default_username='chung.emr', default_password='pw-chung')
    assert info['source'] == 'default' and info['username'] == 'chung.emr'
    assert 'Lịch điều dưỡng' in info['warning']


def test_resolver_warns_once_per_date_and_builds_login_config(monkeypatch, tmp_path):
    _accounts(monkeypatch, tmp_path)
    warned = []
    resolver = EntryAccountResolver(DEFAULT, warn=warned.append)
    login = resolver.login_config(DEFAULT, '05/10/2026')
    assert login['username'] == 'dieu.emr' and login['password'] == 'pw-dieu'
    assert DEFAULT['username'] == 'chung.emr', 'không được sửa config gốc'
    resolver.for_date('06/10/2026')
    resolver.for_date('2026-10-06')
    assert len(warned) == 1 and resolver.warnings == warned


def test_sort_tasks_by_work_date_groups_dates_and_keeps_order_within_day():
    tasks = [
        {'id': 1, 'ngay_lam': '06/10/2026'},
        {'id': 2, 'ngay_lam': '05/10/2026'},
        {'id': 3, 'ngay_lam': '06/10/2026'},
        {'id': 4, 'ngay_lam': '2026-10-05'},
        {'id': 5, 'ngay_lam': ''},
    ]
    assert [t['id'] for t in sort_tasks_by_work_date(tasks)] == [2, 4, 1, 3, 5]


def test_use_entry_account_switches_only_when_account_changes():
    ws = WorkerSession({'username': 'dieu.emr', 'password': 'pw-dieu'}, os.devnull)
    calls = []

    def fake_switch(username, password):
        calls.append(username)
        ws.config = dict(ws.config, username=username, password=password)
        return True

    ws.switch_account = fake_switch
    assert ws.use_entry_account({'username': 'dieu.emr', 'password': 'pw-dieu'})
    assert ws.use_entry_account({'username': 'doan.emr', 'password': 'pw-doan'})
    assert ws.use_entry_account({'username': 'doan.emr', 'password': 'pw-doan'})
    assert calls == ['doan.emr']


def test_use_entry_account_failure_keeps_session_and_warns():
    ws = WorkerSession({'username': 'dieu.emr', 'password': 'pw-dieu'}, os.devnull)
    ws.switch_account = lambda u, p: False
    assert ws.use_entry_account({'username': 'doan.emr', 'password': 'bad', 'nurse_name': 'Lê Thị Tuyết Đoan'}) is False
    warnings = ws._result_kwargs.get('warnings') or []
    assert len(warnings) == 1 and 'Lê Thị Tuyết Đoan' in warnings[0] and 'bad' not in warnings[0]


def _src(rel):
    return (ROOT / rel).read_text(encoding='utf-8')


def test_input_workers_log_in_with_scheduled_account():
    for rel in ('worker/input_care.py', 'worker/input_procedures.py', 'worker/input_vtyt.py', 'worker/input_infusions.py'):
        src = _src(rel)
        assert 'EntryAccountResolver(' in src, rel
        assert 'login_config' in src, rel
    # Chăm sóc: phiếu của ngày gán vào tài khoản ca làm của ngày đó, không phải tài khoản mặc định.
    care = _src('worker/input_care.py')
    assert 'username_g = default_emr_username' not in care
    assert 'username_g = day_account["username"]' in care


def test_infusion_no_longer_uses_separate_account_or_parallel_lane():
    infusion = _src('worker/input_infusions.py')
    assert "config['username'] = config['infusion_username']" not in infusion
    patients = _src('server/routes/patients.js')
    assert not re.search(r"accountKey\s*=\s*\([^;]*'infusion'", patients)
