# -*- coding: utf-8 -*-
"""xu_ly_merge.py — Làm sạch và gộp records bệnh nhân theo ngày.
Import: from xu_ly_merge import cleanup_record_v12, merge_records_by_patient_v12, ...
"""
import re
import os
import json
from copy import deepcopy
from xu_ly_config import (
    get_route_label,
    _norm_upper, _contains_any,
    ROUTE_LABEL_MAP,
)

try:
    from processing.procedure_parser import normalize_diet_care
except Exception:
    def normalize_diet_care(raw_y_lenh):  # type: ignore[override]
        return ''

# ── Tải htn_keywords từ clinical_rules.json ───────────────────────────────────

def _load_htn_keywords():
    """Đọc danh sách từ khóa thuốc huyết áp từ config/clinical_rules.json.

    Bác sĩ có thể thêm hoạt chất mới vào JSON mà không cần sửa code.
    """
    _FALLBACK = [
        "amlodipine", "losartan", "valsartan", "telmisartan", "irbesartan",
        "candesartan", "olmesartan", "perindopril", "enalapril", "captopril",
        "lisinopril", "ramipril", "metoprolol", "bisoprolol", "carvedilol",
        "atenolol", "propranolol", "nifedipine", "diltiazem", "verapamil",
        "hydralazine", "clonidine", "methyldopa",
        "hydrochlorothiazide", "indapamide",
    ]
    try:
        base        = os.path.dirname(os.path.abspath(__file__))
        config_path = os.path.normpath(os.path.join(base, "..", "config", "clinical_rules.json"))
        if not os.path.isfile(config_path):
            return _FALLBACK
        with open(config_path, "r", encoding="utf-8") as f:
            data = json.load(f)
        keywords = data.get("htn_keywords", [])
        return [str(k).lower() for k in keywords if k] or _FALLBACK
    except Exception as e:
        print(f"[WARN] xu_ly_merge: Không đọc được htn_keywords từ config: {e}")
        return _FALLBACK

_HTN_KEYWORDS = _load_htn_keywords()

def _dedup_preserve_order(seq):
    seen = set()
    out = []
    for x in (seq or []):
        if x is None:
            continue
        s = str(x).strip()
        if not s or s in seen:
            continue
        seen.add(s)
        out.append(x)
    return out

def _dedup_dicts(seq, key_func):
    seen = set()
    out = []
    for d in (seq or []):
        if not isinstance(d, dict):
            continue
        k = key_func(d)
        if k in seen:
            continue
        seen.add(k)
        out.append(d)
    return out

def _merge_multiline(texts):
    seen = set()
    out_lines = []
    for t in (texts or []):
        for ln in str(t or "").splitlines():
            s = ln.strip()
            if not s or s in seen:
                continue
            seen.add(s)
            out_lines.append(ln.rstrip())
    return "\n".join(out_lines)

