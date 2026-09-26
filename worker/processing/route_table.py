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
# Phần người dùng tự cài trên giao diện (tab Đường dùng) — gộp với bảng chuẩn khi đọc.
CUSTOM_ROUTES_FILE = os.path.join(BASE_DIR, 'config', 'routes.custom.json')

INFUSION_ROUTES = frozenset({'TTM', 'SE'})
# Tiêm có vị trí rõ ràng (không bao giờ là truyền).
SITE_INJECTION_ROUTES = frozenset({'TB', 'TDD', 'TTD'})


def _strip_diacritics(value):
    text = str(value or '').replace('đ', 'd').replace('Đ', 'D')
    text = unicodedata.normalize('NFD', text)
    return ''.join(ch for ch in text if unicodedata.category(ch) != 'Mn')


def keyword_pattern(keyword):
    """Từ khoá tự thêm ("tiêm khớp") → regex so với chữ đã bỏ dấu, viết thường.

    Phải cho cùng kết quả với keywordPattern() trong src/config/routeModelCore.cjs.
    """
    folded = re.sub(r'\s+', ' ', re.sub(r'[_\-.]+', ' ', _strip_diacritics(keyword).lower())).strip()
    if not folded:
        return ''
    escaped = re.sub(r'([.*+?^${}()|\[\]\\/])', r'\\\1', folded).replace(' ', '\\s*')
    return f'(?<![a-z0-9]){escaped}(?![a-z0-9])'


_ROUTE_DEFAULTS = {'category': 'khac', 'report': 'dose', 'tone': 'gray'}


def merge_route_table(base, custom):
    """Gộp bảng chuẩn với phần tự cài — cùng quy tắc với mergeRouteTable() phía JS."""
    routes = [dict(r, builtin=True) for r in base.get('routes', [])]
    user_rules = []
    for item in ((custom or {}).get('routes') or []):
        code = str((item or {}).get('code') or '').strip().upper()
        if not code:
            continue
        patch = {k: str(item[k]).strip() for k in ('label', 'short', 'category', 'report', 'tone', 'research_value')
                 if item.get(k) is not None and str(item[k]).strip() != ''}
        idx = next((i for i, r in enumerate(routes) if r['code'] == code), -1)
        if idx >= 0:
            routes[idx] = dict(routes[idx], **patch, customized=bool(patch))
        else:
            label = patch.get('label') or code
            new_route = dict(_ROUTE_DEFAULTS, short=code,
                             research_value=re.sub(r'\s+', '_', _strip_diacritics(label).lower()))
            new_route.update(patch)
            new_route.update(label=label, code=code, builtin=False)
            routes.insert(max(len(routes) - 1, 0), new_route)
        patterns = [p for p in (keyword_pattern(k) for k in (item.get('keywords') or [])) if p]
        if patterns:
            user_rules.append({'route': code, 'patterns': patterns, 'user': True})
    merged = dict(base)
    merged.update(routes=routes, rules=user_rules + list(base.get('rules', [])), custom=custom or {'routes': []})
    return merged


def _mtime(path):
    try:
        return os.path.getmtime(path)
    except OSError:
        return 0


def _read_json(path, fallback):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except (OSError, ValueError):
        return fallback


def load_route_table():
    """Bảng đã gộp; tự nạp lại khi config/routes.json hoặc routes.custom.json thay đổi."""
    return _load_route_table_cached(_mtime(ROUTES_FILE), _mtime(CUSTOM_ROUTES_FILE))


@lru_cache(maxsize=2)
def _load_route_table_cached(_base_mtime, _custom_mtime):
    with open(ROUTES_FILE, 'r', encoding='utf-8') as f:
        base = json.load(f)
    data = merge_route_table(base, _read_json(CUSTOM_ROUTES_FILE, {'routes': []}))
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
