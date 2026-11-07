# -*- coding: utf-8 -*-
"""Giữ y lệnh gốc dưới dạng event để UI/debug không bị mất thông tin."""

import re


def classify_raw_order_line(line):
    low = str(line or '').lower()
    if not low.strip():
        return 'empty'
    if re.match(r'^\+\s+', low):
        body = re.sub(r'^\+\s+', '', low)
        # "+ (TT) Thuốc ..." trong "+ Y lệnh khác:" là một dòng thuốc tự túc, không phải tiêu đề nhóm.
        if not re.match(r'^\(+\s*(?:tt|cs)(?:\s*\)|[0o]\)?|\s+)', body):
            return 'section'
        low = body
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


_OTHER_ORDER_HEADER_RE = re.compile(r'^\+\s*y\s*l[ệe]nh\s*kh[áa]c\s*:?\s*(.*)$', re.IGNORECASE)


def extract_other_order_block(doc_content, *, doc_name='', order_header_time=''):
    """Lấy nguyên văn mục "+ Y lệnh khác:" (ô Y lệnh khác trên phiếu EMR) của một phiếu.

    Trả về list 0 hoặc 1 phần tử {gio_y_lenh, bac_si, noi_dung}; dùng cho báo cáo
    in riêng "Y lệnh khác", không qua bộ phân loại thuốc.
    """
    lines = []
    in_section = False
    for raw in str(doc_content or '').splitlines():
        line = str(raw or '').strip()
        if not line:
            continue
        header = _OTHER_ORDER_HEADER_RE.match(line)
        if header:
            in_section = True
            if header.group(1).strip():
                lines.append(header.group(1).strip())
            continue
        if not in_section:
            continue
        if line.startswith('---') or classify_raw_order_line(line) == 'section':
            in_section = False
            continue
        if re.match(r'^\s*(?:\[\s*)?\d{1,2}(?::|h)\d{0,2}[^\n]*?(?:BS|B(?:Á|A)C\s*S(?:Ĩ|I))\s*:\s*.+$', line, re.IGNORECASE):
            in_section = False
            continue
        lines.append(line)
    if not lines:
        return []
    return [{
        'gio_y_lenh': str(order_header_time or '').strip(),
        'bac_si': str(doc_name or '').strip(),
        'noi_dung': '\n'.join(lines),
    }]
