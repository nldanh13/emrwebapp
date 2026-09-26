# -*- coding: utf-8 -*-
"""MODEL ĐƯỜNG DÙNG DUY NHẤT của worker — đọc từ config/routes.json.

Giao diện đọc cùng file JSON qua src/config/routes.js. Mọi nơi cần biết đường dùng
(gắn nhãn, chia chuyên mục, LLM, danh mục thuốc, phiếu in, xử lý Tramadol…) đều gọi
các hàm ở đây, không tự viết danh sách từ khoá riêng.

Hàm chính:
- detect_route(text)            → (mã, weak) từ chữ tự do trong y lệnh
- detect_route_code(text)       → mã
- detect_drug_route(route, name)→ mã, có tính các ngoại lệ theo tên thuốc
- normalize_route_code(label)   → mã chuẩn từ nhãn cũ/mới (U, IV, Hít/Xịt…)
- route_category(code)          → chuyên mục (dich_truyen, thuoc_tiem…)
- route_short(code)             → nhãn ngắn hiển thị (TTM, Uống…)
- is_infusion_route(text)       → True nếu là truyền (TTM/SE)
"""

import json
import os
import re
import unicodedata
from functools import lru_cache

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
ROUTES_FILE = os.path.join(BASE_DIR, 'config', 'routes.json')

INFUSION_ROUTES = frozenset({'TTM', 'SE'})
# Tiêm có vị trí rõ ràng (không bao giờ là truyền).
SITE_INJECTION_ROUTES = frozenset({'TB', 'TDD', 'TTD'})


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
            bool(rule.get('weak')),
            [re.compile(p) for p in rule.get('patterns', [])],
            [re.compile(p) for p in rule.get('raw_patterns', [])],
        )
        for rule in data.get('rules', [])
    ]
    aliases = {str(k).upper(): v for k, v in (data.get('legacy_aliases') or {}).items()}
    categories = {c['code']: c for c in data.get('categories', [])}
    fuzzy = {k: list(v or []) for k, v in (data.get('fuzzy') or {}).items()}
    return {
        'routes': routes, 'by_short': by_short, 'rules': rules,
        'aliases': aliases, 'categories': categories, 'fuzzy': fuzzy,
    }


def normalize_route_code(value):
    """Mã chuẩn từ nhãn có sẵn: mã mới, nhãn ngắn hoặc nhãn cũ ("U", "IV", "Hít/Xịt")."""
    t = load_route_table()
    key = str(value or '').strip().upper()
    if not key:
        return ''
    if key in t['routes']:
        return key
    if key in t['by_short']:
        return t['by_short'][key]['code']
    return t['aliases'].get(key, '')


def detect_route(text):
    """(mã, weak) từ chữ tự do; ('', False) nếu không nhận ra.

    weak=True khi chỉ ghi chung chung (TM, IV, "tiêm") — bộ phân loại chuyên mục
    sẽ xét tên thuốc/dung môi trước khi tin vào kết quả này.
    """
    raw = _strip_diacritics(text)
    compact = ' ' + re.sub(r'\s+', ' ', re.sub(r'[_\-.]+', ' ', raw.lower())).strip() + ' '
    for route, weak, patterns, raw_patterns in load_route_table()['rules']:
        if any(p.search(compact) for p in patterns) or any(p.search(raw) for p in raw_patterns):
            return route, weak
    return '', False


def detect_route_code(text):
    return detect_route(text)[0]


def mentioned_routes(text, strong_only=False):
    """Mọi mã đường dùng mà chữ có nhắc tới (không dừng ở luật đầu tiên).

    strong_only=True: bỏ qua luật 'weak' (TM, IV, "tiêm" chung chung).
    """
    raw = _strip_diacritics(text)
    compact = ' ' + re.sub(r'\s+', ' ', re.sub(r'[_\-.]+', ' ', raw.lower())).strip() + ' '
    found = []
    for route, weak, patterns, raw_patterns in load_route_table()['rules']:
        if route in found or (strong_only and weak):
            continue
        if any(p.search(compact) for p in patterns) or any(p.search(raw) for p in raw_patterns):
            found.append(route)
    return found


def has_oral_marker(text):
    """Có ghi đường uống (uống, (u), u đứng riêng, PO)."""
    return 'UONG' in mentioned_routes(text)


def fuzzy_route_code(text, matcher):
    """So khớp gần đúng (lỗi chính tả) theo từ khoá 'fuzzy' trong routes.json.

    `matcher(text, keywords)` là hàm so khớp ngữ nghĩa (vd. semantic_contains_any).
    """
    if not callable(matcher):
        return ''
    for code, keywords in load_route_table()['fuzzy'].items():
        try:
            if keywords and matcher(text, keywords):
                return code
        except Exception:
            continue
    return ''


def detect_drug_route(route_text, drug_name=''):
    """Mã đường dùng của một dòng thuốc, có tính ngoại lệ theo tên thuốc.

    - "Tiêm (tự túc)" nhưng tên thuốc có chữ "uống" → EMR nhập sai, thực ra là uống.
    - Tramadol chỉ ghi chung "Tiêm" (không có dấu hiệu truyền/pha NaCl) → tiêm bắp.
    """
    route_l = str(route_text or '').lower().strip()
    name_l = str(drug_name or '').lower()
    if route_l in ('tiêm (tự túc)', 'tiêm(tự túc)') and 'uống' in name_l:
        return 'UONG'
    code, weak = detect_route(route_text)
    if 'tramadol' in _strip_diacritics(name_l) and code == 'TMC' and weak:
        folded = _strip_diacritics(route_l)
        has_nacl = any(k in folded for k in ('natri clorid', 'natri chlorid', 'sodium', 'nacl', 'nuoc muoi'))
        if not has_nacl:
            return 'TB'
    return code


def is_infusion_route(text):
    """True nếu chữ/mã đường dùng là truyền (TTM hoặc SE)."""
    return (normalize_route_code(text) or detect_route_code(text)) in INFUSION_ROUTES


def route_info(code_or_label):
    t = load_route_table()
    return t['routes'].get(normalize_route_code(code_or_label)) or t['routes']['KHAC']


def route_category(code_or_label):
    return route_info(code_or_label)['category']


def route_short(code_or_label):
    code = normalize_route_code(code_or_label)
    return route_info(code)['short'] if code else str(code_or_label or '')


def category_label(category):
    cat = load_route_table()['categories'].get(str(category or ''))
    return cat['label'] if cat else str(category or '')
