# -*- coding: utf-8 -*-
"""Giữ y lệnh gốc dưới dạng event để UI/debug không bị mất thông tin."""

import re


def classify_raw_order_line(line):
    low = str(line or '').lower()
    if not low.strip():
        return 'empty'
    if re.match(r'^\+\s+', low):
        return 'section'
    if 'ngưng' in low or 'ngung' in low:
        return 'stop'
    if any(k in low for k in ['tiêm truyền', 'truyền tĩnh mạch', 'ttm', 'giọt/ph', 'g/ph']):
        return 'infusion_usage'
    if any(k in low for k in ['tiêm mạch chậm', 'tiêm bắp', 'dưới da', 'tmc']):
        return 'injection_usage'
    if 'uống' in low or re.search(r'\(\s*u\s*\)', low):
        return 'oral_usage'
    if any(k in low for k in ['xét nghiệm', 'crp', 'tổng phân tích', 'x-quang', 'siêu âm', 'ct ', 'mri']):
        return 'procedure'
    if re.search(r'[A-Za-zÀ-ỹ].*\s+x\s*\d+', str(line or ''), re.IGNORECASE):
        return 'drug_name'
    return 'other'


def build_raw_order_events(doc_content, *, doc_name='', order_header_time='', ngay_lam=''):
    events = []
    for idx, raw in enumerate(str(doc_content or '').splitlines(), start=1):
        line = str(raw or '').strip()
        if not line:
            continue
        if re.match(r'^\s*(?:\[\s*)?\d{1,2}(?::|h)\d{0,2}[^\n]*?(?:BS|B(?:Á|A)C\s*S(?:Ĩ|I))\s*:\s*.+$', line, re.IGNORECASE):
            continue
        events.append({
            'ngay_lam': ngay_lam,
            'gio_y_lenh': str(order_header_time or '').strip(),
            'bac_si': str(doc_name or '').strip(),
            'line_no': idx,
            'kind': classify_raw_order_line(line),
            'text': line,
        })
    return events
