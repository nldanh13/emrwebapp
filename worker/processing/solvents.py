# -*- coding: utf-8 -*-
"""Mã dung môi và tên hiển thị — đọc config/solvents.json (dùng chung với máy chủ và giao diện)."""
import json
import os
from functools import lru_cache

SOLVENTS_FILE = os.path.join(os.path.dirname(os.path.dirname(os.path.dirname(os.path.abspath(__file__)))), 'config', 'solvents.json')
_FALLBACK = [
    {'code': 'NACL_0.9', 'label': 'Natri clorid 0.9%', 'in_rule': True},
    {'code': 'SODIUM_0.9', 'label': 'Sodium chloride 0.9%', 'in_rule': False},
]


@lru_cache(maxsize=1)
def load_solvents():
    try:
        with open(SOLVENTS_FILE, 'r', encoding='utf-8') as f:
            items = (json.load(f) or {}).get('solvents') or []
        items = [x for x in items if isinstance(x, dict) and x.get('code') and x.get('label')]
        return items or list(_FALLBACK)
    except Exception:
        return list(_FALLBACK)


def solvent_label(code, default=''):
    for item in load_solvents():
        if item['code'] == code:
            return item['label']
    return default


def rule_solvents():
    """{mã: tên} các dung môi chọn được trong Quy tắc pha thuốc."""
    return {x['code']: x['label'] for x in load_solvents() if x.get('in_rule')}


def nacl_display(code):
    """Tên dung môi ghép vào tên thuốc pha truyền: "X + Natri clorid 0.9%"."""
    return solvent_label('SODIUM_0.9' if code == 'SODIUM_0.9' else 'NACL_0.9')
