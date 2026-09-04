# -*- coding: utf-8 -*-
"""Kiểm tra sau xử lý để phát hiện ca có y lệnh nhưng output bị rơi dữ liệu.

Không sửa dữ liệu ở đây. Module này chỉ tạo cảnh báo/log để biết record nào cần xem lại.
"""

import json
import os
import re
from datetime import datetime

try:
    from processing.medication_catalog import find_catalog_hits_in_text, lookup_medication, normalize_key
except Exception:  # pragma: no cover
    def find_catalog_hits_in_text(text):
        return []
    def lookup_medication(value):
        return None
    def normalize_key(value):
        return str(value or '').upper()

try:
    from processing.processing_logger import log_sanity_warning
except Exception:  # pragma: no cover
    def log_sanity_warning(warning):
        return None


_MEDICATION_HINTS = [
    r'\bti[eê]m\b', r'ti[eê]m\s+truy[eề]n', r'truy[eề]n\s+tĩnh\s+mạch',
    r'\bttm\b', r'ti[eê]m\s+mạch\s+chậm', r'\btmc\b', r'\buống\b',
    r'giọt\s*/\s*phút', r'\bg\s*/\s*ph', r'\bml\s*/\s*h',
]
_INFUSION_HINTS = [
    r'ti[eê]m\s+truy[eề]n', r'truy[eề]n\s+tĩnh\s+mạch', r'\bttm\b',
    r'giọt\s*/\s*phút', r'\bg\s*/\s*ph', r'\bml\s*/\s*h',
]
_ORAL_HINTS = [r'\buống\b', r'\bviên\b']
_INJECTION_HINTS = [r'ti[eê]m\s+mạch\s+chậm', r'\btmc\b', r'ti[eê]m\s+bắp', r'dưới\s+da']
_PROCEDURE_HINTS = [r'thay\s+băng', r'cắt\s+chỉ', r'đường\s+máu\s+mao\s+mạch', r'đmmm']


def _text(record):
    ns = record.get('nhap_cham_soc') or {}
    return "\n".join([str(ns.get('dien_bien') or ''), str(ns.get('y_lenh') or '')]).lower()


def _has_any(text, patterns):
    return any(re.search(p, text, re.IGNORECASE) for p in patterns)

_NEGATIVE_MEDICATION_CONTEXT_RE = re.compile(
    r'\b(?:kh[oô]ng|chưa|chua|ngưng|ngung|dừng|dung)\s+(?:c[oó]\s+)?thu[oố]c\b|\bkh[oô]ng\s+thu[oố]c\b',
    re.IGNORECASE,
)


def _is_negative_medication_context(text):
    """True nếu câu chỉ nói không/chưa/ngưng thuốc, tránh sanity false-positive."""
    return bool(_NEGATIVE_MEDICATION_CONTEXT_RE.search(text or ''))


def _med_count(record, cats=None):
    cats = cats or ['dich_truyen', 'thuoc_tiem', 'thuoc_uong', 'thuoc_tra', 'khac']
    meds = record.get('thuoc') or {}
    return sum(len(meds.get(c) or []) for c in cats)




def _skipped_medications(record):
    rule_log = record.get('rule_log') if isinstance(record.get('rule_log'), dict) else {}
    skipped = rule_log.get('skipped_medications') if isinstance(rule_log, dict) else []
    return [x for x in (skipped or []) if isinstance(x, dict)]


def _has_skipped_category(record, category=None):
    skipped = _skipped_medications(record)
    if not skipped:
        return False
    if category is None:
        return True
    return any(str(x.get('category') or '') == category for x in skipped)


def _skipped_medication_keys(record):
    keys = set()
    for item in _skipped_medications(record):
        raw = ' '.join(str(item.get(k) or '') for k in ['ten_thuoc', 'ten_hien_thi', 'catalog_match'])
        key = normalize_key(raw)
        if key:
            keys.add(key)
    return keys


def _preop_or_operating_room_context(text):
    return bool(re.search(r'trước\s+rạch\s+da|truoc\s+rach\s+da|trước\s+mổ|truoc\s+mo|duyệt\s+mổ|duyet\s+mo|chờ\s+mổ|cho\s+mo', text or '', re.IGNORECASE))


def _parsed_medication_keys(record, cats=None):
    cats = cats or ['dich_truyen', 'thuoc_tiem', 'thuoc_uong', 'thuoc_tra']
    meds = record.get('thuoc') or {}
    keys = set()
    for cat in cats:
        for item in (meds.get(cat) or []):
            key = normalize_key(' '.join(str(item.get(k) or '') for k in ['ten_thuoc', 'hoat_chat', 'ten_hien_thi', 'catalog_match']))
            if key:
                keys.add(key)
    return keys


def _warning(record, code, message):
    return {
        'code': code,
        'ngay_lam': record.get('ngay_lam', ''),
        'ma_bn': record.get('ma_bn', ''),
        'ho_ten': record.get('ho_ten', ''),
        'so_phong': record.get('so_phong', ''),
        'message': message,
        'gio_y_lenh': record.get('gio_y_lenh', ''),
        'level': 'warning',
    }