def cleanup_record_v12(rec: dict) -> dict:
    # Y lệnh khác: bỏ trùng
    yk = rec.get("y_lenh_khac") or {}
    yk["moi_hoi_chan"] = _dedup_preserve_order(yk.get("moi_hoi_chan", []))
    yk["khac"] = _dedup_preserve_order(yk.get("khac", []))
    rec["y_lenh_khac"] = yk

    # Thuốc khác: loại dòng rác (thiếu gần như toàn bộ trường) + bỏ trùng
    thuoc = rec.get("thuoc") or {}
    khac = thuoc.get("khac", []) or []

    def _is_empty_drug(d):
        if not isinstance(d, dict):
            return True
        fields = [
            d.get("hoat_chat"), d.get("ham_luong"), d.get("dang"),
            d.get("so_luong"), d.get("gio_dung"), d.get("duong_dung_goc")
        ]
        tv = d.get("the_tich")
        tv_ok = False
        try:
            tv_ok = float(tv) > 0
        except:
            tv_ok = False
        # nếu không có bất kỳ thông tin có nghĩa và không có thể tích -> coi là rác
        has_info = any(str(f or "").strip() for f in fields)
        return (not has_info) and (not tv_ok)

    khac = [d for d in khac if not _is_empty_drug(d)]
    khac = _dedup_dicts(
        khac,
        lambda d: (
            _norm_upper(d.get("ten_thuoc", "")),
            str(d.get("gio_dung", "")).strip(),
            str(d.get("duong_dung_goc", "")).strip(),
        )
    )
    thuoc["khac"] = khac
    rec["thuoc"] = thuoc

    # Chỉ định khác: bỏ trùng
    ck = rec.get("chi_dinh_khac") or {}
    ck["thay_bang_cat_chi"] = _dedup_dicts(
        ck.get("thay_bang_cat_chi", []),
        lambda d: (str(d.get("ten", "")).strip().lower(), str(d.get("gio", "")).strip())
    )
    ck["duong_mau_mao_mach"] = _dedup_dicts(
        ck.get("duong_mau_mao_mach", []),
        lambda d: (str(d.get("ten", "")).strip().lower(), str(d.get("gio", "")).strip())
    )
    ck["canh_bao"] = _dedup_preserve_order(ck.get("canh_bao", []))
    rec["chi_dinh_khac"] = ck

    # Chỉ định DVKT: bỏ trùng + bỏ những mục đã tách ra (thay băng/đường máu/VLTL)
    dvkt = rec.get("chi_dinh_dvkt", []) or []
    tb_keys = {(x.get("ten", "").strip().lower(), x.get("gio", "").strip()) for x in ck.get("thay_bang_cat_chi", [])}
    dm_keys = {(x.get("ten", "").strip().lower(), x.get("gio", "").strip()) for x in ck.get("duong_mau_mao_mach", [])}

    def _need_remove_dvkt(it):
        ten = str(it.get("ten", "")).strip().lower()
        gio = str(it.get("gio", "")).strip()
        if (ten, gio) in tb_keys or (ten, gio) in dm_keys:
            return True
        if any(k in ten for k in ["thay băng", "cắt chỉ", "đường máu mao mạch", "duong mau mao mach"]):
            return True
        if any(k in ten for k in [
            "tập vận động", "tap van dong", "vật lý trị liệu", "vat ly tri lieu",
            "vltl", "tập các kiểu thở", "tap cac kieu tho", "tập thở", "tap tho",
            "máy kéo giãn cột sống", "may keo gian cot song", "kéo giãn cột sống", "keo gian cot song",
        ]):
            return True
        return False

    dvkt = [it for it in dvkt if isinstance(it, dict) and not _need_remove_dvkt(it)]
    dvkt = _dedup_dicts(dvkt, lambda d: (str(d.get("ten", "")).strip().lower(), str(d.get("gio", "")).strip()))
    rec["chi_dinh_dvkt"] = dvkt

    # Nhập chăm sóc: bỏ trùng dòng
    ncs = rec.get("nhap_cham_soc") or {}
    ncs["dien_bien"] = _merge_multiline([ncs.get("dien_bien", "")])
    ncs["y_lenh"] = _merge_multiline([ncs.get("y_lenh", "")])
    rec["nhap_cham_soc"] = ncs

    return rec


