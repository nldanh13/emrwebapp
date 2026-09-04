# -*- coding: utf-8 -*-
"""Parser chỉ định không phải thuốc: DVKT, thay băng, ĐMMM, ăn/chăm sóc, y lệnh khác."""
import re
from shared.text_utils import norm_vi as _norm_vi_local

from runtime_logging import get_worker_logger
from xu_ly_config import _norm_upper
from processing.common import _coerce_work_date
from processing.order_context import is_add_order_context, is_reserve_order_context

LOG = get_worker_logger('xu_ly.procedure')


# _norm_vi_local → shared.text_utils.norm_vi


def _is_rehab_service_name(name: str) -> bool:
    """Các DVKT/cận lâm sàng cần chuyển thành chăm sóc VLTL."""
    t = _norm_vi_local(name)
    patterns = [
        'vltl',
        'vat ly tri lieu',
        'tap van dong',
        'tap cac kieu tho',
        'tap tho',
        'may keo gian cot song',
        'keo gian cot song',
        'dieu tri bang may keo gian cot song',
    ]
    return any(p in t for p in patterns)

def normalize_diet_care(raw_y_lenh):
    """Chuẩn hoá 'chế độ ăn / chăm sóc' thành 1 chuỗi ngắn: <MÃ> - <TÊN> - <CS...>

    - Ưu tiên lấy mã BT/DD/PT/TM từ các dòng như: 'PT01 - Cháo', 'BT01 - Cơm', ...
    - Nếu không có mã, mặc định BT01.
    - care_level lấy theo 'Cấp 1/2/3' nếu có, không mặc định ép DD01.
    """
    raw_y_lenh = raw_y_lenh or ""
    lines = raw_y_lenh.split('\n')

    diet_code = "BT01"
    diet_name = "Cơm"
    care_level = "CSCIIC"

    # 1) Lấy mã diet từ dòng có mã rõ ràng
    code_pos = None
    code_val = None
    code_re = re.compile(r'\b(bt\d+|dd\d+|pt\d+|tm\d+)\b', re.I)
    for i, line in enumerate(lines):
        m = code_re.search(line)
        if m:
            code_val = m.group(1).upper()
            code_pos = i
            break
    if code_val:
        diet_code = code_val

    full_text = " ".join(lines).lower()

    # 2) Tên diet: ưu tiên từ dòng mã nếu có, nếu không thì từ toàn văn
    def _pick_name(text: str):
        t = (text or "").lower()
        if "cháo" in t: return "Cháo"
        if "súp" in t: return "Súp"
        if "sữa" in t: return "Sữa"
        if "phở" in t: return "Phở"
        if "cơm" in t: return "Cơm"
        return None

    if code_pos is not None:
        name = _pick_name(lines[code_pos])
        if name:
            diet_name = name
    else:
        name = _pick_name(full_text)
        if name:
            diet_name = name

    # 3) Cấp chăm sóc
    if "cấp 1" in full_text or "cấp i" in full_text:
        care_level = "CSCI"
    elif "cấp 2" in full_text or "cấp ii" in full_text:
        care_level = "CSCIIC"
    elif "cấp 3" in full_text or "cấp iii" in full_text:
        care_level = "CSCIII"

    return f"{diet_code} - {diet_name} - {care_level}"


def extract_dvkt_with_time(raw_y_lenh: str, ngay_mac_dinh=None):
    """Tách '+ Chỉ định DVKT' thành biến riêng và gắn thời gian theo block timestamp.

    Trả về:
    - dvkt_list: list[dict]  {ten, gio}
    - duong_mau_list: list[dict] {ten, gio}  (tách riêng các chỉ định đường máu mao mạch)
    """
    ngay_lam_viec = _coerce_work_date(ngay_mac_dinh)
    dvkt_list = []
    duong_mau_list = []

    if not raw_y_lenh:
        return dvkt_list, duong_mau_list

    current_ts = None
    in_dvkt = False

    for line in raw_y_lenh.split('\n'):
        s = line.strip()
        if not s:
            continue

        # Hỗ trợ 2 dạng header thời gian y lệnh:
        # 1) [07:00 25/02/2026 - Bác sĩ ...]
        # 2) 07:00 | Bác sĩ: ...
        m_ts = re.match(r'^\[(\d{1,2}:\d{2})\s+(\d{2}/\d{2}/\d{4})\s*\-', s)
        if m_ts:
            current_ts = f"{m_ts.group(1)} {m_ts.group(2)}"
            in_dvkt = False
            continue

        m_ts_pipe = re.match(r'^(\d{1,2}:\d{2})\s*\|', s)
        if m_ts_pipe:
            # Dạng này không có ngày trong line -> dùng ngày mặc định hiện tại
            current_ts = f"{m_ts_pipe.group(1)} {ngay_lam_viec}"
            in_dvkt = False
            continue

        low = s.lower()

        low_norm = _norm_vi_local(s)

        if low.startswith('+ chỉ định dvkt') or low_norm.startswith('+ chi dinh dvkt') \
                or low.startswith('+ cận lâm sàng') or low_norm.startswith('+ can lam sang') \
                or low.startswith('cận lâm sàng') or low_norm.startswith('can lam sang'):
            in_dvkt = True
            continue

        if in_dvkt and s.startswith('+'):
            in_dvkt = False

        if not in_dvkt:
            continue

        if s.startswith('-'):
            ten = re.sub(r'^[-\s]+', '', s).strip()
            if not ten:
                continue
            gio = current_ts or f"08:00 {ngay_lam_viec}"
            item = {"ten": ten, "gio": gio}

            if ('đường máu' in ten.lower()) or ('mao mạch' in ten.lower()):
                duong_mau_list.append(item)
            else:
                dvkt_list.append(item)

    return dvkt_list, duong_mau_list


