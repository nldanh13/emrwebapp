# -*- coding: utf-8 -*-
"""Nhận diện bối cảnh y lệnh: dự trù thuốc, thuốc thêm, và tách block theo bác sĩ."""
import re

def is_reserve_order_context(text: str) -> bool:
    """Nhận biết block y lệnh dự trù thuốc.

    Dấu hiệu "Dự trù thuốc" chỉ dùng nội bộ để phân biệt thuốc chuẩn bị sẵn
    với thuốc mới thêm trong ca; không đưa chữ này ra preview/chăm sóc.
    """
    t = str(text or "").lower()
    if not t:
        return False
    return bool(
        re.search(r'dự\s*trù', t, flags=re.IGNORECASE)
        or re.search(r'\bdu\s*tru\b', t, flags=re.IGNORECASE)
    )


def is_add_order_context(text: str) -> bool:
    """Nhận biết block thuốc thêm thật sự.

    Không dùng riêng mốc giờ sau 07:00 để gọi là "thuốc thêm", vì EMR có thể
    tạo y lệnh dự trù lúc 08:00. Chỉ đánh dấu thuốc thêm khi block có dấu hiệu
    rõ như dòng "Thêm:" hoặc "thêm thuốc" và không nằm trong block dự trù.
    """
    t = str(text or "")
    if not t.strip():
        return False
    return bool(
        re.search(r'(?im)^\s*(?:thêm|them)\s*:?\s*$', t)
        or re.search(r'(?i)\b(?:thêm|them)\s+thuốc\b', t)
        or re.search(r'(?i)\b(?:cho|bổ\s*sung|bo\s*sung)\s+thêm\b', t)
    )



def _normalize_reserve_time_key(raw: str) -> str:
    """Chuẩn hóa giờ header về HH:MM để nối Diễn biến ↔ Y lệnh cùng block."""
    text = str(raw or '').strip()
    if not text:
        return ''
    m = re.search(r'(\d{1,2})(?::|h)(\d{0,2})', text, flags=re.IGNORECASE)
    if not m:
        return ''
    try:
        hh = int(m.group(1))
    except Exception:
        return ''
    mm = (m.group(2) or '00').strip() or '00'
    if len(mm) == 1:
        mm = f'{mm}0'
    elif len(mm) > 2:
        mm = mm[:2]
    try:
        mi = int(mm)
    except Exception:
        mi = 0
    if not (0 <= hh <= 23 and 0 <= mi <= 59):
        return ''
    return f'{hh:02d}:{mi:02d}'


def _normalize_doctor_key(raw: str) -> str:
    text = str(raw or '').strip().lower()
    text = re.sub(r'\s+', ' ', text)
    return text


def build_reserve_context_from_dien_bien(raw_dien_bien: str, default_doc_name: str = '') -> dict:
    """Lấy các mốc Diễn biến có ghi 'Dự trù thuốc'.

    Trong EMR, chữ 'Dự trù thuốc ngày ...' thường nằm ở ô Diễn biến bệnh,
    còn danh sách thuốc nằm ở ô Y lệnh cùng giờ. Vì vậy không thể chỉ dò
    'Dự trù' trong nội dung Y lệnh. Hàm này tạo lookup theo giờ/bác sĩ để
    parser thuốc biết block Y lệnh nào là thuốc đã chuẩn bị sẵn.
    """
    lookup = {"times": set(), "doctor_times": set()}
    for doc_name, content, header_time in split_content_by_doctor(raw_dien_bien or '', default_doc_name=default_doc_name or 'Không rõ'):
        if not is_reserve_order_context(content):
            continue
        tkey = _normalize_reserve_time_key(header_time or content)
        if not tkey:
            continue
        lookup["times"].add(tkey)
        dkey = _normalize_doctor_key(doc_name)
        if dkey:
            lookup["doctor_times"].add((dkey, tkey))
    return lookup


def is_reserve_context_for_order(raw_order_text: str, doc_name: str = '', header_time: str = '', reserve_lookup: dict | None = None) -> bool:
    """True nếu block Y lệnh là thuốc dự trù/chuẩn bị sẵn."""
    if is_reserve_order_context(raw_order_text):
        return True
    lookup = reserve_lookup or {}
    tkey = _normalize_reserve_time_key(header_time or raw_order_text)
    if not tkey:
        return False
    dkey = _normalize_doctor_key(doc_name)
    if dkey and (dkey, tkey) in (lookup.get("doctor_times") or set()):
        return True
    return tkey in (lookup.get("times") or set())

# ==============================================================================
# 3. HÀM TÁCH VĂN BẢN THEO BÁC SĨ
# ==============================================================================
def split_content_by_doctor(text, default_doc_name="Không rõ"):
    """
    Cắt chuỗi văn bản thành các đoạn nhỏ theo header bác sĩ.

    Hỗ trợ cả 2 kiểu thường gặp:
    1) [10:30 25/01/2026 - BS: Nguyễn Văn A]
    2) 10:30 | Bác sĩ: Nguyễn Văn A

    Trả về list tuple: [(Tên BS, Nội dung, Giờ header y lệnh), ...]
    """
    if not text:
        return []

    def _extract_header_time(header_line: str) -> str:
        line = (header_line or '').strip()
        m = re.search(r'(\d{1,2})(?::|h)(\d{0,2})', line, re.IGNORECASE)
        if not m:
            return ''
        hh = int(m.group(1))
        mm = (m.group(2) or '00').strip() or '00'
        if len(mm) == 1:
            mm = f'{mm}0'
        elif len(mm) > 2:
            mm = mm[:2]
        return f'{hh:02d}:{mm}'

    # Bắt header ở đầu dòng, hỗ trợ "BS:" và "Bác sĩ:"
    header_re = re.compile(
        r'(?im)^\s*'                                # đầu dòng
        r'(?:\[\s*)?'                              # có thể có [
        r'\d{1,2}(?::|h)\d{0,2}'                   # 07:00 / 7h / 7h30
        r'[^\n]*?'                                  # phần giữa (ngày, -, | ...)
        r'(?:BS|B(?:Á|A)C\s*S(?:Ĩ|I))\s*:\s*'     # BS: hoặc Bác sĩ:
        r'(?P<doc>[^\]\n]+?)'                      # tên bác sĩ
        r'\s*(?:\])?\s*$'                         # có thể có ]
    )

    matches = list(header_re.finditer(text))
    if not matches:
        return [(default_doc_name, text, '')]

    result_segments = []

    # Đoạn trước header đầu tiên (nếu có)
    first_match = matches[0]
    if first_match.start() > 0:
        content = text[:first_match.start()].strip()
        if len(content) > 5:
            result_segments.append((default_doc_name, content, ''))

    # Các đoạn theo từng header
    for i, m in enumerate(matches):
        doc_name = (m.group('doc') or '').strip() or default_doc_name
        header_line = (m.group(0) or '').strip()
        order_header_time = _extract_header_time(header_line)
        start_pos = m.end()
        end_pos = matches[i + 1].start() if i < len(matches) - 1 else len(text)
        content_body = text[start_pos:end_pos].strip()
        content = (header_line + '\n' + content_body).strip() if header_line else content_body
        if content:
            result_segments.append((doc_name, content, order_header_time))

    return result_segments
