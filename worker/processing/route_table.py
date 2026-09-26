# -*- coding: utf-8 -*-
"""Bảng chuẩn đường dùng thuốc — đọc từ config/routes.json (dùng chung với giao diện).

Mọi nơi trong worker cần nhận diện/chuẩn hoá đường dùng gọi các hàm ở đây thay vì
tự viết danh sách từ khoá riêng, để cùng một y lệnh luôn ra cùng một đường dùng.
"""

import json
import os
import re
import unicodedata
from functools import lru_cache

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ROUTES_FILE = os.path.join(BASE_DIR, 'config', 'routes.json')


def _strip_diacritics(value):
    text = str(value or '').replace('đ', 'd').replace('Đ', 'D')
    text = unicodedata.normalize('NFD', text)
    return ''.join(ch for ch in text if unicodedata.category(ch) != 'Mn')


@lru_cache(maxsize=1)
def load_route_table():
    with open(ROUTES_FILE, 'r', encoding='utf-8') as f:
        data = json.load(f)
    routes = {r['code']: r for r in data.get('routes', [])}
    by_short = {str(r['short']).upper(): r for r in data.get('routes', [])}
    rules = [
        (
            rule['route'],
            [re.compile(p) for p in rule.get('patterns', [])],
            [re.compile(p) for p in rule.get('raw_patterns', [])],
        )
        for rule in data.get('rules', [])
    ]
    aliases = {str(k).upper(): v for k, v in (data.get('legacy_aliases') or {}).items()}
    return routes, by_short, rules, aliases


def normalize_route_code(value):
    """Mã chuẩn từ nhãn có sẵn: mã mới, nhãn ngắn hoặc nhãn cũ ("U", "IV", "Hít/Xịt")."""
    routes, by_short, _, aliases = load_route_table()
    key = str(value or '').strip().upper()
    if not key:
        return ''
    if key in routes:
        return key
    if key in by_short:
        return by_short[key]['code']
    return aliases.get(key, '')


def detect_route_code(text):
    """Nhận diện đường dùng từ chữ tự do trong y lệnh. Trả '' nếu không nhận ra."""
    _, _, rules, _ = load_route_table()
    raw = _strip_diacritics(text)
    compact = ' ' + re.sub(r'\s+', ' ', re.sub(r'[_\-.]+', ' ', raw.lower())).strip() + ' '
    for route, patterns, raw_patterns in rules:
        if any(p.search(compact) for p in patterns) or any(p.search(raw) for p in raw_patterns):
            return route
    return ''


def route_info(code_or_label):
    routes, _, _, _ = load_route_table()
    return routes.get(normalize_route_code(code_or_label)) or routes['KHAC']


def route_category(code_or_label):
    return route_info(code_or_label)['category']


def route_short(code_or_label):
    code = normalize_route_code(code_or_label)
    return route_info(code)['short'] if code else str(code_or_label or '')