def run_sanity_checks(records):
    warnings = []
    for record in records or []:
        txt = _text(record)
        if not txt.strip():
            continue

        meds = record.get('thuoc') or {}
        chi = record.get('chi_dinh_khac') or {}

        if _has_any(txt, _INFUSION_HINTS) and not meds.get('dich_truyen') and not _has_skipped_category(record, 'dich_truyen'):
            warnings.append(_warning(record, 'INFUSION_TEXT_BUT_EMPTY', 'Y lệnh có dấu hiệu dịch truyền nhưng dich_truyen rỗng.'))

        if _has_any(txt, _INJECTION_HINTS) and not meds.get('thuoc_tiem') and not _has_skipped_category(record, 'thuoc_tiem') and not _preop_or_operating_room_context(txt):
            warnings.append(_warning(record, 'INJECTION_TEXT_BUT_EMPTY', 'Y lệnh có dấu hiệu thuốc tiêm nhưng thuoc_tiem rỗng.'))

        if _has_any(txt, _ORAL_HINTS) and not meds.get('thuoc_uong') and not _has_skipped_category(record, 'thuoc_uong'):
            warnings.append(_warning(record, 'ORAL_TEXT_BUT_EMPTY', 'Y lệnh có dấu hiệu thuốc uống nhưng thuoc_uong rỗng.'))

        if (
            _has_any(txt, _MEDICATION_HINTS)
            and _med_count(record) == 0
            and not _has_skipped_category(record)
            and not _is_negative_medication_context(txt)
            and not _preop_or_operating_room_context(txt)
        ):
            warnings.append(_warning(record, 'MEDICATION_TEXT_BUT_NO_MED', 'Y lệnh có dấu hiệu thuốc nhưng không phân loại ra thuốc nào.'))

        if _has_any(txt, _PROCEDURE_HINTS):
            tb = chi.get('thay_bang_cat_chi') or []
            dm = chi.get('duong_mau_mao_mach') or []
            if ('thay băng' in txt or 'cắt chỉ' in txt) and not tb:
                warnings.append(_warning(record, 'DRESSING_TEXT_BUT_EMPTY', 'Có thay băng/cắt chỉ trong y lệnh nhưng danh sách thay_bang_cat_chi rỗng.'))
            if ('đường máu mao mạch' in txt or 'đmmm' in txt) and not dm:
                warnings.append(_warning(record, 'GLUCOSE_TEXT_BUT_EMPTY', 'Có ĐMMM trong y lệnh nhưng danh sách duong_mau_mao_mach rỗng.'))

        # Catalog check: thuốc đã nằm trong bộ nhớ nhưng vẫn còn ở nhóm khac/chưa parse.
        for item in (meds.get('khac') or []):
            med = lookup_medication(item)
            if med:
                w = _warning(record, 'KNOWN_MEDICATION_IN_KHAC', f"Thuốc {med.get('canonical')} có trong medication_catalog nhưng vẫn nằm ở nhóm khac.")
                w['ten_thuoc'] = item.get('ten_thuoc') or med.get('canonical') or ''
                warnings.append(w)

        parsed_keys = _parsed_medication_keys(record) | _skipped_medication_keys(record)
        for med in find_catalog_hits_in_text(txt):
            canonical = med.get('canonical') or ''
            canon_key = normalize_key(' '.join([canonical] + list(med.get('aliases') or [])))
            if canonical and not any(normalize_key(canonical) in key or key in canon_key for key in parsed_keys):
                w = _warning(record, 'CATALOG_MEDICATION_TEXT_NOT_PARSED', f"Y lệnh có {canonical} nhưng chưa thấy thuốc này trong nhóm đã phân loại.")
                w['ten_thuoc'] = canonical
                warnings.append(w)

    for warning in warnings:
        log_sanity_warning(warning)
    return warnings


def attach_warnings_to_records(records, warnings):
    """Gắn cảnh báo vào từng record để frontend hiện trực tiếp."""
    if not records or not warnings:
        return records
    by_key = {}
    for warning in warnings or []:
        key = (warning.get('ngay_lam', ''), warning.get('ma_bn', ''), warning.get('gio_y_lenh', ''))
        by_key.setdefault(key, []).append(warning)
        key2 = (warning.get('ngay_lam', ''), warning.get('ma_bn', ''), '')
        by_key.setdefault(key2, []).append(warning)

    for record in records or []:
        key = (record.get('ngay_lam', ''), record.get('ma_bn', ''), record.get('gio_y_lenh', ''))
        current = list(record.get('processing_warnings') or [])
        seen = {str(x.get('code', '')) + '|' + str(x.get('message', '')) for x in current if isinstance(x, dict)}
        for w in by_key.get(key, []):
            sig = str(w.get('code', '')) + '|' + str(w.get('message', ''))
            if sig not in seen:
                current.append(w)
                seen.add(sig)
        record['processing_warnings'] = current
    return records


def write_sanity_report(warnings, output_file, input_file=None):
    """Ghi file cảnh báo cạnh output chính. Không thay đổi DuLieu_PhanLoai.json."""
    if not output_file:
        return None
    base, _ = os.path.splitext(output_file)
    report_file = base + '_warnings.json'
    payload = {
        'created_at': datetime.now().strftime('%Y-%m-%d %H:%M:%S'),
        'input_file': input_file or '',
        'output_file': output_file,
        'count': len(warnings or []),
        'warnings': warnings or [],
    }
    with open(report_file, 'w', encoding='utf-8') as f:
        json.dump(payload, f, ensure_ascii=False, separators=(",", ":"))
    return report_file
