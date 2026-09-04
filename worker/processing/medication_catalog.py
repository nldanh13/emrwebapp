# -*- coding: utf-8 -*-
"""Medication catalog: bộ nhớ thuốc và suy luận fallback.

Mục tiêu: khi EMR chỉ ghi tên thuốc, code vẫn có thể suy luận từ file cấu hình
thay vì viết if/else cứng trong parser.
"""

import json
import os
import re
import unicodedata
from functools import lru_cache

try:
    from processing.semantic_search import semantic_best_match
except Exception:  # pragma: no cover
    semantic_best_match = None

from processing.schedule_engine import build_gio_dung_from_rule, build_schedule_labels, extract_total_quantity

BASE_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), '..', '..'))
MEDICATION_CATALOG_FILE = os.path.join(BASE_DIR, 'config', 'medication_catalog.json')


def _load_json(path, fallback):
    try:
        with open(path, 'r', encoding='utf-8') as f:
            return json.load(f)
    except Exception:
        return fallback


def normalize_key(value):
    text = str(value or '').upper().replace('Đ', 'D')
    text = unicodedata.normalize('NFD', text)
    text = ''.join(ch for ch in text if unicodedata.category(ch) != 'Mn')
    text = re.sub(r'[^A-Z0-9]+', ' ', text)
    return re.sub(r'\s+', ' ', text).strip()


@lru_cache(maxsize=1)
def load_medication_catalog():
    data = _load_json(MEDICATION_CATALOG_FILE, {})
    meds = data.get('medications') or []
    normalized = []
    for med in meds:
        if not isinstance(med, dict):
            continue
        aliases = [med.get('canonical') or ''] + list(med.get('aliases') or []) + list(med.get('semantic_aliases') or [])
        med = dict(med)
        med['_all_aliases'] = [str(a).strip() for a in aliases if str(a or '').strip()]
        med['_alias_keys'] = [normalize_key(a) for a in aliases if normalize_key(a)]
        normalized.append(med)
    return normalized


def _drug_search_text(drug):
    """Chuỗi tìm thuốc trong catalog.

    Chỉ dùng tên thuốc đã parse, không dùng hoạt chất/raw_text. Nếu dùng hoạt chất,
    các thuốc phối hợp như DEGEVIC (Paracetamol + Tramadol) sẽ bị nhận nhầm thành
    THERMODOL vì catalog có alias Paracetamol.
    """
    if isinstance(drug, dict):
        parts = [drug.get('ten_thuoc'), drug.get('ten_hien_thi')]
        return normalize_key(' '.join(str(x or '') for x in parts))
    return normalize_key(drug)


def _catalog_alias_matches(text, alias, med):
    alias = normalize_key(alias)
    if not text or not alias:
        return False

    # Không cho alias Paracetamol đơn thuần bắt nhầm thuốc phối hợp
    # Paracetamol + Tramadol như DEGEVIC/ULTRACET.
    if alias == 'PARACETAMOL' and 'TRAMADOL' in text:
        return False

    # Alias nhiều từ như PARACETAMOL 1G được phép match substring.
    if ' ' in alias:
        return alias in text

    # Alias một từ: phải là token riêng, không dính trong chuỗi khác.
    return bool(re.search(rf'(?<![A-Z0-9]){re.escape(alias)}(?![A-Z0-9])', text))


def lookup_medication_with_meta(drug_or_text, *, allow_semantic=True):
    """Tra catalog theo exact trước, semantic/fuzzy sau.

    Exact match vẫn là ưu tiên tuyệt đối. Semantic match chỉ dùng khi không exact
    để bắt lỗi chính tả/phiên âm như Thermodon, pa ra xê ta môn 1g.
    """
    text = _drug_search_text(drug_or_text)
    if not text:
        return None, None

    for med in load_medication_catalog():
        aliases = med.get('_all_aliases') or ([med.get('canonical') or ''] + list(med.get('aliases') or []))
        for alias in aliases:
            if _catalog_alias_matches(text, alias, med):
                return med, {'match_type': 'exact', 'matched_alias': str(alias or ''), 'score': 1.0}

    if not allow_semantic or semantic_best_match is None:
        return None, None

    best = None
    catalog = load_medication_catalog()
    for idx, med in enumerate(catalog):
        for alias in (med.get('_all_aliases') or []):
            alias_key = normalize_key(alias)
            if len(alias_key.replace(' ', '')) < 6:
                continue
            hit = semantic_best_match(text, [alias], threshold=0.86)
            if not hit:
                continue
            if best is None or float(hit.get('score') or 0) > float(best.get('score') or 0):
                best = {'med': catalog[idx], 'matched_alias': alias, 'score': float(hit.get('score') or 0)}

    if best:
        return best['med'], {
            'match_type': 'semantic',
            'matched_alias': str(best.get('matched_alias') or ''),
            'score': float(best.get('score') or 0),
        }
    return None, None


def lookup_medication(drug_or_text):
    med, _meta = lookup_medication_with_meta(drug_or_text)
    return med