# ==============================================================================
# PHÂN LOẠI BỆNH NHÂN THEO NHU CẦU (TM/DD/BT)
# - TM: có thuốc huyết áp (ưu tiên cao nhất)
# - DD: có xét nghiệm/đường máu (glucose/HbA1c/đường máu mao mạch)
# - BT: còn lại
# ==============================================================================
def phan_loai_benh_nhan(rec: dict) -> str:
    # 1) Thuốc huyết áp -> TM
    thuoc = rec.get("thuoc") or {}
    all_drugs = []
    for cat in ["thuoc_uong", "thuoc_tiem", "dich_truyen", "khac"]:
        all_drugs.extend(thuoc.get(cat, []) or [])
    blob = " ".join([
        str(d.get("ten_hien_thi") or d.get("ten_thuoc") or "") + " " +
        str(d.get("hoat_chat") or "") + " " +
        str(d.get("duong_dung_goc") or "")
        for d in all_drugs if isinstance(d, dict)
    ]).lower()
    if any(k in blob for k in _HTN_KEYWORDS):
        return "TM"

    # 2) Xét nghiệm đường máu -> DD
    ck = rec.get("chi_dinh_khac") or {}
    if (ck.get("duong_mau_mao_mach") or []):
        return "DD"
    dv = rec.get("chi_dinh_dvkt") or []
    dv_blob = " ".join([str(x.get("ten","")) for x in dv if isinstance(x, dict)]).lower()
    if ("glucose" in dv_blob) or ("hba1c" in dv_blob) or ("đường máu" in dv_blob) or ("duong mau" in dv_blob):
        return "DD"

    return "BT"

def _hhmm_to_minutes(hhmm: str):
    if not hhmm:
        return None
    m = re.match(r'^\s*(\d{1,2}):(\d{2})\s*$', str(hhmm))
    if not m:
        return None
    h = int(m.group(1)); mi = int(m.group(2))
    if h < 0 or h > 23 or mi < 0 or mi > 59:
        return None
    return h*60 + mi

def _extract_hhmm_any(s: str) -> str:
    """Trích xuất giờ:phút từ chuỗi, hỗ trợ các định dạng:
      - "HH:MM"     (ví dụ: "08:00", "8:00")
      - "Hh[MM]"    (ví dụ: "8h00", "8h")
      - "H giờ MM"  (ví dụ: "8 giờ 00", "8 giờ")
    Trả về chuỗi "HH:MM" hoặc "" nếu không nhận ra.
    """
    if not s:
        return ""
    src = str(s)
    # Ưu tiên dạng HH:MM
    m = re.search(r'(\d{1,2}):(\d{2})', src)
    if m:
        h, mi = int(m.group(1)), int(m.group(2))
        if 0 <= h <= 23 and 0 <= mi <= 59:
            return f"{h:02d}:{mi:02d}"
    # Dạng Hh[MM]: "8h00", "8h30", "8h"
    m = re.search(r'\b(\d{1,2})\s*h\s*(\d{2})?\b', src, re.IGNORECASE)
    if m:
        h, mi = int(m.group(1)), int(m.group(2) or 0)
        if 0 <= h <= 23 and 0 <= mi <= 59:
            return f"{h:02d}:{mi:02d}"
    # Dạng H giờ [MM]: "8 giờ 00", "8 giờ"
    m = re.search(r'\b(\d{1,2})\s*giờ\s*(\d{2})?', src, re.IGNORECASE)
    if m:
        h, mi = int(m.group(1)), int(m.group(2) or 0)
        if 0 <= h <= 23 and 0 <= mi <= 59:
            return f"{h:02d}:{mi:02d}"
    return ""

def _doctor_for_hhmm(doc_map: dict, hhmm: str) -> str:
    if not isinstance(doc_map, dict) or not doc_map:
        return ""
    hhmm = _extract_hhmm_any(hhmm)
    if not hhmm:
        return ""
    v = doc_map.get(hhmm)
    if v:
        return str(v).strip()

    t = _hhmm_to_minutes(hhmm)
    if t is None:
        return ""
    best_t = None
    best_doc = ""
    for k, v in doc_map.items():
        kk = _extract_hhmm_any(k)
        mt = _hhmm_to_minutes(kk)
        if mt is None:
            continue
        if mt <= t and (best_t is None or mt > best_t):
            best_t = mt
            best_doc = str(v).strip()
    return best_doc

