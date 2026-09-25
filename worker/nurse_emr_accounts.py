# -*- coding: utf-8 -*-
"""worker/nurse_emr_accounts.py — Tài khoản EMR thật riêng theo TÊN điều dưỡng.

Khác với secrets/users.json (tài khoản đăng nhập Data Hub, gắn theo người vận
hành app): file này chỉ ánh xạ TÊN điều dưỡng trong lịch trực (config.json ->
ten_dieu_duong) sang tài khoản EMR của chính người đó — không cần người đó
từng đăng nhập Data Hub. Dùng khi nhập chăm sóc để mỗi ca (làm/trực) được ghi
nhận đúng tài khoản EMR của điều dưỡng phụ trách ca đó, không phải tài khoản
chung.

Xem config/nurse_emr_accounts.example.json để biết định dạng; file thật
secrets/nurse_emr_accounts.json không commit (chứa mật khẩu thật) — xem docs/SECRETS.md.

Cùng file JSON này còn giữ trường tùy chọn "signature_file" (tên file ảnh
chữ ký trong config/signatures/) — dùng khi tự động chèn chữ ký vào bộ
phiếu "IN RA VIỆN" (xem sign_discharge_bundle.py). Trường này không đòi hỏi
phải có emr_username/emr_password: một người có thể chỉ cấu hình chữ ký mà
không cần tài khoản EMR riêng.
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
from functools import lru_cache
from typing import Any, Dict, List, Optional

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
try:
    from shared.secret_store import resolve_secret_file
    # secrets/nurse_emr_accounts.json (máy chưa chuyển thì vẫn là config/ cũ),
    # EMR_NURSE_ACCOUNTS_FILE ghi đè được — cùng quy tắc với server.
    NURSE_EMR_ACCOUNTS_FILE = resolve_secret_file('nurse_emr_accounts.json')[0]
except ImportError:  # chạy tay ngoài thư mục worker/
    NURSE_EMR_ACCOUNTS_FILE = os.path.join(BASE_DIR, 'config', 'nurse_emr_accounts.json')
NURSE_SIGNATURES_DIR = os.path.join(BASE_DIR, 'config', 'signatures')


def normalize_name(value: Any) -> str:
    """Chuẩn hoá tên để so khớp: bỏ dấu, chữ thường, gọn khoảng trắng."""
    text = str(value or '').strip().upper()
    text = unicodedata.normalize('NFD', text)
    text = ''.join(ch for ch in text if unicodedata.category(ch) != 'Mn')
    text = text.replace('Đ', 'D')
    return re.sub(r'\s+', ' ', text)


def _load_json(path: str, fallback: Any) -> Any:
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return fallback


@lru_cache(maxsize=1)
def load_nurse_emr_accounts() -> Dict[str, Dict[str, str]]:
    """Trả về map {tên đã chuẩn hoá: {"name", "emr_username", "emr_password"}}."""
    raw = _load_json(NURSE_EMR_ACCOUNTS_FILE, [])
    out: Dict[str, Dict[str, str]] = {}
    if not isinstance(raw, list):
        return out
    for row in raw:
        if not isinstance(row, dict):
            continue
        name = str(row.get('name') or '').strip()
        username = str(row.get('emr_username') or '').strip()
        password = str(row.get('emr_password') or '')
        if not name or not username or not password:
            continue
        out[normalize_name(name)] = {'name': name, 'emr_username': username, 'emr_password': password}
    return out


def get_emr_account_for_nurse(name: Any) -> Optional[Dict[str, str]]:
    """Trả {"username", "password"} nếu tên khớp tài khoản đã cấu hình, ngược lại None."""
    key = normalize_name(name)
    if not key:
        return None
    row = load_nurse_emr_accounts().get(key)
    if not row:
        return None
    return {'username': row['emr_username'], 'password': row['emr_password']}


def get_nurse_name_for_username(username: Any) -> str:
    """Tra ngược: tên điều dưỡng sở hữu tài khoản EMR `username` ('' nếu không có)."""
    wanted = str(username or '').strip().lower()
    if not wanted:
        return ''
    for row in load_nurse_emr_accounts().values():
        if row['emr_username'].strip().lower() == wanted:
            return row['name']
    return ''


@lru_cache(maxsize=1)
def load_nurse_signature_rows() -> List[Dict[str, str]]:
    """Trả list các dòng đã cấu hình ảnh chữ ký: [{"name", "path"}].

    Khác load_nurse_emr_accounts(): không đòi hỏi có emr_username/emr_password,
    chỉ cần signature_file trỏ tới 1 file ảnh có thật trong config/signatures/.
    """
    raw = _load_json(NURSE_EMR_ACCOUNTS_FILE, [])
    out: List[Dict[str, str]] = []
    if not isinstance(raw, list):
        return out
    for row in raw:
        if not isinstance(row, dict):
            continue
        name = str(row.get('name') or '').strip()
        sig_file = str(row.get('signature_file') or '').strip()
        if not name or not sig_file:
            continue
        # Chỉ nhận tên file thuần — chặn path traversal (../, đường dẫn tuyệt đối).
        sig_file = os.path.basename(sig_file)
        path = os.path.join(NURSE_SIGNATURES_DIR, sig_file)
        if os.path.isfile(path):
            out.append({'name': name, 'path': path})
    return out


def get_signature_for_nurse(name: Any) -> Optional[str]:
    """Trả đường dẫn tuyệt đối ảnh chữ ký đã cấu hình cho `name`, ngược lại None."""
    key = normalize_name(name)
    if not key:
        return None
    for row in load_nurse_signature_rows():
        if normalize_name(row['name']) == key:
            return row['path']
    return None
