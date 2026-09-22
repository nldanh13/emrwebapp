# -*- coding: utf-8 -*-
"""Tài khoản EMR riêng theo tên điều dưỡng — worker/nurse_emr_accounts.py."""
import json
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'worker'))

import nurse_emr_accounts


def _write_accounts(path, rows):
    path.write_text(json.dumps(rows, ensure_ascii=False), encoding='utf-8')


def _patch_accounts_path(monkeypatch, tmp_path):
    accounts_path = tmp_path / 'nurse_emr_accounts.json'
    monkeypatch.setattr(nurse_emr_accounts, 'NURSE_EMR_ACCOUNTS_FILE', str(accounts_path))
    nurse_emr_accounts.load_nurse_emr_accounts.cache_clear()
    return accounts_path


def test_normalize_name_strips_accents_case_and_whitespace():
    assert nurse_emr_accounts.normalize_name('Lê Ngọc Diệu') == nurse_emr_accounts.normalize_name('  le   ngoc dieu ')
    assert nurse_emr_accounts.normalize_name('Đoan') == nurse_emr_accounts.normalize_name('doan')


def test_get_emr_account_for_nurse_matches_configured_name(monkeypatch, tmp_path):
    path = _patch_accounts_path(monkeypatch, tmp_path)
    _write_accounts(path, [
        {'name': 'Lê Ngọc Diệu', 'emr_username': 'diệu.emr', 'emr_password': 'secret1'},
        {'name': 'Lê Thị Tuyết Đoan', 'emr_username': 'doan.emr', 'emr_password': 'secret2'},
    ])

    account = nurse_emr_accounts.get_emr_account_for_nurse('le ngoc dieu')
    assert account == {'username': 'diệu.emr', 'password': 'secret1'}


def test_get_emr_account_for_nurse_unknown_name_returns_none(monkeypatch, tmp_path):
    path = _patch_accounts_path(monkeypatch, tmp_path)
    _write_accounts(path, [
        {'name': 'Lê Ngọc Diệu', 'emr_username': 'diệu.emr', 'emr_password': 'secret1'},
    ])

    assert nurse_emr_accounts.get_emr_account_for_nurse('Nguyễn Văn A') is None
    assert nurse_emr_accounts.get_emr_account_for_nurse('') is None
    assert nurse_emr_accounts.get_emr_account_for_nurse(None) is None


def test_get_emr_account_for_nurse_skips_rows_missing_credentials(monkeypatch, tmp_path):
    path = _patch_accounts_path(monkeypatch, tmp_path)
    _write_accounts(path, [
        {'name': 'Lê Ngọc Diệu', 'emr_username': '', 'emr_password': ''},
        {'name': 'Lê Thị Tuyết Đoan', 'emr_username': 'doan.emr', 'emr_password': ''},
    ])

    assert nurse_emr_accounts.get_emr_account_for_nurse('Lê Ngọc Diệu') is None
    assert nurse_emr_accounts.get_emr_account_for_nurse('Lê Thị Tuyết Đoan') is None


def test_load_nurse_emr_accounts_missing_file_returns_empty(monkeypatch, tmp_path):
    _patch_accounts_path(monkeypatch, tmp_path)  # file không tồn tại
    assert nurse_emr_accounts.load_nurse_emr_accounts() == {}
    assert nurse_emr_accounts.get_emr_account_for_nurse('Bất kỳ') is None


def _patch_signatures_dir(monkeypatch, tmp_path):
    signatures_dir = tmp_path / 'signatures'
    signatures_dir.mkdir()
    monkeypatch.setattr(nurse_emr_accounts, 'NURSE_SIGNATURES_DIR', str(signatures_dir))
    nurse_emr_accounts.load_nurse_signature_rows.cache_clear()
    return signatures_dir


def test_get_signature_for_nurse_matches_configured_name(monkeypatch, tmp_path):
    path = _patch_accounts_path(monkeypatch, tmp_path)
    signatures_dir = _patch_signatures_dir(monkeypatch, tmp_path)
    (signatures_dir / 'dieu.png').write_bytes(b'fake-png-bytes')
    _write_accounts(path, [
        {'name': 'Lê Ngọc Diệu', 'emr_username': 'diệu.emr', 'emr_password': 'secret1', 'signature_file': 'dieu.png'},
    ])

    result = nurse_emr_accounts.get_signature_for_nurse('le ngoc dieu')
    assert result == str(signatures_dir / 'dieu.png')


def test_get_signature_for_nurse_does_not_require_emr_credentials(monkeypatch, tmp_path):
    """Một người có thể chỉ cấu hình chữ ký, không cần tài khoản EMR riêng —
    khác load_nurse_emr_accounts() (đòi cả username/password)."""
    path = _patch_accounts_path(monkeypatch, tmp_path)
    signatures_dir = _patch_signatures_dir(monkeypatch, tmp_path)
    (signatures_dir / 'diem.png').write_bytes(b'fake-png-bytes')
    _write_accounts(path, [
        {'name': 'Trần Thị Điểm', 'signature_file': 'diem.png'},
    ])

    assert nurse_emr_accounts.get_emr_account_for_nurse('Trần Thị Điểm') is None
    assert nurse_emr_accounts.get_signature_for_nurse('Trần Thị Điểm') == str(signatures_dir / 'diem.png')


def test_get_signature_for_nurse_returns_none_when_file_missing_on_disk(monkeypatch, tmp_path):
    path = _patch_accounts_path(monkeypatch, tmp_path)
    _patch_signatures_dir(monkeypatch, tmp_path)
    _write_accounts(path, [
        {'name': 'Lê Ngọc Diệu', 'signature_file': 'khong_ton_tai.png'},
    ])

    assert nurse_emr_accounts.get_signature_for_nurse('Lê Ngọc Diệu') is None


def test_get_signature_for_nurse_ignores_path_traversal_in_signature_file(monkeypatch, tmp_path):
    path = _patch_accounts_path(monkeypatch, tmp_path)
    signatures_dir = _patch_signatures_dir(monkeypatch, tmp_path)
    outside_file = tmp_path / 'secret.png'
    outside_file.write_bytes(b'outside-file')
    _write_accounts(path, [
        {'name': 'Lê Ngọc Diệu', 'signature_file': '../secret.png'},
    ])

    # basename() bỏ phần thư mục -> chỉ tìm "secret.png" NGAY TRONG thư mục
    # signatures, không thoát ra ngoài — file ở ngoài không được coi là hợp lệ.
    assert not (signatures_dir / 'secret.png').exists()
    assert nurse_emr_accounts.get_signature_for_nurse('Lê Ngọc Diệu') is None


def test_load_nurse_signature_rows_missing_accounts_file_returns_empty(monkeypatch, tmp_path):
    _patch_accounts_path(monkeypatch, tmp_path)  # file không tồn tại
    _patch_signatures_dir(monkeypatch, tmp_path)
    assert nurse_emr_accounts.load_nurse_signature_rows() == []
    assert nurse_emr_accounts.get_signature_for_nurse('Bất kỳ') is None