def _detect_truyen_mau_cls(raw_y_lenh: str) -> dict:
    """Nhận biết dự trù máu từ các dòng CLS / 'Cận lâm sàng:' trong y lệnh.

    Trả về dict:
    - co_truyen_mau:      bool  — có dự trù khối hồng cầu (chỉ số quyết định)
    - co_dinh_nhom_abo:   bool  — có xét nghiệm định nhóm ABO
    - co_dinh_nhom_rh:    bool  — có xét nghiệm định nhóm Rh(D)
    - co_khoi_hong_cau:   bool  — có y lệnh khối hồng cầu
    - co_phan_ung_hoa_hop: bool — có ≥1 loại phản ứng hòa hợp
    - co_van_chuyen:      bool  — có chi phí vận chuyển máu
    """
    text_l = _norm_upper(raw_y_lenh or "").lower()

    co_khoi_hong_cau    = "khoi hong cau" in text_l
    co_phan_ung_hoa_hop = "phan ung hoa hop" in text_l
    co_van_chuyen       = ("van chuyen mau" in text_l) or ("chi phi van chuyen mau" in text_l)
    co_dinh_nhom_abo    = ("dinh nhom mau" in text_l and "abo" in text_l)
    co_dinh_nhom_rh     = ("dinh nhom mau" in text_l and ("rh" in text_l or "rhesus" in text_l))

    # Điều kiện đủ: phải có khối hồng cầu (indicator mạnh nhất)
    co_truyen_mau = co_khoi_hong_cau

    return {
        "co_truyen_mau":       co_truyen_mau,
        "co_dinh_nhom_abo":    co_dinh_nhom_abo,
        "co_dinh_nhom_rh":     co_dinh_nhom_rh,
        "co_khoi_hong_cau":    co_khoi_hong_cau,
        "co_phan_ung_hoa_hop": co_phan_ung_hoa_hop,
        "co_van_chuyen":       co_van_chuyen,
    }


def extract_procedures_detailed(raw_y_lenh, patient_data, ngay_mac_dinh=None):
    """Tách các chỉ định/thủ thuật thường gặp (không phải thuốc) và DVKT."""
    ngay_lam_viec = _coerce_work_date(ngay_mac_dinh)
    text_lower = (raw_y_lenh or '').lower()
    lines = (raw_y_lenh or '').split('\n')

    chi_dinh_khac = {
        "thay_bang_cat_chi": [],
        "duong_mau_mao_mach": [],
        "vat_ly_tri_lieu": "",
        "che_do_an": "",
        "canh_bao": []
    }

    dvkt_list, duong_mau_from_dvkt = extract_dvkt_with_time(raw_y_lenh, ngay_lam_viec)

    # Thay băng/cắt chỉ (mặc định 08:00, 16:00 nếu không có giờ cụ thể)
    service_keywords = [
        "cắt chỉ vết mổ", "chiều dài ≤", "vết thương chiều dài",
        "thay băng vết mổ", "cắt chỉ"
    ]
    found_services = []
    for line in lines:
        l = line.lower()
        if any(k in l for k in service_keywords):
            clean_name = re.sub(r'^[\+\-\s]+', '', line).strip()
            if clean_name:
                found_services.append(clean_name)

    actions = []
    if found_services:
        actions.append({"ten": found_services[0], "gio": f"08:00 {ngay_lam_viec}"})
        if len(found_services) >= 2:
            actions.append({"ten": found_services[1], "gio": f"16:00 {ngay_lam_viec}"})
    elif "thay băng" in text_lower or "rửa vết thương" in text_lower:
        msg = "⚠ CẢNH BÁO: Có y lệnh 'Thay băng' nhưng chưa lên Mã DVKT!"
        chi_dinh_khac["canh_bao"].append(msg)
        actions.append({"ten": "Thay băng vết mổ (CHƯA LÊN MÃ)", "gio": f"08:00 {ngay_lam_viec}", "note": msg})

    chi_dinh_khac["thay_bang_cat_chi"] = actions

    # Đường máu mao mạch dạng dict {ten, gio}
    duong_mau_list = []
    for it in duong_mau_from_dvkt:
        duong_mau_list.append(it)

    for line in lines:
        l = line.lower()
        if "đường máu" in l or "mao mạch" in l or "test đường" in l:
            matches = re.findall(r'(\d{1,2})(?:\s*h|\s*giờ)', l)
            for hh in matches:
                try:
                    h = int(hh)
                    if 0 <= h <= 23:
                        duong_mau_list.append({"ten": "Xét nghiệm đường máu mao mạch tại giường (một lần)", "gio": f"{h:02d}:00 {ngay_lam_viec}"})
                except Exception as exc:
                    LOG.debug("Handled xu_ly fallback exception", exc_info=True)
                    pass

    seen = set()
    uniq = []
    for it in duong_mau_list:
        k = (it.get('ten',''), it.get('gio',''))
        if k in seen:
            continue
        seen.add(k)
        uniq.append(it)
    chi_dinh_khac["duong_mau_mao_mach"] = uniq

    # VLTL / phục hồi chức năng: có thể nằm trong + Cận lâm sàng / + Chỉ định DVKT.
    rehab_items = [it for it in (dvkt_list or []) if isinstance(it, dict) and _is_rehab_service_name(it.get('ten', ''))]
    has_rehab_text = any(_is_rehab_service_name(line) for line in lines)
    if rehab_items or has_rehab_text:
        match_count = re.search(r'(\d+)\s*lần', text_lower)
        vltl_count = match_count.group(1) if match_count else ""
        gio_vltl = ""
        if rehab_items:
            gio_vltl = str(rehab_items[0].get('gio') or '').strip()
        if not gio_vltl:
            gio_vltl = f"08:00 {ngay_lam_viec}"
        suffix = f" {vltl_count} lần" if vltl_count else ""
        chi_dinh_khac["vat_ly_tri_lieu"] = f"Mời tập vật lý trị liệu{suffix} {gio_vltl}".strip()

    # Ăn
    chi_dinh_khac["che_do_an"] = normalize_diet_care(raw_y_lenh or "")

    # Dự trù máu / truyền máu
    chi_dinh_khac["truyen_mau"] = _detect_truyen_mau_cls(raw_y_lenh)

    return chi_dinh_khac, dvkt_list