def attach_doctor_into_dich_truyen_hours(record: dict) -> dict:
    if not isinstance(record, dict):
        return record

    doc_map = record.get("bac_si_theo_gio") or {}
    default_bs = str(record.get("bac_si") or "").strip()
    dt_list = (((record.get("thuoc") or {}).get("dich_truyen")) or [])

    if isinstance(dt_list, list):
        for it in dt_list:
            if not isinstance(it, dict):
                continue

            hhmm = _extract_hhmm_any(it.get("tg_bat_dau") or it.get("gio_dung") or "")
            doctor_by_time = _doctor_for_hhmm(doc_map, hhmm)

            # Ưu tiên bác sĩ ra y lệnh (nếu có), sau đó bác sĩ có sẵn trên item,
            # rồi bác sĩ theo giờ thực hiện, cuối cùng là bác sĩ mặc định cấp bệnh nhân.
            doctor_order = str(it.get("bac_si") or "").strip()
            doctor_item = str(it.get("bac_si") or "").strip()
            final_doctor = doctor_order or doctor_item or doctor_by_time or default_bs

            it["bac_si"] = str(final_doctor or "").strip()

    # Có thể bỏ map theo giờ ở cấp BN để nhẹ dữ liệu, nhưng giữ "bac_si"
    for k in ["bac_si_theo_gio", "bac_si_list", "y_lenh_theo_bac_si"]:
        if k in record:
            try:
                del record[k]
            except:
                pass
    return record
