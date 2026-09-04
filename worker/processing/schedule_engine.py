# -*- coding: utf-8 -*-
"""Tạo lịch giờ dùng thuốc từ luật cấu hình.

Module này không biết tên thuốc cụ thể. Nó chỉ nhận `schedule_rule`, số lượng
và giờ y lệnh rồi trả về chuỗi giờ dùng mà các parser hiện có hiểu được.
"""

import json
import os
import re
from functools import lru_cache

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
SCHEDULE_RULES_FILE = os.path.join(BASE_DIR, 'config', 'schedule_rules.json')


def _load_json(path, fallback):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return fallback


@lru_cache(maxsize=1)
def load_schedule_rules():
    data = _load_json(SCHEDULE_RULES_FILE, {})
    return data.get('rules') or {}


def parse_hhmm(value):
    m = re.search(r'\b(\d{1,2}):(\d{2})\b', str(value or ''))
    if not m:
        return None
    h = int(m.group(1)); mi = int(m.group(2))
    if 0 <= h <= 23 and 0 <= mi <= 59:
        return h, mi, f'{h:02d}:{mi:02d}'
    return None


def hhmm_to_minutes(value):
    parsed = parse_hhmm(value)
    if not parsed:
        return None
    h, mi, _ = parsed
    return h * 60 + mi


def extract_total_quantity(drug, default=1):
    try:
        m = re.search(r'\d+', str((drug or {}).get('so_luong') or ''))
        if not m:
            return default
        value = int(m.group(0))
        return value if value > 0 else default
    except Exception:
        return default


def _routine_label(hhmm):
    parsed = parse_hhmm(hhmm)
    if not parsed:
        return str(hhmm or '').strip()
    h, mi, _ = parsed
    return f'{h} giờ' if mi == 0 else f'{h:02d}:{mi:02d}'


def build_schedule_labels(rule_name, *, order_time='', total_count=1):
    """Trả về list label giờ dùng theo rule.

    Label dạng `03:35` là giờ chính xác. Label dạng `16 giờ` là giờ cữ.
    """
    rules = load_schedule_rules()
    rule = rules.get(rule_name or '') or {}
    routine_times = list(rule.get('routine_times') or ['08:00', '16:00', '23:00'])
    max_count = int(rule.get('max_count') or 6)
    total_count = max(1, min(int(total_count or 1), max_count))

    out = []
    seen = set()

    def push(label):
        label = str(label or '').strip()
        if not label or label in seen:
            return
        seen.add(label)
        out.append(label)

    order_parsed = parse_hhmm(order_time)
    order_minutes = hhmm_to_minutes(order_time)

    first_dose = str(rule.get('first_dose') or 'routine').lower()
    if first_dose == 'gio_y_lenh' and order_parsed:
        push(order_parsed[2])

    first_routine_minutes = hhmm_to_minutes(routine_times[0]) if routine_times else None
    for idx, rt in enumerate(routine_times):
        if len(out) >= total_count:
            break
        rt_minutes = hhmm_to_minutes(rt)
        if (
            idx == 0
            and first_dose == 'gio_y_lenh'
            and rule.get('skip_first_routine_when_order_before_first')
            and order_minutes is not None
            and first_routine_minutes is not None
            and order_minutes < first_routine_minutes
        ):
            # Y lệnh như THERMODOL lúc 03:35: cữ đầu chính là 03:35,
            # không thêm lại cữ 08:00 nữa.
            continue
        if rule.get('skip_routine_not_after_order_time') and order_minutes is not None and rt_minutes is not None:
            if rt_minutes <= order_minutes:
                continue
        push(_routine_label(rt))

    # Nếu vẫn thiếu cữ, lặp lại routine từ đầu để không làm mất số lượng.
    for rt in routine_times:
        if len(out) >= total_count:
            break
        push(_routine_label(rt))

    return out[:total_count]


def build_gio_dung_from_rule(rule_name, drug):
    total = extract_total_quantity(drug, default=1)
    labels = build_schedule_labels(rule_name, order_time=(drug or {}).get('gio_y_lenh') or '', total_count=total)
    return ', '.join(labels)