def extract_other_orders(raw_y_lenh):
    """Y lệnh khác (KHÔNG gộp DVKT).

    v11:
    - Không chứa: vat_ly_tri_lieu / thu_thuat / che_do_an_cham_soc
    - Không chứa nội dung '+ Chỉ định DVKT'
    """
    orders = {"moi_hoi_chan": [], "khac": []}
    if not raw_y_lenh:
        return orders

    lines = raw_y_lenh.split('\n')
    in_dvkt = False

    for line in lines:
        line = (line or '').strip()
        l_lower = line.lower()
        if not line:
            continue

        # Bỏ header thời gian/bác sĩ dùng làm mốc parse nội bộ (không đưa vào y_lenh_khac['khac'])
        if re.match(r'^\[?\s*\d{1,2}(?::|h)\d{0,2}[^\n]*\b(?:bs|b(?:á|a)c\s*s(?:ĩ|i))\s*:', line, flags=re.IGNORECASE):
            continue

        if line.startswith('[') and ']' in line:
            in_dvkt = False
            continue

        l_norm = _norm_vi_local(line)
        if l_lower.startswith('+ chỉ định dvkt') or l_norm.startswith('+ chi dinh dvkt') \
                or l_lower.startswith('+ cận lâm sàng') or l_norm.startswith('+ can lam sang') \
                or l_lower.startswith('cận lâm sàng') or l_norm.startswith('can lam sang'):
            in_dvkt = True
            continue
        if in_dvkt:
            if line.startswith('+'):
                in_dvkt = False
            continue

        if line.startswith('+') or line.startswith('---'):
            continue
        if "thực hiện y lệnh" in l_lower:
            continue
        if is_reserve_order_context(line):
            continue
        if is_add_order_context(line):
            continue

        # lọc thuốc
        if re.search(r'\s+x\s+', l_lower):
            continue
        if any(l_lower.startswith(k) for k in ["tiêm", "uống", "truyền", "pha", "bơm", "+ thuốc"]):
            continue
        # Không bỏ nguyên dòng chỉ vì có (TT): thuốc tự túc/tủ trực có thể nằm trong + Y lệnh khác.
        # Các dấu hiệu thuốc/truyền còn lại vẫn được lọc để tránh lẫn vào y_lệnh_khác.
        if any(k in l_lower for k in ["g/p", "giọt/phút"]):
            continue
        if ("mg" in l_lower or "ml" in l_lower or "ui" in l_lower) and any(u in l_lower for u in ["viên", "ống", "lọ", "chai", "túi"]):
            continue
        # lọc dòng kiểu "02 lọ (tiêm/TTM...) (20 giờ)" -> không phải y lệnh khác
        if re.match(r"^\d+\s*(lọ|ống|túi|chai|viên)\b", l_lower) and ("giờ" in l_lower) and any(k in l_lower for k in ["tiêm", "truyền", "ttm", "tĩnh mạch"]):
            continue


        if "mời bs" in l_lower or "mời" in l_lower or "hội chẩn" in l_lower or "khám" in l_lower:
            orders["moi_hoi_chan"].append(line)
        elif len(line) > 5:
            orders["khac"].append(line)

    return orders
