# -*- coding: utf-8 -*-
"""Tính thời gian truyền và làm sạch danh sách thuốc tiêm."""
import re
import unicodedata
from datetime import datetime, timedelta

from runtime_logging import get_worker_logger
from xu_ly_config import NO_WATER_TAG_KEYWORDS, _norm_upper, parse_hours_from_gio_dung, parse_numeric_value
from processing.common import _coerce_work_date

LOG = get_worker_logger('xu_ly.infusion')


def _extract_gio_dung_times(gio_dung):
    """Tách các mốc giờ dùng, giữ nguyên phút nếu có.

    Ví dụ:
    - "03:35, 16 giờ, 23 giờ" -> 03:35 / 16:00 / 23:00
    - "8 giờ, 16 giờ" -> 08:00 / 16:00

    Không dùng regex (\\d+) vì sẽ tách sai "03:35" thành 03 và 35,
    làm mất các cữ sau trong calculate_infusion_times.
    """
    text = str(gio_dung or '')
    if not text.strip():
        return []

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
        out.append({'hour': h, 'minute': mi, 'key': key, 'label': label})
    return out

def calculate_infusion_times(dich_truyen_list, ngay_mac_dinh=None):
    """Tính giờ truyền nối tiếp & Gộp Natri vào Nefopam"""
    ngay_lam_viec = _coerce_work_date(ngay_mac_dinh)
    if not dich_truyen_list: return []
    
    def normalize_name(name):
        n_upper = name.upper()
        if "NEFOPAM" in n_upper: return f"{name} + Natri clorid 0.9%"
        if "TRAMADOL" in n_upper: return f"{name} + Natri clorid 0.9%"
        return name
    
    def get_priority(drug_name):
        n = drug_name.upper()
        if "PARACETAMOL" in n or "THERMODOL" in n: return 1
        if "NEFOPAM" in n or "TRAMADOL" in n: return 2
        if "NATRI" in n or "SODIUM" in n: return 3
        return 4

    def _qty_from_value(value, default=1.0):
        try:
            if value is None or value == "":
                return float(default)
            return float(str(value).replace(',', '.'))
        except Exception:
            return float(default)

    def _qty_for_hour(drug, h_int, gio_times):
        """Số chai/túi/lọ của đúng cữ đang xử lý."""
        dose_per_hour = drug.get("so_luong_moi_gio") or {}
        qty = None
        if h_int in dose_per_hour:
            qty = dose_per_hour.get(h_int)
        elif str(h_int) in dose_per_hour:
            qty = dose_per_hour.get(str(h_int))
        if qty is not None:
            return _qty_from_value(qty, 1.0)

        # Nếu chỉ có 1 mốc giờ thì tổng số lượng thường là số chai/túi của cữ đó.
        if len(gio_times or []) == 1:
            parsed = parse_numeric_value(drug.get("so_luong"))
            if parsed:
                return _qty_from_value(parsed, 1.0)
        return 1.0

    def _is_container_infusion(drug):
        """Các chai/túi truyền phải nhập từng chai, không gộp thể tích."""
        dang = _norm_upper(drug.get("dang", ""))
        name = _norm_upper((drug.get("ten_thuoc") or "") + " " + (drug.get("ten_hien_thi") or ""))
        raw = _norm_upper((drug.get("raw_text") or "") + " " + (drug.get("raw_drug_part") or ""))
        route = _norm_upper((drug.get("duong_dung") or "") + " " + (drug.get("duong_dung_goc") or ""))
        if any(unit in dang for unit in ("CHAI", "TUI", "TÚI", "BOTTLE", "BAG")):
            return True
        if any(unit in raw for unit in ("CHAI", "TUI", "TÚI")) and any(k in route for k in ("TTM", "TRUYEN", "TRUYỀN")):
            return True
        # NaCl/Sodium chloride dạng truyền thường là chai/túi, đôi khi parser không lấy được 'dang'.
        if any(k in name for k in ("NATRI CLORID", "NATRI CHLORID", "SODIUM CHLORIDE", "NACL")):
            return True
        return False

    def _split_count_for_container(drug, qty):
        """Chỉ tách khi số lượng là số nguyên > 1; số lẻ như 0.5A không tách."""
        try:
            q = float(qty)
        except Exception:
            return 1
        rounded = int(round(q))
        if rounded > 1 and abs(q - rounded) < 1e-6 and _is_container_infusion(drug):
            return rounded
        return 1

    def _duration_minutes(volume, rate):
        try:
            volume = float(volume or 0)
            rate = float(rate or 0)
            if volume <= 0 or rate <= 0:
                return 0
            return int((volume * 20) / rate)
        except Exception:
            return 0

    def _fallback_times_from_text(drug):
        """Suy luận giờ dùng chỉ khi y lệnh có từ khóa buổi rõ ràng.

        Không được dùng ``gio_y_lenh`` làm giờ truyền, vì 05:00 thường là giờ bác sĩ
        ra y lệnh/dự trù thuốc chứ không phải giờ bắt đầu truyền.
        Nếu không tìm được giờ dùng thật hoặc buổi dùng rõ ràng, trả về [] để bản ghi
        không sinh tg_bat_dau; bước nhập dịch truyền sẽ bỏ qua và cảnh báo thiếu giờ.
        """
        blob = " ".join(str(drug.get(k) or "") for k in (
            "gio_dung", "duong_dung_goc", "raw_usage_part", "raw_text", "raw_drug_part", "ghi_chu", "note"
        ))
        norm = _norm_upper(blob)
        norm_plain = unicodedata.normalize("NFD", norm)
        norm_plain = "".join(ch for ch in norm_plain if unicodedata.category(ch) != "Mn")
        out = []
        seen = set()

        def add(hour, minute=0, label=None):
            key = f"{int(hour):02d}:{int(minute):02d}"
            if key in seen:
                return
            seen.add(key)
            out.append({
                "hour": int(hour),
                "minute": int(minute),
                "key": key,
                "label": label or f"{int(hour)} giờ",
            })

        # Chỉ suy luận khi có các từ khóa buổi dùng thật.
        # Không suy luận từ số lượng x1/x2 hoặc giờ ra y lệnh.
        if re.search(r"\bSANG\b", norm_plain):
            add(8, 0, "sáng")
        if re.search(r"\bTRUA\b", norm_plain):
            add(14, 0, "trưa")
        if re.search(r"\bCHIEU\b", norm_plain):
            add(16, 0, "chiều")
        if re.search(r"\bTOI\b", norm_plain):
            add(20, 0, "tối")

        if out:
            return out

        # Quy ước nội bộ đang dùng tại khoa: LEVOFLOXACIN truyền 1 chai/ngày
        # nhưng một số bác sĩ chỉ ghi "01 chai truyền tĩnh mạch ..." mà không ghi
        # (8 giờ) hoặc chữ "sáng". Không được lấy giờ ra y lệnh 05:00; thay vào đó
        # mặc định 08:00 để khớp lịch dùng thuốc buổi sáng. Giữ phạm vi hẹp cho
        # LEVOFLOXACIN để tránh tự suy luận sai các thuốc truyền khác thiếu giờ.
        name_blob = _norm_upper(" ".join(str(drug.get(k) or "") for k in (
            "ten_thuoc", "ten_hien_thi", "raw_text", "raw_drug_part"
        )))
        route_blob = _norm_upper(" ".join(str(drug.get(k) or "") for k in (
            "duong_dung", "duong_dung_goc", "raw_usage_part", "raw_text"
        )))
        try:
            qty = parse_numeric_value(drug.get("so_luong"), None)
        except Exception:
            qty = None
        is_infusion_route = any(k in route_blob for k in ("TTM", "TRUYEN", "TRUYỀN", "TIEM TRUYEN", "TIÊM TRUYỀN"))

        # Một số chai/túi truyền độc lập ở khoa thường được ghi dưới y lệnh 08:00
        # nhưng dòng đường dùng không lặp lại giờ. Chỉ dùng giờ y lệnh cho whitelist hẹp
        # và chỉ khi giờ nằm trong khung ban ngày; tránh lấy nhầm y lệnh dự trù 0-5h.
        order_times = _extract_gio_dung_times(drug.get("gio_y_lenh") or "")
        first_order_time = order_times[0] if order_times else None
        amino_keywords = ("AMINOLEBAN", "AMINOPLASMA", "AMINOVEN", "AMINOSTERIL")
        is_single_amino_nutrition = any(k in name_blob for k in amino_keywords) and (qty is None or float(qty) <= 1.0)
        if is_single_amino_nutrition and is_infusion_route:
            # Các dịch đạm/nuôi dưỡng hay được ghi 01 chai truyền TM nhưng không ghi giờ cụ thể.
            # Nếu giờ y lệnh là giờ hành chánh (07-20h) thì dùng giờ đó; nếu y lệnh dự trù lúc 05:00
            # thì không lấy 05:00 mà mặc định 08:00. Khi trùng cữ 08:00 với Paracetamol, bộ xếp lịch
            # bên dưới sẽ tự đẩy bắt đầu sau Paracetamol qua last_end_time_map.
            if first_order_time and 7 <= int(first_order_time["hour"]) <= 20:
                add(first_order_time["hour"], first_order_time["minute"], first_order_time["key"])
            else:
                add(8, 0, "08:00 mặc định dịch đạm")
            return out

        # Quy ước nội bộ đang dùng tại khoa: LEVOFLOXACIN truyền 1 chai/ngày
        # nhưng một số bác sĩ chỉ ghi "01 chai truyền tĩnh mạch ..." mà không ghi
        # (8 giờ) hoặc chữ "sáng". Không lấy giờ ra y lệnh 05:00; mặc định 08:00.
        is_single_levo = "LEVOFLOXACIN" in name_blob and (qty is None or float(qty) <= 1.0)
        if is_single_levo and is_infusion_route:
            add(8, 0, "08:00 mặc định Levofloxacin")

        return out

    cleaned_list = []
    main_drug_map = {} 
    
    dich_truyen_list.sort(key=lambda x: get_priority(x['ten_thuoc']))

    for drug in dich_truyen_list:
        gio_times = _extract_gio_dung_times(drug.get('gio_dung', ''))
        drug_priority = get_priority(drug['ten_thuoc'])
        
        if drug_priority == 2: # Nefo/Tramadol
            cleaned_list.append(drug)
            for gio_time in gio_times:
                main_drug_map[gio_time['key']] = len(cleaned_list) - 1
        elif drug_priority == 3: # Natri (Dung môi)
            is_redundant = False
            for gio_time in gio_times:
                gio_key = gio_time['key']
                if gio_key in main_drug_map:
                    idx = main_drug_map[gio_key]; main_drug = cleaned_list[idx]
                    if not main_drug['toc_do'] and drug['toc_do']: main_drug['toc_do'] = drug['toc_do']
                    main_drug['ten_hien_thi'] = normalize_name(main_drug['ten_thuoc'])
                    # Ghi đè thể tích chuẩn (100ml)
                    if drug['the_tich'] > 0: main_drug['the_tich'] = drug['the_tich']
                    is_redundant = True
            if not is_redundant: cleaned_list.append(drug)
        else: 
            cleaned_list.append(drug)

    processed_final = []
    last_end_time_map = {}
    
    def get_sort_key(item):
        times = _extract_gio_dung_times(item.get('gio_dung', ''))
        first = times[0] if times else None
        h = first['hour'] if first else 99
        mi = first['minute'] if first else 0
        p = get_priority(item['ten_thuoc'])
        return (h, mi, p)
    cleaned_list.sort(key=get_sort_key)

    for drug in cleaned_list:
        new_drug = drug.copy()
        if "ten_hien_thi" not in new_drug: new_drug["ten_hien_thi"] = normalize_name(drug["ten_thuoc"])
        
        toc_do_str = drug.get('toc_do', '0'); the_tich = float(new_drug.get('the_tich', 0)); gio_dung_str = drug.get('gio_dung', '')
        # Fallback: nếu không có tốc độ nhưng có dung môi pha truyền (tui_dich_truyen_ml > 0),
        # dùng 30 g/p mặc định thay vì bỏ qua — trường hợp y lệnh ghi "Tiêm mỗi ngày..." không kèm XXX g/p
        if not toc_do_str and new_drug.get('tui_dich_truyen_ml', 0) and the_tich > 0:
            toc_do_str = '30'
            new_drug['toc_do'] = '30'
            new_drug['toc_do_inferred'] = True  # đánh dấu để biết đây là suy luận, không từ y lệnh
        if not toc_do_str or the_tich == 0: processed_final.append(new_drug); continue
        
        try:
            toc_do = float(re.search(r'\d+', str(toc_do_str)).group())
            if toc_do == 0: raise Exception("Rate 0")
            
            gio_times = _extract_gio_dung_times(gio_dung_str)

            def _append_scheduled_instance(drug_template, h_int, mi_int, gio_key, label, base_start, seq_index=1, seq_total=1, volume_override=None):
                """Append 1 lần truyền. Nếu x2 chai/túi cùng giờ thì gọi nhiều lần nối tiếp."""
                drug_instance = drug_template.copy()
                drug_instance["gio_dung"] = label
                if volume_override is not None:
                    drug_instance["the_tich"] = volume_override
                instance_volume = float(drug_instance.get("the_tich") or 0)
                instance_duration = _duration_minutes(instance_volume, toc_do)
                if instance_duration <= 0:
                    processed_final.append(drug_instance)
                    return base_start
                drug_instance["thoi_gian_chay_phut"] = instance_duration

                real_start = base_start
                if gio_key in last_end_time_map:
                    prev_end = last_end_time_map[gio_key]
                    if prev_end > base_start:
                        real_start = prev_end

                real_end = real_start + timedelta(minutes=instance_duration)
                last_end_time_map[gio_key] = real_end

                if seq_total > 1:
                    drug_instance["so_lo_moi_lan"] = 1
                    drug_instance["so_luong_cu"] = seq_total
                    drug_instance["thu_tu_chai"] = seq_index
                    drug_instance["tong_so_chai_cu"] = seq_total
                    drug_instance["tach_chai_truyen"] = True

                drug_instance["tg_bat_dau"] = real_start.strftime("%H:%M %d/%m/%Y")
                drug_instance["tg_ket_thuc"] = real_end.strftime("%H:%M %d/%m/%Y")
                processed_final.append(drug_instance)
                return real_end

            # Nếu dịch truyền có tốc độ/thể tích nhưng y lệnh không ghi giờ dùng cụ thể,
            # tuyệt đối KHÔNG dùng giờ ra y lệnh (ví dụ 05:00) làm giờ bắt đầu truyền.
            # 05:00 thường là giờ bác sĩ ra y lệnh/dự trù thuốc, không phải giờ thực hiện.
            # Chỉ suy luận giờ khi có từ khóa buổi rõ ràng như sáng/trưa/chiều/tối;
            # nếu vẫn không có giờ, giữ thuốc lại nhưng không tạo tg_bat_dau để bước nhập bỏ qua và cảnh báo.
            if not gio_times:
                inferred_times = _fallback_times_from_text(new_drug)
                if not inferred_times:
                    new_drug["missing_infusion_time"] = True
                    new_drug["missing_time_reason"] = "Y lệnh dịch truyền không có giờ dùng rõ ràng; không dùng giờ y lệnh làm giờ truyền."
                    processed_final.append(new_drug)
                    continue
                gio_times = inferred_times

            for gio_time in gio_times:
                # Mỗi bản ghi đã tách theo giờ -> chỉ giữ 1 mốc giờ để tránh lặp.
                # Nếu có phút như 03:35 thì phải giữ nguyên, không ép thành 03 giờ.
                h_int = int(gio_time['hour'])
                mi_int = int(gio_time['minute'])
                gio_key = gio_time['key']
                qty_this_hour = _qty_for_hour(new_drug, h_int, gio_times)
                split_count = _split_count_for_container(new_drug, qty_this_hour)

                drug_template = new_drug.copy()
                base_volume = float(new_drug.get("the_tich") or 0)
                if split_count <= 1 and qty_this_hour and qty_this_hour != 1:
                    # Không phải chai/túi truyền độc lập: giữ hành vi cũ là tính theo tổng thể tích cữ đó.
                    drug_template["so_lo_moi_lan"] = qty_this_hour
                    if base_volume > 0:
                        drug_template["the_tich"] = base_volume * qty_this_hour
                elif split_count > 1:
                    # Chai/túi truyền độc lập: không gộp thể tích; sẽ nhập từng chai nối tiếp.
                    drug_template["so_lo_moi_lan"] = 1

                # Tạo đối tượng datetime cho mốc bắt đầu
                base_start = datetime.strptime(f"{h_int:02d}:{mi_int:02d} {ngay_lam_viec}", "%H:%M %d/%m/%Y")
                
                # Nếu giờ là 0-5h sáng thì coi như thuộc về ngày hôm sau của ngày y lệnh
                if h_int < 6:
                    base_start = base_start + timedelta(days=1)

                if split_count > 1:
                    for idx in range(1, split_count + 1):
                        _append_scheduled_instance(drug_template, h_int, mi_int, gio_key, gio_time['label'], base_start, idx, split_count, base_volume)
                else:
                    _append_scheduled_instance(drug_template, h_int, mi_int, gio_key, gio_time['label'], base_start)
        except Exception as exc:
            LOG.debug("Handled xu_ly fallback exception", exc_info=True)
            processed_final.append(new_drug)
        
    return processed_final