def merge_records_by_patient_v12(records: list) -> list:
    groups = {}
    first_pos = {}
    for idx, r in enumerate(records or []):
        key = (r.get("ngay_lam"), r.get("ma_bn"))
        groups.setdefault(key, []).append(r)
        if key not in first_pos:
            first_pos[key] = idx

    merged = []
    for key in sorted(groups.keys(), key=lambda k: first_pos.get(k, 10**9)):
        lst = groups[key]
        if len(lst) == 1:
            one = cleanup_record_v12(lst[0])
            # giữ/chuẩn hoá map bác sĩ theo giờ (nếu có)
            m = one.get("bac_si_theo_gio") or {}
            one["bac_si_theo_gio"] = m if isinstance(m, dict) else {}
            try:
                one.setdefault("chi_dinh_khac", {})
                one["chi_dinh_khac"]["che_do_an"] = normalize_diet_care(one.get("nhap_cham_soc", {}).get("y_lenh", ""))
            except:
                pass
            one["phan_loai_bn"] = phan_loai_benh_nhan(one)
            merged.append(one)
            continue

        base = deepcopy(lst[0])

        # gộp map bác sĩ theo giờ (union)
        merged_map = {}
        for x in lst:
            mm = x.get("bac_si_theo_gio") or {}
            if isinstance(mm, dict):
                merged_map.update(mm)
        base["bac_si_theo_gio"] = merged_map

        # merge text
        base.setdefault("nhap_cham_soc", {})
        base["nhap_cham_soc"]["dien_bien"] = _merge_multiline([x.get("nhap_cham_soc", {}).get("dien_bien", "") for x in lst])
        base["nhap_cham_soc"]["y_lenh"] = _merge_multiline([x.get("nhap_cham_soc", {}).get("y_lenh", "") for x in lst])

        # merge care_special_events
        care_special_events = []
        for x in lst:
            care_special_events.extend(x.get("care_special_events", []) or [])
        if care_special_events:
            seen_ev = set()
            dedup_ev = []
            for ev in care_special_events:
                if not isinstance(ev, dict):
                    continue
                ev_key = (ev.get("type"), ev.get("time_full") or ev.get("time_label"))
                if ev_key in seen_ev:
                    continue
                seen_ev.add(ev_key)
                dedup_ev.append(ev)
            base["care_special_events"] = dedup_ev

        # merge y_lenh_khac
        yk = {"moi_hoi_chan": [], "khac": []}
        for x in lst:
            y = x.get("y_lenh_khac") or {}
            yk["moi_hoi_chan"].extend(y.get("moi_hoi_chan", []) or [])
            yk["khac"].extend(y.get("khac", []) or [])
        base["y_lenh_khac"] = {
            "moi_hoi_chan": _dedup_preserve_order(yk["moi_hoi_chan"]),
            "khac": _dedup_preserve_order(yk["khac"]),
        }

        # merge thuoc
        # Lưu ý: phải gộp cả thuoc_tra. Trước đây khi một BN có nhiều block y lệnh
        # trong ngày, các dòng sau "+ Thuốc trả:" được parse ở từng block nhưng bị rơi
        # khi merge, làm thuoc.thuoc_tra rỗng dù nhap_cham_soc.y_lenh vẫn còn text gốc.
        base.setdefault("thuoc", {})
        for cat in ["dich_truyen", "thuoc_tiem", "thuoc_uong", "thuoc_tra", "khac"]:
            items = []
            for x in lst:
                items.extend((x.get("thuoc") or {}).get(cat, []) or [])
            if cat == "dich_truyen":
                items = _dedup_dicts(items, lambda d: (
                    (d.get("ten_hien_thi") or d.get("ten_thuoc") or "").strip().upper(),
                    str(d.get("tg_bat_dau", "")).strip(),
                    str(d.get("tg_ket_thuc", "")).strip(),
                ))
            else:
                items = _dedup_dicts(items, lambda d: (
                    (d.get("ten_hien_thi") or d.get("ten_thuoc") or "").strip().upper(),
                    str(d.get("gio_dung", "")).strip(),
                    str(d.get("duong_dung_goc", "")).strip(),
                ))
            base["thuoc"][cat] = items

        # merge chi_dinh_khac
        ck = {"thay_bang_cat_chi": [], "duong_mau_mao_mach": [], "vat_ly_tri_lieu": "", "che_do_an": "", "canh_bao": []}
        for x in lst:
            c = x.get("chi_dinh_khac") or {}
            ck["thay_bang_cat_chi"].extend(c.get("thay_bang_cat_chi", []) or [])
            ck["duong_mau_mao_mach"].extend(c.get("duong_mau_mao_mach", []) or [])
            if (not ck["vat_ly_tri_lieu"]) and str(c.get("vat_ly_tri_lieu", "")).strip():
                ck["vat_ly_tri_lieu"] = c.get("vat_ly_tri_lieu")
            if (not ck["che_do_an"]) and str(c.get("che_do_an", "")).strip():
                ck["che_do_an"] = c.get("che_do_an")
            ck["canh_bao"].extend(c.get("canh_bao", []) or [])
        ck["thay_bang_cat_chi"] = _dedup_dicts(ck["thay_bang_cat_chi"], lambda d: (str(d.get("ten","")).strip().lower(), str(d.get("gio","")).strip()))
        ck["duong_mau_mao_mach"] = _dedup_dicts(ck["duong_mau_mao_mach"], lambda d: (str(d.get("ten","")).strip().lower(), str(d.get("gio","")).strip()))
        ck["canh_bao"] = _dedup_preserve_order(ck["canh_bao"])
        base["chi_dinh_khac"] = ck
        # Sau khi gộp: tính lại chế độ ăn theo toàn bộ y lệnh gộp
        try:
            base["chi_dinh_khac"]["che_do_an"] = normalize_diet_care(base.get("nhap_cham_soc", {}).get("y_lenh", ""))
        except:
            pass

        # merge chi_dinh_dvkt
        dv = []
        for x in lst:
            dv.extend(x.get("chi_dinh_dvkt", []) or [])
        base["chi_dinh_dvkt"] = _dedup_dicts(dv, lambda d: (str(d.get("ten","")).strip().lower(), str(d.get("gio","")).strip()))

        base = cleanup_record_v12(base)
        base = attach_doctor_into_dich_truyen_hours(base)
        base["phan_loai_bn"] = phan_loai_benh_nhan(base)
        merged.append(base)

    return merged