def find_catalog_hits_in_text(text):
    haystack = normalize_key(text)
    hits = []
    if not haystack:
        return hits
    seen = set()
    for med in load_medication_catalog():
        if any(alias and alias in haystack for alias in med.get('_alias_keys') or []):
            name = str(med.get('canonical') or '').strip()
            if name and name not in seen:
                seen.add(name)
                hits.append(med)
    return hits




def _extract_schedule_labels_from_gio_dung(gio_dung):
    """Tách nhãn giờ dùng, giữ phút nếu có.

    Dùng cho catalog fallback: nếu thuốc truyền có x3 nhưng EMR chỉ ghi một mốc
    như "8h" hoặc "03:35", vẫn có thể bù các cữ còn lại mà không làm mất phút.
    """
    text = str(gio_dung or '')
    pattern = re.compile(
        r'(?P<hhmm>\b(?P<h1>[01]?\d|2[0-3]):(?P<m1>[0-5]\d)\b)'
        r'|'
        r'(?P<hour>\b(?P<h2>[01]?\d|2[0-3])\s*(?:giờ|gio|h)(?![a-zA-ZÀ-ỹ0-9]))',
        flags=re.IGNORECASE,
    )
    out = []
    seen = set()
    for m in pattern.finditer(text):
        if m.group('hhmm'):
            h = int(m.group('h1'))
            mi = int(m.group('m1'))
            label = f'{h:02d}:{mi:02d}'
        else:
            h = int(m.group('h2'))
            mi = 0
            label = f'{h} giờ'
        key = f'{h:02d}:{mi:02d}'
        if key in seen:
            continue
        seen.add(key)
        out.append(label)
    return out


def _label_key(label):
    text = str(label or '')
    m = re.search(r'\b([01]?\d|2[0-3]):([0-5]\d)\b', text)
    if m:
        return f'{int(m.group(1)):02d}:{int(m.group(2)):02d}'
    m = re.search(r'\b([01]?\d|2[0-3])\s*(?:giờ|gio|h)(?![a-zA-ZÀ-ỹ0-9])', text, flags=re.IGNORECASE)
    if m:
        return f'{int(m.group(1)):02d}:00'
    return normalize_key(text)


def _label_as_order_time(label):
    key = _label_key(label)
    if re.match(r'^\d{2}:\d{2}$', key):
        return key
    return ''


def _expand_catalog_schedule_if_needed(out, med):
    """Bù thêm giờ cho thuốc trong catalog nếu số cữ ít hơn số lượng xN.

    Ví dụ: "Paracetamol 1g 01 chai x3 (TTM) 100g/p/8h" parser ban đầu chỉ
    thấy 8h; catalog THERMODOL sẽ bù thành 8h, 16h, 23h.
    """
    rule_name = med.get('schedule_rule') if isinstance(med, dict) else None
    if not rule_name:
        return out

    total = extract_total_quantity(out, default=1)
    if total <= 1:
        return out

    existing = _extract_schedule_labels_from_gio_dung(out.get('gio_dung', ''))
    if len(existing) >= total:
        return out

    first_time = _label_as_order_time(existing[0]) if existing else ''
    order_time = first_time or str(out.get('gio_y_lenh') or '')
    candidates = build_schedule_labels(rule_name, order_time=order_time, total_count=total)

    expanded = list(existing)
    seen = {_label_key(x) for x in expanded}
    for cand in candidates:
        key = _label_key(cand)
        if key in seen:
            continue
        seen.add(key)
        expanded.append(cand)
        if len(expanded) >= total:
            break

    if len(expanded) > len(existing):
        out['gio_dung'] = ', '.join(expanded[:total])
        out['inferred_schedule_expanded'] = True
    return out

def _has_usage(drug):
    return bool(str((drug or {}).get('duong_dung_goc') or '').strip() or str((drug or {}).get('gio_dung') or '').strip())


def _has_oral_marker(text):
    return bool(re.search(
        r"\(\s*u\s*\)|\buống\b|\buong\b|(?<![0-9a-zA-ZÀ-ỹ])u(?![0-9a-zA-ZÀ-ỹ])",
        str(text or '').lower(),
        flags=re.IGNORECASE,
    ))


def _has_explicit_non_infusion_route(text):
    t = str(text or '').lower()
    if _has_oral_marker(t):
        return True
    has_infusion_hint = bool(re.search(
        r"\bttm\b|truyền|truyen|tiêm\s*truyền|tiem\s*truyen|giọt/phút|giot/phut|g/p|ml/h|ml/giờ|nacl|natri\s+(?:clorid|chlorid|chloride)|sodium\s+(?:clorid|chlorid|chloride)|sodium\s*0[\.,]9",
        t,
        flags=re.IGNORECASE,
    ))
    has_injection_hint = bool(re.search(
        r"tiêm|tiem|tĩnh\s*mạch\s*chậm|tinh\s*mach\s*cham|tmc|bắp|bap|dưới\s*da|duoi\s*da",
        t,
        flags=re.IGNORECASE,
    ))
    return has_injection_hint and not has_infusion_hint