def clean_and_merge_injections(injection_list):
    """Làm sạch danh sách thuốc tiêm.

    - Loại bỏ dòng 'Nước cất' lẻ.
    - Chỉ gắn nhãn '+ Pha nước cất' cho các thuốc nhiều khả năng cần pha (thường là dạng Lọ/bột, hoặc the_tich=0,
      hoặc trong đường dùng có chữ 'pha').
    - Thuốc dạng Ống (ampoule) thông thường không tự động gắn nhãn pha nước cất.
    - Bổ sung số lọ/ống mỗi lần (so_lo_moi_lan) nếu có tổng số lượng và có nhiều giờ dùng.
      Ví dụ: so_luong=6, gio_dung='8 giờ, 16 giờ, 23 giờ' -> so_lo_moi_lan=2.
    """
    if not injection_list:
        return []

    has_water_entry = any(("NƯỚC CẤT" in (d.get("ten_thuoc", "").upper())) or ("NUOC CAT" in _norm_upper(d.get("ten_thuoc", ""))) for d in injection_list)

    main_drugs = []
    for drug in injection_list:
        name_u = (drug.get("ten_thuoc", "") or "").upper()

        # Bỏ dòng 'Nước cất' / Water for injection: chỉ dùng làm dung môi pha, không phải thuốc tiêm độc lập.
        if "NƯỚC CẤT" in name_u or "NUOC CAT" in name_u or "WATER FOR INJECTION" in name_u:
            continue

        route = (drug.get("duong_dung_goc") or "").lower()
        dang = (drug.get("dang") or "").lower()

        try:
            the_tich = float(drug.get("the_tich") or 0)
        except Exception as exc:
            LOG.debug("Handled xu_ly fallback exception", exc_info=True)
            the_tich = 0.0

        likely_needs_water = ("pha" in route) or ("lọ" in dang) or ("lo" in dang) or ("bột" in dang) or ("bot" in dang) or (the_tich == 0)

        # Không gắn '+ Pha nước cất' với một số thuốc có dung môi đi kèm (ví dụ Methylprednisolon)
        no_water_tag = any(k in _norm_upper(drug.get("ten_thuoc", "")) for k in NO_WATER_TAG_KEYWORDS)

        if has_water_entry and likely_needs_water and (not no_water_tag):
            drug["ten_hien_thi"] = f"{drug.get('ten_thuoc', '')} + Pha nước cất"
        else:
            drug.setdefault("ten_hien_thi", drug.get("ten_thuoc", ""))

        # -----------------------------
        # Tính số lọ/ống mỗi lần (nếu có)
        # -----------------------------
        so_luong_raw = str(drug.get("so_luong", "")).strip()
        total_units = None
        qty_val = parse_numeric_value(so_luong_raw, None)
        if qty_val is not None:
            try:
                total_units = int(round(float(qty_val)))
            except Exception as exc:
                LOG.debug("Handled xu_ly fallback exception", exc_info=True)
                total_units = None

        hours = parse_hours_from_gio_dung(drug.get("gio_dung", ""))
        so_lan = len(hours) if hours else 1

        if total_units and so_lan > 0:
            per = total_units / float(so_lan)

            drug["so_lan_dung"] = so_lan
            drug["so_lo_tong"] = total_units

            # Chỉ làm đẹp ten_hien_thi khi chia ra được số nguyên
            if abs(per - round(per)) < 1e-9:
                per_i = int(round(per))
                drug["so_lo_moi_lan"] = per_i

                # xác định đơn vị hiển thị
                unit = None
                if ("lọ" in dang) or ("lo" in dang) or ("bột" in dang) or ("bot" in dang):
                    unit = "lọ"
                elif ("ống" in dang) or ("ong" in dang) or ("ampoule" in dang):
                    unit = "ống"

                if unit:
                    th = drug.get("ten_hien_thi") or drug.get("ten_thuoc", "")
                    if "+ Pha nước cất" in th:
                        base, tail = th.split("+ Pha nước cất", 1)
                        base = base.rstrip()
                        th = f"{base} ({per_i} {unit}) + Pha nước cất{tail}"
                    else:
                        th = f"{th} ({per_i} {unit})"
                    drug["ten_hien_thi"] = th
            else:
                # vẫn lưu lại để downstream xử lý, nhưng không chèn vào ten_hien_thi
                drug["so_lo_moi_lan"] = round(per, 3)

        main_drugs.append(drug)

    return main_drugs
