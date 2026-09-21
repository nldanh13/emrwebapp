# -*- coding: utf-8 -*-
"""worker/nurse_emr_accounts.py — Tài khoản EMR thật riêng theo TÊN điều dưỡng.

Khác với config/users.json (tài khoản đăng nhập Data Hub, gắn theo người vận
hành app): file này chỉ ánh xạ TÊN điều dưỡng trong lịch trực (config.json ->
ten_dieu_duong) sang tài khoản EMR của chính người đó — không cần người đó
từng đăng nhập Data Hub. Dùng khi nhập chăm sóc để mỗi ca (làm/trực) được ghi
nhận đúng tài khoản EMR của điều dưỡng phụ trách ca đó, không phải tài khoản
chung.

Xem config/nurse_emr_accounts.example.json để biết định dạng; file thật
config/nurse_emr_accounts.json không commit (chứa mật khẩu thật).
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
from functools import lru_cache
from typing import Any, Dict, Optional

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
NURSE_EMR_ACCOUNTS_FILE = os.path.join(BASE_DIR, 'config', 'nurse_emr_accounts.json')


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