def _is_oral_solid_form(drug):
    """Nhận diện thuốc dạng uống rắn để không suy luận nhầm sang dịch truyền.

    Trường hợp thực tế: PHARBACOL (Paracetamol) 650mg x 3 (Viên) bị semantic
    match với alias PHARBACOL 1G trong catalog THERMODOL và bị đẩy sang TTM.
    Khi dạng là Viên/Gói và không có chỉ định truyền rõ ràng, phải giữ là thuốc uống/khác.
    """
    if not isinstance(drug, dict):
        return False
    form = normalize_key(drug.get('dang') or '')
    text = normalize_key(' '.join(str(drug.get(k) or '') for k in (
        'ten_thuoc', 'ten_hien_thi', 'raw_text', 'raw_drug_part'
    )))
    oral_form = any(k in form for k in ('VIEN', 'GOI', 'GÓI')) or bool(re.search(r'\b(VIEN|GOI)\b', text))
    infusion_hint = bool(re.search(
        r'\b(TTM|TRUYEN|TIEM TRUYEN|GIOT PHUT|G P|ML H|NACL|NATRI CLORID|SODIUM CHLORIDE)\b',
        text,
        flags=re.IGNORECASE,
    ))
    return oral_form and not infusion_hint


def complete_medication_from_catalog(drug, *, only_if_missing_usage=True):
    """Điền các thông tin còn thiếu từ catalog nếu phù hợp.

    Hàm chỉ bổ sung field đang trống, không ghi đè thông tin EMR đã đọc được.
    Vì vậy thuốc đã có đường dùng như "TTM" nhưng thiếu giờ/tốc độ/thể tích
    vẫn được bù theo catalog.

    Trả về tuple `(drug, matched_med)`.
    """
    if not isinstance(drug, dict):
        return drug, None

    route_text = str(drug.get('duong_dung_goc') or '')
    raw_route_text = ' '.join(str(drug.get(k) or '') for k in (
        'duong_dung_goc', 'raw_usage_part', 'raw_text', 'raw_drug_part'
    ))
    # Nếu EMR đã ghi rõ đường uống/tiêm thường thì tôn trọng, không bù mặc định truyền
    # để tránh các thuốc phối hợp có hoạt chất Paracetamol bị biến thành THERMODOL truyền.
    if _has_explicit_non_infusion_route(raw_route_text):
        return drug, None

    # Thuốc dạng Viên/Gói như PHARBACOL 650mg không được semantic-match sang
    # THERMODOL/PARACETAMOL 1G truyền khi thiếu dòng đường dùng.
    if _is_oral_solid_form(drug):
        return drug, None

    med, match_meta = lookup_medication_with_meta(drug)
    if not med:
        return drug, None

    out = dict(drug)
    route = str(med.get('default_route') or '').strip()
    if route:
        out['duong_dung'] = out.get('duong_dung') or route
        out['duong_dung_goc'] = out.get('duong_dung_goc') or str(med.get('default_route_text') or route)

    if med.get('default_rate') and not out.get('toc_do'):
        out['toc_do'] = str(med.get('default_rate'))
    if med.get('default_volume_ml') and not out.get('the_tich'):
        out['the_tich'] = float(med.get('default_volume_ml'))
        out['tui_dich_truyen_ml'] = float(med.get('default_volume_ml'))
    if med.get('default_diluent') and not out.get('dung_moi'):
        out['dung_moi'] = med.get('default_diluent')
    # Chỉ đổi tên hiển thị sang canonical khi chính tên thuốc gốc khớp canonical.
    # Ví dụ: THERMODOL thật -> hiển thị THERMODOL.
    # Nhưng "Paracetamol 1g" chỉ mượn catalog THERMODOL để bù thể tích/tốc độ/lịch truyền,
    # không được đổi tên hiển thị thành THERMODOL.
    if med.get('canonical') and not out.get('ten_hien_thi'):
        search_text = _drug_search_text(out)
        canonical_key = normalize_key(med.get('canonical'))
        if _catalog_alias_matches(search_text, canonical_key, med):
            out['ten_hien_thi'] = med.get('canonical')
        elif (match_meta or {}).get('match_type') == 'semantic':
            matched_alias_key = normalize_key((match_meta or {}).get('matched_alias'))
            if matched_alias_key == canonical_key:
                out['ten_hien_thi'] = med.get('canonical')

    if not out.get('gio_dung') and med.get('schedule_rule'):
        out['gio_dung'] = build_gio_dung_from_rule(med.get('schedule_rule'), out)
    else:
        out = _expand_catalog_schedule_if_needed(out, med)

    out['catalog_match'] = med.get('canonical') or ''
    if match_meta:
        out['catalog_match_type'] = match_meta.get('match_type')
        out['catalog_match_alias'] = match_meta.get('matched_alias')
        out['catalog_match_score'] = round(float(match_meta.get('score') or 0), 4)
    out['inferred_usage'] = True
    out['inferred_usage_reason'] = 'medication_catalog_semantic' if (match_meta or {}).get('match_type') == 'semantic' else 'medication_catalog'
    out['inference_confidence'] = 'high' if (match_meta or {}).get('match_type') == 'exact' else 'medium'
    return out, med
