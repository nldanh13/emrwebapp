# -*- coding: utf-8 -*-
"""xu_ly.py — Điều phối xử lý phân loại thuốc / dịch truyền.

Các module con:
  xu_ly_config.py               — Hằng số, cấu hình, route labels
  xu_ly_merge.py                — Làm sạch và gộp records bệnh nhân
  processing/rule_engine.py     — Luật nhận dạng nhóm thuốc đọc từ config/order_rules.json
"""
import json
import re
import os
from datetime import datetime, timedelta
import glob
import unicodedata
from copy import deepcopy

from drug_normalizer import DRUG_NORMALIZER
from runtime_logging import get_worker_logger
from date_utils import normalize_dmy

try:
    from processing.rule_engine import detect_drug_category
except Exception:
    detect_drug_category = None

LOG = get_worker_logger('xu_ly')

# ── Import từ module con ──────────────────────────────────────────────────────
from xu_ly_config import (
    BASE_DIR, CONFIG_FILE, OUTPUT_FILE, DEFAULT_INPUT_FILE,
    DEFAULT_VOLUMES, TRUE_INFUSIONS, ALWAYS_INFUSION_DRUGS,
    INFUSION_NAME_KEYWORDS, DEFAULT_NACL_VOLUME_BY_KEYWORD,
    ROUTE_LABEL_MAP, ROUTE_COLORS, NO_WATER_TAG_KEYWORDS,
    THE_TICH_AO, LUAT_AN_TOAN, CONFIG,
    get_route_label, _norm_upper, _contains_any,
    parse_hours_from_gio_dung, get_safety_nacl_volume,
)
from xu_ly_merge import (
    _dedup_preserve_order, _dedup_dicts, _merge_multiline,
    cleanup_record_v12, phan_loai_benh_nhan,
    _hhmm_to_minutes, _extract_hhmm_any, _doctor_for_hhmm,
    attach_doctor_into_dich_truyen_hours,
    merge_records_by_patient_v12,
)

try:
    from clinical_rules import apply_clinical_rules_to_record, extract_care_special_events, extract_admission_transfer_events
except Exception:
    apply_clinical_rules_to_record = None
    extract_care_special_events = None
    extract_admission_transfer_events = None

# ── Parser/processor đã tách module ─────────────────────────────────────────────
from processing.diluent_resolver import infer_and_reclassify_diluents
from processing.order_context import (
    build_reserve_context_from_dien_bien,
    is_add_order_context,
    is_reserve_context_for_order,
    is_reserve_order_context,
    split_content_by_doctor,
)
from processing.medication_parser import (
    _has_oral_marker,
    categorize_drug,
    clean_text_for_entry,
    extract_infusion_rate,
    get_volume_from_config,
    parse_drug_name,
    update_drug_usage,
)
from processing.infusion_scheduler import calculate_infusion_times, clean_and_merge_injections
from processing.procedure_parser import extract_other_orders, extract_procedures_detailed
from processing.medication_catalog import complete_medication_from_catalog
from processing.order_events import build_raw_order_events

# ── Ngày làm việc mặc định ─────────────────────────────────────────────────────
def _today_dmy() -> str:
    return datetime.now().strftime("%d/%m/%Y")


def _coerce_work_date(raw_date=None, fallback=None) -> str:
    return normalize_dmy(raw_date, fallback=(fallback or _today_dmy()), default_year=datetime.now().year)

from processing.output_schema import make_patient_day_record

try:
    from vtyt_rules import build_required_supplies
except Exception:  # pragma: no cover
    build_required_supplies = None


def _complete_orphan_infusion_order(drug: dict) -> dict:
    """Hoàn thiện thuốc thiếu dòng đường dùng bằng medication_catalog.json.

    Không viết cứng từng thuốc trong code. Muốn thêm thuốc tương tự THERMODOL
    thì thêm vào config/medication_catalog.json và config/schedule_rules.json.
    """
    completed, _matched = complete_medication_from_catalog(drug, only_if_missing_usage=True)
    return completed


def _drug_hours_set(drug: dict) -> set:
    """Lấy tập giờ dùng từ một item thuốc/dịch truyền."""
    if not isinstance(drug, dict):
        return set()
    hours = []
    for key in ("gio_dung", "duong_dung_goc", "raw_usage_line", "raw_usage_part"):
        val = str(drug.get(key) or "")
        if val:
            hours.extend(parse_hours_from_gio_dung(val))
    out = set()
    for h in hours:
        try:
            out.add(int(str(h).strip()))
        except Exception:
            continue
    return out


# ==============================================================================
# Điều chỉnh y lệnh phát sinh sau y lệnh thuốc gốc: NGƯNG / CHUYỂN CỬ
# ==============================================================================

def _plain_order_text(value) -> str:
    text = str(value or "").strip().lower().replace("đ", "d")
    text = unicodedata.normalize("NFD", text)
    return "".join(ch for ch in text if unicodedata.category(ch) != "Mn")


def _med_name_plain(drug: dict) -> str:
    return _plain_order_text(" ".join([
        str((drug or {}).get("ten_thuoc") or ""),
        str((drug or {}).get("hoat_chat") or ""),
        str((drug or {}).get("ten_hien_thi") or ""),
        str((drug or {}).get("raw_text") or ""),
    ]))


def _med_matches_order_name(drug: dict, raw_name: str) -> bool:
    needle = _plain_order_text(raw_name)
    needle = re.sub(r"\b(?:thuoc|y lenh|cu)\b.*$", "", needle).strip(" ,;:-")
    if not needle:
        return False
    hay = _med_name_plain(drug)
    if needle in hay:
        return True

    # Alias hẹp, dựa trên dữ liệu thực tế của khoa.
    aliases = {
        "foximcz": ("foximcz", "cefoxitin"),
        "paracetamol": ("paracetamol", "thermodol"),
        "metronidazol": ("metronidazol", "metronidazole"),
        "beroxib": ("beroxib", "celecoxib"),
        "trasolu": ("trasolu", "tramadol"),
    }
    for key, vals in aliases.items():
        if key in needle:
            return any(v in hay for v in vals)
    return False


def _hour_from_med(drug: dict):
    # Ưu tiên gio_dung vì đây là cử y lệnh, không phải giờ bị scheduler đẩy nối tiếp.
    hours = []
    try:
        hours = [int(x) for x in parse_hours_from_gio_dung((drug or {}).get("gio_dung", ""))]
    except Exception:
        hours = []
    if hours:
        return hours

    raw = str((drug or {}).get("tg_bat_dau") or "")
    m = re.match(r"\s*(\d{1,2}):(\d{2})", raw)
    if m:
        try:
            return [int(m.group(1))]
        except Exception:
            pass
    return []


def _session_predicate(session_text: str):
    s = _plain_order_text(session_text)
    # "chiều tối" / "chiều và tối": tất cả cử từ chiều trở đi.
    if ("chieu" in s) and ("toi" in s):
        return lambda h: int(h) >= 14
    if "sang" in s:
        return lambda h: 5 <= int(h) < 12
    if "trua" in s:
        return lambda h: 11 <= int(h) < 15
    if "chieu" in s:
        return lambda h: 14 <= int(h) < 19
    if "toi" in s or "dem" in s:
        return lambda h: int(h) >= 19 or int(h) < 5

    explicit = []
    for m in re.finditer(r"\b([01]?\d|2[0-3])\s*(?:h|gio)\b", s):
        try:
            explicit.append(int(m.group(1)))
        except Exception:
            pass
    if explicit:
        wanted = set(explicit)
        return lambda h: int(h) in wanted

    return None


def _format_hours(hours) -> str:
    vals = []
    for h in hours:
        try:
            hi = int(h)
        except Exception:
            continue
        if hi not in vals:
            vals.append(hi)
    return ", ".join(f"{h} giờ" for h in vals)


def _clone_stopped_med(drug: dict, category: str, stopped_hours, reason: str) -> dict:
    item = deepcopy(drug or {})
    item["category"] = category
    if stopped_hours:
        item["gio_dung"] = _format_hours(stopped_hours)
        # Cleanup dịch truyền cần đúng giờ cũ. Không giữ tg_bat_dau của một cử khác.
        if len(stopped_hours) != 1:
            item.pop("tg_bat_dau", None)
            item.pop("tg_ket_thuc", None)
    item["reason"] = reason
    item["order_adjustment"] = "stopped"
    return item


def _trim_med_hours(drug: dict, stop_pred, category: str, reason: str):
    """Trả (drug còn lại|None, các bản bị ngưng).

    Với thuốc có nhiều cử trong một dict (đặc biệt thuoc_tiem), chỉ bỏ đúng cử
    bị ngưng thay vì xóa cả thuốc.
    """
    item = deepcopy(drug or {})
    hours = _hour_from_med(item)
    if not hours:
        return item, []

    stopped = [h for h in hours if stop_pred(h)]
    if not stopped:
        return item, []
    kept = [h for h in hours if h not in stopped]
    skipped = [_clone_stopped_med(item, category, stopped, reason)]

    if not kept:
        return None, skipped

    item["gio_dung"] = _format_hours(kept)
    dose_map = item.get("so_luong_moi_gio")
    if isinstance(dose_map, dict):
        item["so_luong_moi_gio"] = {
            k: v for k, v in dose_map.items()
            if str(k).strip().isdigit() and int(str(k).strip()) in set(kept)
        }

    # Nếu đây là item đã schedule theo 1 cử mà cử đó bị bỏ thì nhánh kept đã rỗng.
    # Item nhiều cử thường chưa có tg_bat_dau; nếu có, xóa để tránh giờ cũ gây hiểu sai.
    if len(hours) > 1:
        item.pop("tg_bat_dau", None)
        item.pop("tg_ket_thuc", None)

    return item, skipped


def _parse_order_adjustment_lines(record: dict):
    lines = []
    yk = (record or {}).get("y_lenh_khac") or {}
    for x in (yk.get("khac") or []):
        s = str(x or "").strip()
        if s:
            lines.append(s)

    # Fallback từ y lệnh đã gộp, phòng trường hợp extractor y_lenh_khac bỏ sót.
    raw = str(((record or {}).get("nhap_cham_soc") or {}).get("y_lenh") or "")
    for line in raw.splitlines():
        s = line.strip()
        plain = _plain_order_text(s)
        if ("ngung y lenh" in plain) or ("chuyen y lenh" in plain):
            lines.append(s)

    out = []
    seen = set()
    for s in lines:
        key = _plain_order_text(s)
        if key and key not in seen:
            seen.add(key)
            out.append(s)
    return out


def _parse_stop_directives(line: str):
    plain = _plain_order_text(line)
    m = re.search(r"\bngung\s+y\s+lenh\s+(.+)$", plain)
    if not m:
        return []

    body = m.group(1).strip(" .")
    # Dạng tổng quát: "Ngưng y lệnh thuốc tiêm truyền cử chiều tối".
    if re.search(r"^thuoc\s+tiem\s+truyen\b", body):
        sess = body.split("cu", 1)[1].strip() if "cu" in body else ""
        return [{"scope": "injectable", "name": "", "session": sess or "all"}]

    directives = []
    for part in re.split(r"\s*,\s*", body):
        part = part.strip(" .")
        if not part:
            continue
        mm = re.match(r"(.+?)\s+cu\s+(.+)$", part)
        if mm:
            directives.append({
                "scope": "name",
                "name": mm.group(1).strip(),
                "session": mm.group(2).strip(),
            })
        else:
            # "Ngưng y lệnh Beroxib" => ngưng toàn bộ thuốc đó.
            directives.append({"scope": "name", "name": part, "session": "all"})
    return directives


def _parse_move_directive(line: str):
    plain = _plain_order_text(line)
    m = re.search(
        r"\bchuyen\s+y\s+lenh\s+(.+?)\s+cu\s+([01]?\d|2[0-3])\s*(?:h|gio)?\s+sang\s+([01]?\d|2[0-3])\s*(?:h|gio)?\b",
        plain,
    )
    if not m:
        return None
    return {
        "name": m.group(1).strip(),
        "from_hour": int(m.group(2)),
        "to_hour": int(m.group(3)),
    }


def _parse_dt_hhmm_dmy(value):
    raw = str(value or "").strip()
    for fmt in ("%H:%M %d/%m/%Y", "%H:%M %d-%m-%Y"):
        try:
            return datetime.strptime(raw, fmt)
        except Exception:
            pass
    return None


def _duration_for_infusion(drug: dict) -> int:
    try:
        n = int(float((drug or {}).get("thoi_gian_chay_phut") or 0))
        if n > 0:
            return n
    except Exception:
        pass

    st = _parse_dt_hhmm_dmy((drug or {}).get("tg_bat_dau"))
    en = _parse_dt_hhmm_dmy((drug or {}).get("tg_ket_thuc"))
    if st and en and en > st:
        return max(1, int((en - st).total_seconds() // 60))

    try:
        vol = float((drug or {}).get("the_tich") or 0)
        rate = float(re.search(r"\d+(?:\.\d+)?", str((drug or {}).get("toc_do") or "")).group())
        if vol > 0 and rate > 0:
            return max(1, int((vol * 20) / rate))
    except Exception:
        pass
    return 0


def _reflow_infusion_schedule(record: dict):
    """Xếp lại các item dịch truyền đã có tg_bat_dau sau khi ngưng/chuyển cử.

    Scheduler ban đầu xếp nối tiếp các thuốc cùng cử. Nếu chuyển Paracetamol 8h
    sang 5h, thuốc từng bị đẩy từ 08:00 -> 08:20 phải trở lại 08:00.
    """
    meds = (((record or {}).get("thuoc") or {}).get("dich_truyen") or [])
    if not meds:
        return

    work_date = str((record or {}).get("ngay_lam") or "").strip()
    try:
        base_date = datetime.strptime(work_date, "%d/%m/%Y")
    except Exception:
        base_date = None

    groups = {}
    untouched = []
    for idx, med in enumerate(meds):
        hours = _hour_from_med(med)
        if len(hours) != 1 or not base_date:
            untouched.append((idx, med))
            continue
        h = int(hours[0])
        same_day = bool(med.get("_order_move_same_day"))
        day = base_date if (h >= 6 or same_day) else (base_date + timedelta(days=1))
        groups.setdefault((day.date(), h), []).append((idx, med))

    for (_day, h), items in groups.items():
        # Giữ thứ tự scheduler cũ khi có thể.
        items.sort(key=lambda x: (
            _parse_dt_hhmm_dmy(x[1].get("tg_bat_dau")) or datetime.max,
            x[0],
        ))
        day_dt = datetime.combine(_day, datetime.min.time())
        cursor = day_dt.replace(hour=h, minute=0)
        for _idx, med in items:
            duration = _duration_for_infusion(med)
            med["tg_bat_dau"] = cursor.strftime("%H:%M %d/%m/%Y")
            if duration > 0:
                med["thoi_gian_chay_phut"] = duration
                cursor = cursor + timedelta(minutes=duration)
                med["tg_ket_thuc"] = cursor.strftime("%H:%M %d/%m/%Y")
            else:
                med.pop("tg_ket_thuc", None)
            med.pop("_order_move_same_day", None)

    meds.sort(key=lambda m: (
        _parse_dt_hhmm_dmy(m.get("tg_bat_dau")) or datetime.max,
        _plain_order_text(m.get("ten_thuoc") or ""),
    ))



def _normalize_final_infusion_operational_volumes(record: dict) -> dict:
    """Final guard sau merge cho thể tích vận hành dịch truyền.

    Trường hợp thực tế đã gặp:
      TRASOLU (Tramadol HCl) 100mg/2ml + "Pha NaCl TTM ..."
    parser nhận đúng TTM + NACL nhưng record sau merge vẫn có the_tich=2ml
    (thể tích ống thuốc). 2ml không phải thể tích dịch truyền.

    Chỉ sửa phạm vi hẹp:
    - đúng Tramadol/Trasolu;
    - đang nằm trong dich_truyen;
    - có chỉ dấu NaCl/TTM rõ;
    - thể tích hiện tại nhỏ hơn 50ml.
    """
    if not isinstance(record, dict):
        return record

    meds = (((record.get("thuoc") or {}).get("dich_truyen")) or [])
    changed = False

    for med in meds:
        if not isinstance(med, dict):
            continue

        name_blob = _norm_upper(" ".join([
            str(med.get("ten_thuoc") or ""),
            str(med.get("hoat_chat") or ""),
            str(med.get("ten_hien_thi") or ""),
            str(med.get("raw_text") or ""),
        ]))
        if ("TRAMADOL" not in name_blob) and ("TRASOLU" not in name_blob):
            continue

        route_blob = _norm_upper(" ".join([
            str(med.get("duong_dung") or ""),
            str(med.get("duong_dung_goc") or ""),
            str(med.get("raw_usage_line") or ""),
            str(med.get("raw_usage_part") or ""),
        ]))
        dm = str(med.get("dung_moi") or "").upper().strip()
        has_nacl = (
            dm in {"NACL_0.9", "SODIUM_0.9"}
            or any(k in route_blob for k in (
                "NACL", "NATRI CLORID", "NATRI CHLORID",
                "SODIUM CHLORIDE", "NUOC MUOI", "NƯỚC MUỐI",
            ))
        )
        has_infusion = any(k in route_blob for k in (
            "TTM", "TTTM", "TRUYEN", "TRUYỀN", "GIOT/PHUT", "GIỌT/PHÚT",
        )) or str(med.get("duong_dung") or "").upper().strip() == "TTM"

        if not (has_nacl and has_infusion):
            continue

        try:
            current_vol = float(med.get("the_tich") or 0)
        except Exception:
            current_vol = 0.0

        # Nếu đã >=50ml thì đó đã là thể tích truyền, không can thiệp.
        if current_vol >= 50:
            continue

        # Ưu tiên túi/lượng pha đã parse được; nếu chưa có thì 100ml.
        bag = 0.0
        for key in ("the_tich_lay_ml", "the_tich_pha_du_ml", "tui_dich_truyen_ml"):
            try:
                v = float(med.get(key) or 0)
            except Exception:
                v = 0.0
            if v >= 50:
                bag = v
                break
        if bag < 50:
            # Trong dữ liệu khoa, TRASOLU/Tramadol pha NaCl dùng túi 100ml.
            # Đây cũng là giá trị mà pipeline hiện đã tạo đúng ở các record tương tự.
            bag = 100.0

        if current_vol > 0:
            med["the_tich_thuoc_goc_ml"] = current_vol
        med["the_tich"] = float(bag)
        med["tui_dich_truyen_ml"] = float(bag)
        med["dung_moi"] = dm if dm in {"NACL_0.9", "SODIUM_0.9"} else "NACL_0.9"
        med["duong_dung"] = "TTM"
        med["volume_normalized_final"] = True
        med["volume_normalized_reason"] = "Tramadol/Trasolu pha NaCl: dùng thể tích túi truyền, không dùng 2ml của ống thuốc."
        changed = True

    if changed:
        # Tính lại tg_bat_dau/tg_ket_thuc và xếp lại các dịch cùng cử.
        _reflow_infusion_schedule(record)

    return record


def _recompute_medication_hours(record: dict):
    hours = set()
    thuoc = (record or {}).get("thuoc") or {}
    for category, items in thuoc.items():
        if not isinstance(items, list):
            continue
        for med in items:
            if not isinstance(med, dict):
                continue
            for h in _hour_from_med(med):
                try:
                    hours.add(int(h))
                except Exception:
                    pass
    record["tong_hop_gio_dung"] = sorted(hours)


def _apply_order_execution_adjustments(record: dict) -> dict:
    """Áp dụng y lệnh ngưng/chuyển cử sau khi đã merge toàn bộ patient-day."""
    if not isinstance(record, dict):
        return record

    lines = _parse_order_adjustment_lines(record)
    if not lines:
        return record

    thuoc = record.setdefault("thuoc", {})
    rule_log = record.setdefault("rule_log", {})
    skipped_log = rule_log.setdefault("skipped_medications", [])
    adjustment_log = rule_log.setdefault("order_adjustments", [])

    changed = False

    # 1) NGƯNG Y LỆNH
    for line in lines:
        directives = _parse_stop_directives(line)
        for d in directives:
            sess = d.get("session") or "all"
            stop_pred = None if sess == "all" else _session_predicate(sess)
            reason = f"Ngưng theo y lệnh sau: {line}"

            categories = ["dich_truyen", "thuoc_tiem"] if d.get("scope") == "injectable" else [
                "dich_truyen", "thuoc_tiem", "thuoc_uong",
                "thuoc_hit_xit", "thuoc_boi", "thuoc_nho", "thuoc_dat", "khac",
            ]

            for category in categories:
                items = thuoc.get(category) or []
                if not isinstance(items, list):
                    continue
                new_items = []
                for med in items:
                    if not isinstance(med, dict):
                        new_items.append(med)
                        continue

                    if d.get("scope") == "name" and not _med_matches_order_name(med, d.get("name") or ""):
                        new_items.append(med)
                        continue

                    if sess == "all":
                        skipped_log.append(_clone_stopped_med(med, category, _hour_from_med(med), reason))
                        changed = True
                        continue

                    if stop_pred is None:
                        new_items.append(med)
                        continue

                    kept_med, stopped = _trim_med_hours(med, stop_pred, category, reason)
                    if stopped:
                        skipped_log.extend(stopped)
                        adjustment_log.append({
                            "action": "stop",
                            "category": category,
                            "drug": med.get("ten_thuoc") or med.get("ten_hien_thi") or "",
                            "instruction": line,
                            "stopped_hours": sorted({
                                h for sk in stopped for h in _hour_from_med(sk)
                            }),
                        })
                        changed = True
                    if kept_med is not None:
                        new_items.append(kept_med)
                thuoc[category] = new_items

    # 2) CHUYỂN CỬ
    for line in lines:
        move = _parse_move_directive(line)
        if not move:
            continue
        src = int(move["from_hour"])
        dst = int(move["to_hour"])
        for category, items in list(thuoc.items()):
            if not isinstance(items, list):
                continue
            for med in items:
                if not isinstance(med, dict) or not _med_matches_order_name(med, move["name"]):
                    continue
                hours = _hour_from_med(med)
                if src not in hours:
                    continue

                new_hours = [dst if h == src else h for h in hours]
                # Giữ thứ tự và bỏ trùng.
                uniq = []
                for h in new_hours:
                    if h not in uniq:
                        uniq.append(h)
                med["gio_dung"] = _format_hours(uniq)

                dose_map = med.get("so_luong_moi_gio")
                if isinstance(dose_map, dict):
                    new_map = {}
                    for k, v in dose_map.items():
                        try:
                            hi = int(str(k).strip())
                        except Exception:
                            continue
                        new_map[str(dst if hi == src else hi)] = v
                    med["so_luong_moi_gio"] = new_map

                # Cử chuyển sang 0-5h là giờ CÙNG NGÀY theo y lệnh chỉnh cử,
                # không phải bridge 0-5h của ngày hôm sau.
                if category == "dich_truyen" and len(hours) == 1:
                    med["_order_move_same_day"] = True

                adjustment_log.append({
                    "action": "move",
                    "category": category,
                    "drug": med.get("ten_thuoc") or med.get("ten_hien_thi") or "",
                    "instruction": line,
                    "from_hour": src,
                    "to_hour": dst,
                })
                changed = True

    if changed:
        _reflow_infusion_schedule(record)
        _recompute_medication_hours(record)

    return record


def _is_sodium_solution(drug: dict) -> bool:
    # Không dùng ten_hien_thi ở đây vì thuốc chính đã gắn dung môi thường hiển thị
    # dạng "VANCOMYCIN ... + Sodium chloride 0.9%"; đó không phải NaCl standalone.
    blob = _norm_upper(" ".join([
        str(drug.get("ten_thuoc") or ""),
        str(drug.get("hoat_chat") or ""),
        str(drug.get("raw_text") or ""),
    ]))
    if any(k in blob for k in ["VANCOMYCIN", "MEROPENEM", "MEROVIA", "CEF", "CEFTAZIDIME", "NEFOPAM", "TRAMADOL"]):
        return False
    return any(k in blob for k in [
        "SODIUM CHLORIDE", "NATRI CLORID", "NATRI CHLORID", "NACL", "NATRI CLORUA"
    ])


def _uses_sodium_as_diluent(drug: dict) -> bool:
    if not isinstance(drug, dict) or _is_sodium_solution(drug):
        return False
    if str(drug.get("dung_moi") or "").upper() in {"NACL_0.9", "SODIUM_0.9"}:
        return True
    blob = _norm_upper(" ".join([
        str(drug.get("duong_dung_goc") or ""),
        str(drug.get("raw_usage_line") or ""),
        str(drug.get("raw_usage_part") or ""),
    ]))
    return any(k in blob for k in ["NATRI CLORID", "NATRI CHLORID", "SODIUM CHLORIDE", "NACL"])


def _looks_like_diluent_only_sodium(drug: dict) -> bool:
    """Nhận diện NaCl chỉ dùng để pha/lấy dung môi, không phải chai dịch truyền độc lập.

    Ví dụ ca Nguyễn Thị Ngọc Duyên:
    - VANCOMYCIN: "Pha 200ml natriclorid X2 TTM ... (8 giờ, 20 giờ)"
    - SODIUM CHLORIDE: "Lấy 200ml X2 TTM ... (8 giờ, 20 giờ)"

    Nếu để NaCl đứng như dịch truyền riêng, scheduler sẽ xếp NaCl chạy trước rồi
    đẩy Vancomycin xuống sau, gây tính đôi và sai giờ bắt đầu.
    """
    if not isinstance(drug, dict) or not _is_sodium_solution(drug):
        return False
    blob = _norm_upper(" ".join([
        str(drug.get("duong_dung_goc") or ""),
        str(drug.get("raw_usage_line") or ""),
        str(drug.get("raw_usage_part") or ""),
    ]))
    if drug.get("the_tich_lay_ml"):
        return True
    return bool(re.search(r"\b(LAY|LẤY)\b", blob)) and not any(k in blob for k in ["BU DICH", "BÙ DỊCH", "DUY TRI", "DUY TRÌ"])


def _drop_sodium_diluent_duplicates(raw_dich_truyen: list) -> list:
    """Bỏ NaCl standalone khi cùng giờ đã được gắn làm dung môi cho thuốc truyền.

    Chỉ bỏ khi có item thuốc không phải NaCl dùng NaCl/Sodium làm dung môi và
    giờ dùng giao nhau. Nhờ vậy các y lệnh truyền NaCl độc lập vẫn được giữ.
    """
    if not raw_dich_truyen:
        return raw_dich_truyen

    diluent_hours = set()
    for drug in raw_dich_truyen:
        if _uses_sodium_as_diluent(drug):
            diluent_hours.update(_drug_hours_set(drug))

    if not diluent_hours:
        return raw_dich_truyen

    kept = []
    for drug in raw_dich_truyen:
        if _looks_like_diluent_only_sodium(drug) and (_drug_hours_set(drug) & diluent_hours):
            LOG.info("Bỏ NaCl/Sodium standalone vì đã là dung môi cùng giờ: %s | giờ=%s", drug.get("ten_thuoc"), sorted(_drug_hours_set(drug)))
            continue
        kept.append(drug)
    return kept

# ==============================================================================
# Builder chính: gom từng người bệnh/ngày từ KetQua_YLenh.json
# ==============================================================================

def build_patient_day_records(data):
    # Lấy ngày từ file gốc: dict có key trực tiếp, list lấy từ phần tử đầu tiên
    # (KetQua_YLenh.json từ pipeline là list record, không phải dict)
    nam_hien_tai = datetime.now().year
    if isinstance(data, list):
        ngay_goc = (data[0].get("ngay_lam") if data and isinstance(data[0], dict) else None) \
                   or datetime.now().strftime("%d-%m")
    else:
        ngay_goc = data.get("ngay_lam", datetime.now().strftime("%d-%m"))

    # Chuẩn hoá ngày làm việc về dd/mm/YYYY để truyền vào từng hàm xử lý.
    ngay_norm = str(ngay_goc).strip()

    m_full = re.match(r'^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$', ngay_norm)   # dd/mm/yyyy hoặc dd-mm-yyyy
    m_short = re.match(r'^(\d{1,2})[/-](\d{1,2})$', ngay_norm)             # dd/mm hoặc dd-mm

    if m_full:
        d = int(m_full.group(1)); mo = int(m_full.group(2)); y = m_full.group(3)
        NGAY_CHINH_THUC = f"{d:02d}/{mo:02d}/{y}"
    elif m_short:
        d = int(m_short.group(1)); mo = int(m_short.group(2))
        NGAY_CHINH_THUC = f"{d:02d}/{mo:02d}/{nam_hien_tai}"
    else:
        # fallback: thử vài định dạng phổ biến, không được thì lấy ngày hiện tại
        dt = None
        for fmt in ("%d-%m-%Y", "%d/%m/%Y", "%d/%m/%y", "%d-%m-%y"):
            try:
                dt = datetime.strptime(ngay_norm, fmt)
                break
            except Exception as exc:
                LOG.debug("Handled xu_ly fallback exception", exc_info=True)
                pass
        if dt is None:
            dt = datetime.now()
        NGAY_CHINH_THUC = dt.strftime("%d/%m/%Y")
    # Ngày làm việc được truyền tường minh vào từng hàm xử lý bên dưới.

    def _normalize_ngay_lam(raw_date, fallback_date=NGAY_CHINH_THUC):
        """Chuẩn hóa ngày làm về dd/mm/YYYY cho từng record."""
        return normalize_dmy(raw_date, fallback=fallback_date, default_year=nam_hien_tai)

    patient_list = []
    if isinstance(data, list): patient_list = data
    elif isinstance(data, dict):
        for key in ["danh_sach", "data", "benh_nhan"]:
            if key in data and isinstance(data[key], list): patient_list = data[key]; break
        if not patient_list: 
             for v in data.values():
                 if isinstance(v, list): patient_list = v; break

    time_map = CONFIG.get('gio_mac_dinh', {})
    FINAL_DATA = []

    for p in patient_list:
        raw_db = p.get('Diễn biến', '')
        raw_yl = p.get('Y lệnh', '')

        # Mỗi record trong KetQua_YLenh.json có thể là một ngày khác nhau.
        # Phải lấy ngày theo từng record, không dùng chung ngày của phần tử đầu tiên.
        ngay_record = _normalize_ngay_lam(
            p.get('ngay_lam') or p.get('Ngày làm') or p.get('ngay') or p.get('date'),
            NGAY_CHINH_THUC,
        )

        # Tách hồ sơ theo Bác sĩ
        default_doc_name = (p.get('Bác sĩ') or p.get('bac_si') or 'Không rõ')
        split_yl = split_content_by_doctor(raw_yl, default_doc_name=default_doc_name)

        # Chữ "Dự trù thuốc" thường nằm bên ô Diễn biến, cùng giờ với ô Y lệnh.
        # Tạo lookup theo giờ/bác sĩ để không gán nhầm tất cả y lệnh sau đó là thuốc thêm.
        reserve_lookup = build_reserve_context_from_dien_bien(raw_db, default_doc_name=default_doc_name)
        
        for doc_name, doc_content, order_header_time in split_yl:
            new_p = make_patient_day_record(
                p,
                ngay_lam=ngay_record,
                raw_dien_bien=raw_db,
                raw_y_lenh=raw_yl,
                doc_name=doc_name,
                doc_content=doc_content,
                order_header_time=order_header_time,
                clean_text_for_entry=clean_text_for_entry,
                extract_care_special_events=extract_care_special_events,
                extract_admission_transfer_events=extract_admission_transfer_events,
            )
            new_p["raw_order_events"] = build_raw_order_events(
                doc_content,
                doc_name=doc_name,
                order_header_time=order_header_time,
                ngay_lam=ngay_record,
            )
            new_p.setdefault("unparsed_orders", [])
            new_p.setdefault("processing_warnings", [])

            lines = doc_content.split('\n')
            is_reserve_context = is_reserve_context_for_order(
                doc_content,
                doc_name=doc_name,
                header_time=order_header_time,
                reserve_lookup=reserve_lookup,
            )
            # Thuốc thêm thật sự phải có dấu hiệu "Thêm:"/"thêm thuốc" trong block,
            # và không được là block dự trù. Không suy luận chỉ bằng giờ sau 07:00.
            is_add_context = (not is_reserve_context) and is_add_order_context(doc_content)
            current_drug = None
            raw_dich_truyen = []
            raw_thuoc_tiem = []
            all_hours = set()

            def _is_drug_line(s: str) -> bool:
                if not s:
                    return False
                ss = s.strip()
                if not ss:
                    return False

                low = ss.lower()

                # Dòng bắt đầu bằng "Pha ..." có thể chứa "x2" nên regex tên thuốc
                # bên dưới rất dễ nhận nhầm thành một thuốc mới. Khi dòng này mang
                # dấu hiệu dung môi/đường truyền thì đây là HƯỚNG DẪN của thuốc đang
                # chờ (ví dụ VANCOMYCIN -> "Pha natriclorid 0.9% 100ml x2 TTM...").
                # Không áp dụng cho tên thuốc/dung môi thật có dạng đóng gói ở cuối dòng.
                if re.match(r'^\s*pha\b', low) and any(k in low for k in [
                    'nacl', 'natri clorid', 'natri chlorid', 'natri chloride',
                    'sodium chloride', 'nước muối', 'nuoc muoi',
                    'ttm', 'truyền', 'truyen', 'g/p', 'giọt', 'giot', 'ml/h', 'ml/giờ', 'ml/gio'
                ]) and not re.search(r'\([^)]*(ống|lọ|viên|chai|túi|gói)[^)]*\)\s*$', low):
                    return False

                # 0) Tránh nhầm dòng LIỀU/DÙNG bắt đầu bằng số lượng (ví dụ: '01 x 2 (truyền tĩnh mạch)...')
                #    Đây là dòng hướng dẫn, không phải tên thuốc mới.
                if re.match(r'^\s*\d+\s*x\s*\d+\b', low) and any(k in low for k in [
                    'tiêm','uống','truyền','pha','bơm','ttm','tm','tĩnh mạch','mạch','g/p','giọt','ml/h','ml/giờ'
                ]):
                    return False

                # Tránh nhầm dòng định lượng tiếp theo (ví dụ: '02 lọ x 2 (tiêm mạch chậm)(8 giờ, 20 giờ).') thành một thuốc mới
                if re.match(r'^\d+\s*(lọ|ống|viên|chai|túi|gói|nhát|nhat|lần\s*xịt|lan\s*xit)\b', low) and any(k in low for k in [
                    'tiêm','uống','truyền','pha','bơm','ttm','tm','tĩnh mạch','mạch','g/p','giọt','ml/h','ml/giờ',
                    'hít','hit','xịt','xit','khí dung','khi dung','sáng','sang','tối','toi'
                ]):
                    return False
                if any(t in low for t in ["+ y lệnh", "+ thuốc", "chỉ định dvkt"]):
                    return False

                # Có 'x <số/chữ số>' nhưng phải có chữ (tên thuốc) ở trước, tránh bắt nhầm '01 x 2 ...'
                qty_word = r'(?:\d+(?:[\.,]\d+)?|\d+\s*/\s*\d+|một|mot|hai|ba|bốn|bon|tư|tu|năm|nam|sáu|sau|bảy|bay|tám|tam|chín|chin|mười|muoi)'
                if re.search(r'[A-Za-zÀ-ỹ].*\s+x\s*' + qty_word + r'\b', ss, flags=re.IGNORECASE):
                    return True
                if re.search(r'[A-Za-zÀ-ỹ].*\b\d+\s*vx\s*\d+\b', ss, flags=re.IGNORECASE):
                    return True
                if re.search(r'[A-Za-zÀ-ỹ].*\b\d+\s*[xX]\s*\d+\s*(viên|ống|lọ|chai|túi|gói)\b', ss, flags=re.IGNORECASE):
                    return True
                if re.search(
                    r'[A-Za-zÀ-ỹ].*\b\d+\s*(viên|ống|lọ|chai|túi|gói)\b.*(?:\(\s*(?:tdd|tb|tmc|ttm|u|pkd)\s*\)|\b(?:tdd|tmc|ttm|tiêm|tiem|uống|uong|dưới\s*da|duoi\s*da|hít|hit|xịt|xit)\b)',
                    ss,
                    flags=re.IGNORECASE,
                ):
                    return True

                if re.search(r'\([^)]*(ống|lọ|viên|chai|túi)[^)]*\)\s*$', low):
                    return True

                if ss.isupper() and len(ss) > 3:
                    return True

                return False

            def _split_drug_and_usage(s: str):
                low = s.lower()
                # "NƯỚC CẤT PHA TIÊM" là tên dung môi, không được tách chữ "tiêm" thành đường dùng.
                if ("nước cất" in low) or ("nuoc cat" in low) or ("water for injection" in low):
                    return s.strip(), ""

                # Tách cả các ký hiệu đường uống/đường dùng nằm chung trên dòng tên thuốc.
                # Ví dụ: "PHARBACOL ... (Viên) (u) 8h-16h-22h" trước đây không tách được
                # nên bị catalog suy luận nhầm thành paracetamol truyền.
                route_patterns = [
                    r'\(\s*u\s*\)', r'\buống\b', r'\buong\b',
                    r'(?<![0-9a-zA-ZÀ-ỹ])u(?![0-9a-zA-ZÀ-ỹ])',
                    r'\(\s*ttm\s*\)', r'\bttm\b',
                    r'\btĩnh\s*mạch\s*chậm\b', r'\btm\s*chậm\b', r'\btmc\b',
                    r'\(\s*tdd\s*\)', r'\btdd\b', r'\(\s*pkd\s*\)', r'\bpkd\b',
                    r'\btiêm\s*dưới\s*da\b', r'\btiem\s*duoi\s*da\b',
                    r'\btiêm\b', r'\btiem\b', r'\btruyền\b', r'\btruyen\b',
                    r'\bpha\b', r'\bbơm\b', r'\bbom\b',
                    r'\bhít\b', r'\bhit\b', r'\bxịt\b', r'\bxit\b', r'\bkhí\s*dung\b', r'\bkhi\s*dung\b',
                ]
                best = None
                for pat in route_patterns:
                    m = re.search(pat, s, re.IGNORECASE)
                    if m and m.start() > 0 and (best is None or m.start() < best.start()):
                        best = m
                if best:
                    drug_part = s[:best.start()].strip()
                    usage_part = s[best.start():].strip()
                    usage_part = re.sub(r'^\(\s*u\s*\)', 'Uống', usage_part, flags=re.IGNORECASE)
                    usage_part = re.sub(r'^(?<![0-9a-zA-ZÀ-ỹ])u(?![0-9a-zA-ZÀ-ỹ])', 'Uống', usage_part, flags=re.IGNORECASE)
                    usage_part = re.sub(r'\(\s*ttm\s*\)', 'TTM', usage_part, flags=re.IGNORECASE)
                    usage_part = re.sub(r'\(\s*tdd\s*\)', 'Tiêm dưới da', usage_part, flags=re.IGNORECASE)
                    usage_part = re.sub(r'^(?<![0-9a-zA-ZÀ-ỹ])tdd(?![0-9a-zA-ZÀ-ỹ])', 'Tiêm dưới da', usage_part, flags=re.IGNORECASE)
                    usage_part = re.sub(r'\(\s*pkd\s*\)', 'PKD', usage_part, flags=re.IGNORECASE)
                    return drug_part, usage_part

                return s.strip(), ""

            def _is_usage_line(s: str) -> bool:
                if not s:
                    return False
                low = s.lower()
                # Ký hiệu "(u)" / "u" phải được xem là dòng đường dùng, không phải tên thuốc.
                if _has_oral_marker(s):
                    return True
                return any(k in low for k in [
                    "tiêm", "tiem", "uống", "uong", "truyền", "truyen", "pha", "bơm", "bom", "ttm",
                    "g/p", "giọt", "giot", "ml/h", "ml/giờ", "ml/gio",
                    "nước cất", "nuoc cat", "nước muối", "nuoc muoi", "natri clorid", "sodium", "nacl",
                    "tĩnh mạch chậm", "tinh mach cham", "tm chậm", "tm cham", "tmc", "bắp", "bap", "tb",
                    "dưới da", "duoi da", "tdd", "pkd", "lấy", "lay", "pha đủ", "pha du",
                    "hít", "hit", "xịt", "xit", "khí dung", "khi dung", "nhát", "nhat",
                    "sáng", "sang", "trưa", "trua", "chiều", "chieu", "tối", "toi", "đêm", "dem",
                    # NaCl dùng để thông/tráng đường truyền: đây là hướng dẫn của dòng NaCl,
                    # không phải tên thuốc mới. medication_parser sẽ gắn cờ flush_only để
                    # loại khỏi danh sách dịch truyền cần nhập.
                    "thông tráng", "thong trang", "tráng ống", "trang ong", "rửa ống", "rua ong"
                ])

            def _match_self_paid_prefix(s: str):
                """Nhận diện marker (TT)/(CS), kể cả lỗi OCR/clipboard như "(TT0 ...".

                Không bắt "(TTM)" vì TTM là đường truyền, không phải marker tự túc.
                """
                return re.match(r'^\(+\s*(TT|CS)(?:\s*\)|[0Oo]\)?|\s+)\s*', str(s or ''), re.IGNORECASE)

            def _normalize_self_paid_line_body(s: str) -> str:
                t = re.sub(r'\s+', ' ', str(s or '').strip())
                t = re.sub(r'(?i)\b(\d+)\s*vx\s*(\d+)\s*u\b', r'\1 viên x \2 u', t)
                t = re.sub(r'(?i)\b(\d+)vx(\d+)u\b', r'\1 viên x \2 u', t)
                t = re.sub(r'(?i)\b(\d+)\s*vx\s*(\d+)\b', r'\1 viên x \2', t)
                t = re.sub(r'(?i)\b(\d+)vx(\d+)\b', r'\1 viên x \2', t)
                t = re.sub(r'(?i)\b(\d+)\s*v\b', r'\1 viên', t)
                t = re.sub(r'(?i)\b(\d+)v(?=\s|$)', r'\1 viên', t)
                t = re.sub(r'(?i)\b(\d+)\s*[xX]\s*(\d+)\s*(viên|ống|lọ|chai|túi|gói)\b', r'\1 \3 x \2', t)
                t = re.sub(r'(?i)\b(\d+)\s*(viên|ống|lọ|chai|túi|gói)\s*x(?=\d)', r'\1 \2 x ', t)
                t = re.sub(r'(?i)\bg\s*/\s*ph\b', 'g/p', t)
                return t.strip()

            def _split_self_paid_drug_and_usage(s: str):
                text = _normalize_self_paid_line_body(s)
                patterns = [
                    r'\bpha\b',
                    r'\b\d+\s*(?:nhát|nhat|lần\s*xịt|lan\s*xit|xịt|xit)\b',
                    r'\(\s*ttm\s*\)', r'\bttm\b',
                    r'\btĩnh\s*mạch\s*chậm\b', r'\btm\s*chậm\b', r'\btiêm\s*mạch\s*chậm\b',
                    r'\btruyền\s*tĩnh\s*mạch\b', r'\btruyền\b',
                    r'\(\s*u\s*\)', r'\buống\b', r'\buong\b', r'(?<![0-9a-zA-ZÀ-ỹ])u(?![0-9a-zA-ZÀ-ỹ])',
                    r'\(\s*tb\s*\)', r'(?<![0-9a-zA-ZÀ-ỹ])tb(?![0-9a-zA-ZÀ-ỹ])',
                    r'\(\s*tdd\s*\)', r'(?<![0-9a-zA-ZÀ-ỹ])tdd(?![0-9a-zA-ZÀ-ỹ])',
                    r'\(\s*pkd\s*\)', r'(?<![0-9a-zA-ZÀ-ỹ])pkd(?![0-9a-zA-ZÀ-ỹ])',
                    r'\bhít\b', r'\bhit\b', r'\bxịt\b', r'\bxit\b', r'\bkhí\s*dung\b', r'\bkhi\s*dung\b',
                    r'\btiêm\s*bắp\b', r'\bdưới\s*da\b', r'\btiêm\b',
                ]
                best = None
                for pat in patterns:
                    m = re.search(pat, text, re.IGNORECASE)
                    if m and m.start() > 0 and (best is None or m.start() < best.start()):
                        best = m
                if not best:
                    return text, ""
                drug_part = text[:best.start()].strip(' ,;:-')
                usage_part = text[best.start():].strip(' ,;:-')
                usage_part = re.sub(r'^\(\s*u\s*\)', 'Uống', usage_part, flags=re.IGNORECASE)
                usage_part = re.sub(r'^(?<![0-9a-zA-ZÀ-ỹ])u(?![0-9a-zA-ZÀ-ỹ])', 'Uống', usage_part, flags=re.IGNORECASE)
                usage_part = re.sub(r'\(\s*ttm\s*\)', 'TTM', usage_part, flags=re.IGNORECASE)
                usage_part = re.sub(r'^\(\s*tb\s*\)', 'Tiêm bắp', usage_part, flags=re.IGNORECASE)
                usage_part = re.sub(r'^(?<![0-9a-zA-ZÀ-ỹ])tb(?![0-9a-zA-ZÀ-ỹ])', 'Tiêm bắp', usage_part, flags=re.IGNORECASE)
                usage_part = re.sub(r'^\(\s*tdd\s*\)', 'Tiêm dưới da', usage_part, flags=re.IGNORECASE)
                usage_part = re.sub(r'^(?<![0-9a-zA-ZÀ-ỹ])tdd(?![0-9a-zA-ZÀ-ỹ])', 'Tiêm dưới da', usage_part, flags=re.IGNORECASE)
                usage_part = re.sub(r'^\(\s*pkd\s*\)', 'PKD', usage_part, flags=re.IGNORECASE)
                usage_part = re.sub(r'^(?<![0-9a-zA-ZÀ-ỹ])pkd(?![0-9a-zA-ZÀ-ỹ])', 'PKD', usage_part, flags=re.IGNORECASE)
                usage_part = re.sub(r'(?i)\bg\s*/\s*ph\b', 'g/p', usage_part)
                return drug_part, usage_part

            def _infer_orphan_self_paid_drug(drug):
                """Bù tối thiểu cho thuốc (TT)/(CS) bị tách dòng hoặc thiếu dòng dùng.

                Riêng Vancomycin dạng bột/lọ: đây là thuốc phải pha NaCl để truyền TTM,
                không được rơi về mặc định "Tiêm (tự túc)" hoặc mất khỏi danh sách.
                """
                if not isinstance(drug, dict) or not drug.get("tu_tuc"):
                    return drug
                if str(drug.get("duong_dung_goc") or "").strip() or str(drug.get("gio_dung") or "").strip():
                    return drug

                name_u = _norm_upper(
                    f"{drug.get('ten_thuoc', '')} {drug.get('hoat_chat', '')} {drug.get('ten_hien_thi', '')} {drug.get('raw_text', '')}"
                )
                dang_u = _norm_upper(f"{drug.get('dang', '')} {drug.get('raw_text', '')}")
                is_powder_vial = any(k in dang_u for k in ["LỌ", "LO", "BỘT", "BOT"])

                if "VANCOMYCIN" in name_u and is_powder_vial:
                    drug["duong_dung_goc"] = "TTM (tự túc; suy luận Vancomycin dạng lọ/bột pha NaCl)"
                    drug["dung_moi"] = drug.get("dung_moi") or "NACL_0.9"
                    # Không gán cứng thể tích ở bước này.
                    # Nếu y lệnh/dòng NaCl ghi 100ml thì diluent_resolver phải được quyền đọc 100ml.
                    # Chỉ khi hoàn toàn không có dữ kiện thể tích, diluent_resolver mới dùng mặc định cấu hình.
                    drug.pop("the_tich", None)
                    drug.pop("tui_dich_truyen_ml", None)
                    drug["suy_luan_duong_dung"] = True
                return drug

            def _push_categorized_drug(drug):
                if not isinstance(drug, dict):
                    return
                # Bù thông tin còn thiếu từ medication_catalog trước khi phân loại.
                # Ví dụ THERMODOL đã có "TTM" nhưng thiếu giờ/tốc độ/thể tích vẫn cần
                # suy luận cữ từ giờ y lệnh để không sót 16h/23h.
                drug, _matched_med = complete_medication_from_catalog(drug, only_if_missing_usage=False)
                for _h in parse_hours_from_gio_dung(drug.get('gio_dung', '')):
                    try:
                        all_hours.add(int(_h))
                    except Exception as exc:
                        LOG.debug("Handled xu_ly fallback exception", exc_info=True)
                if is_reserve_context:
                    drug["du_tru"] = True
                    drug["reserve_order"] = True
                    drug["order_context"] = "du_tru"
                    drug["block_context"] = "du_tru"
                elif is_add_context:
                    drug["thuoc_them"] = True
                    drug["add_order"] = True
                    drug["order_context"] = "them"
                    drug["block_context"] = "them"
                cat = categorize_drug(drug)
                drug["duong_dung"] = get_route_label(
                    drug.get("duong_dung_goc", ""),
                    drug.get("ten_thuoc", "") or drug.get("ten_hien_thi", "")
                )
                if cat == "dich_truyen":
                    raw_dich_truyen.append(drug)
                elif cat == "thuoc_tiem":
                    raw_thuoc_tiem.append(drug)
                else:
                    new_p["thuoc"].setdefault(cat, []).append(drug)

            def _is_water_solvent_drug(drug):
                name_u = _norm_upper(f"{(drug or {}).get('ten_thuoc', '')} {(drug or {}).get('ten_hien_thi', '')}")
                return any(k in name_u for k in ["NƯỚC CẤT", "NUOC CAT", "AQUA", "WATER FOR INJECTION"])

            def _push_unparsed_drug(drug, reason="missing_usage"):
                if not isinstance(drug, dict):
                    return
                # Nước cất pha tiêm không có dòng đường dùng riêng vẫn phải đi cùng danh sách thuốc tiêm
                # để clean_and_merge_injections gắn nhãn '+ Pha nước cất' cho thuốc dạng lọ/bột.
                if _is_water_solvent_drug(drug):
                    drug.setdefault("duong_dung_goc", "Dung môi pha tiêm")
                    drug.setdefault("dung_moi", "NUOC_CAT")
                    raw_thuoc_tiem.append(drug)
                    return
                new_p["thuoc"].setdefault("khac", []).append(drug)
                event = {
                    "reason": reason,
                    "ten_thuoc": drug.get("ten_thuoc", ""),
                    "hoat_chat": drug.get("hoat_chat", ""),
                    "gio_y_lenh": drug.get("gio_y_lenh", ""),
                    "bac_si": drug.get("bac_si", ""),
                    "raw": drug.get("raw_text") or drug.get("ten_thuoc", ""),
                }
                new_p.setdefault("unparsed_orders", []).append(event)
                new_p.setdefault("processing_warnings", []).append({
                    "code": "UNPARSED_MEDICATION",
                    "level": "warning",
                    "message": f"Thuốc chưa đủ thông tin để phân loại: {event['ten_thuoc']}",
                    "gio_y_lenh": event["gio_y_lenh"],
                })

            _prev_line = ""
            _cur_section = ""   # track section: "thuoc", "thuoc_tra", "ylenh_khac", ...
            for line in lines:
                line = (line or "").strip()
                if not line:
                    continue
                if re.match(r'^\s*(?:\[\s*)?\d{1,2}(?::|h)\d{0,2}[^\n]*?(?:BS|B(?:Á|A)C\s*S(?:Ĩ|I))\s*:\s*.+$', line, re.IGNORECASE):
                    continue

                # Bỏ qua section header trùng lặp liên tiếp
                # (EMR đôi khi sinh "+ Thuốc:" 2 lần liền → tạo nhóm thuốc rỗng)
                _is_section = bool(re.match(r'^\+\s+\S', line))
                if _is_section and line == _prev_line:
                    continue
                _prev_line = line
                # Cập nhật section hiện tại
                if _is_section:
                    sl = line.lower()
                    if "thuốc trả" in sl or "thuoc tra" in sl:
                        _cur_section = "thuoc_tra"
                    elif "+ thuốc" in sl:
                        _cur_section = "thuoc"
                    elif "y lệnh khác" in sl:
                        _cur_section = "ylenh_khac"
                    else:
                        _cur_section = "other"
                    continue

                # 0a) Thuốc trả: dòng bắt đầu "-" trong section thuoc_tra
                if _cur_section == "thuoc_tra" and line.startswith("-"):
                    drug_tra_line = re.sub(r"^[-\s]+", "", line).strip()
                    if drug_tra_line:
                        d_tra = parse_drug_name(drug_tra_line)
                        d_tra["bac_si"] = (doc_name or "").strip()
                        d_tra["gio_y_lenh"] = (order_header_time or "").strip()
                        new_p["thuoc"]["thuoc_tra"].append(d_tra)
                    continue

                # 0b) Dòng thuốc tự túc (TT) hoặc có sẵn (CS)
                # → vẫn đi qua parse/update/categorize như thuốc thường để tránh phân loại sai.
                _self_paid_match = _match_self_paid_prefix(line)
                if _self_paid_match:
                    if current_drug:
                        current_drug = _complete_orphan_infusion_order(current_drug)
                        current_drug = _infer_orphan_self_paid_drug(current_drug)
                        if current_drug.get("duong_dung_goc") or current_drug.get("gio_dung"):
                            _push_categorized_drug(current_drug)
                        else:
                            _push_unparsed_drug(current_drug)
                        current_drug = None

                    line_body = line[_self_paid_match.end():].strip()
                    drug_part, usage_part = _split_self_paid_drug_and_usage(line_body)

                    d_tt = parse_drug_name(drug_part or line_body)
                    d_tt["raw_text"] = line
                    d_tt["raw_drug_part"] = drug_part or line_body
                    if usage_part:
                        d_tt["raw_usage_part"] = usage_part
                    d_tt["tu_tuc"] = True
                    d_tt["bac_si"] = (doc_name or "").strip()
                    d_tt["gio_y_lenh"] = (order_header_time or "").strip()

                    if usage_part and _is_usage_line(usage_part):
                        d_tt = update_drug_usage(d_tt, usage_part, time_map)
                    else:
                        gio_list = re.findall(r'(\d{1,2})h(?!\w)', line_body, flags=re.IGNORECASE) or re.findall(r'(\d{1,2})\s*giờ', line_body, flags=re.IGNORECASE)
                        if gio_list:
                            d_tt["gio_dung"] = ", ".join([f"{h} giờ" for h in dict.fromkeys(gio_list)])
                        if _has_oral_marker(line_body):
                            d_tt["duong_dung_goc"] = "Uống (tự túc)"
                        elif re.search(r'\(\s*ttm\s*\)|\bttm\b|truyền\s*tĩnh\s*mạch', line_body, re.IGNORECASE):
                            d_tt["duong_dung_goc"] = "TTM (tự túc)"
                            d_tt["toc_do"] = extract_infusion_rate(line_body)
                        elif re.search(r'\(\s*tb\s*\)|(?<![0-9a-zA-ZÀ-ỹ])tb(?![0-9a-zA-ZÀ-ỹ])|tiêm\s*bắp', line_body, re.IGNORECASE):
                            d_tt["duong_dung_goc"] = "Tiêm bắp (tự túc)"
                        elif re.search(r'\(\s*tdd\s*\)|(?<![0-9a-zA-ZÀ-ỹ])tdd(?![0-9a-zA-ZÀ-ỹ])|dưới\s*da|duoi\s*da', line_body, re.IGNORECASE):
                            d_tt["duong_dung_goc"] = "Tiêm dưới da (tự túc)"
                        elif re.search(r'hít|hit|xịt|xit|khí\s*dung|khi\s*dung', line_body, re.IGNORECASE):
                            d_tt["duong_dung_goc"] = "Hít/Xịt (tự túc)"
                        else:
                            # Dòng (TT)/(CS) chỉ có tên thuốc sẽ được giữ lại làm current_drug
                            # để dòng kế tiếp (TTM/uống/hít...) cập nhật đúng, không mặc định thành tiêm.
                            # Nếu đến cuối block vẫn không có dòng hướng dẫn, bước finalize sẽ tự suy luận riêng
                            # cho Vancomycin dạng lọ/bột là TTM pha NaCl.
                            current_drug = d_tt
                            continue

                    if (not d_tt.get("the_tich")) and re.search(r'\(\s*ttm\s*\)|\bttm\b|truyền\s*tĩnh\s*mạch', line_body, re.IGNORECASE):
                        d_tt["the_tich"] = get_volume_from_config(d_tt.get("ten_thuoc", ""), d_tt.get("hoat_chat", ""), d_tt.get("dang", "")) or 100.0

                    _push_categorized_drug(d_tt)
                    current_drug = None
                    continue

                # 0c) Dòng hướng dẫn ngay sau thuốc đang chờ.
                # QUAN TRỌNG: nếu bản thân dòng hiện tại cũng là một dòng thuốc mới
                # (vd. GEMAPAXANE ... (Bơm tiêm), NƯỚC CẤT ... x 8 (Ống)) thì phải
                # ưu tiên nhận diện thuốc mới. Nếu không, các từ "bơm/tiêm/pha" trong
                # tên/dạng thuốc sẽ bị nuốt làm hướng dẫn của thuốc trước đó.
                if current_drug and _is_usage_line(line) and not _is_drug_line(line):
                    current_drug["raw_usage_line"] = line
                    current_drug = update_drug_usage(current_drug, line, time_map)
                    hours = parse_hours_from_gio_dung(current_drug.get('gio_dung', ''))
                    for h in hours:
                        try:
                            all_hours.add(int(h))
                        except Exception as exc:
                            LOG.debug("Handled xu_ly fallback exception", exc_info=True)
                            pass

                    _push_categorized_drug(current_drug)
                    current_drug = None
                    continue

                # 1) Dòng thuốc (có thể kèm hướng dẫn)
                if _is_drug_line(line):
                    if current_drug:
                        current_drug = _complete_orphan_infusion_order(current_drug)
                        current_drug = _infer_orphan_self_paid_drug(current_drug)
                        if current_drug.get("duong_dung_goc") or current_drug.get("gio_dung"):
                            _push_categorized_drug(current_drug)
                        else:
                            _push_unparsed_drug(current_drug)
                        current_drug = None

                    drug_part, usage_part = _split_drug_and_usage(line)
                    current_drug = parse_drug_name(drug_part)
                    if isinstance(current_drug, dict):
                        current_drug["raw_text"] = line
                        current_drug["raw_drug_part"] = drug_part
                        if usage_part:
                            current_drug["raw_usage_part"] = usage_part
                        # Bác sĩ ra y lệnh cho block thuốc này
                        current_drug["bac_si"] = (doc_name or "").strip()
                        current_drug["gio_y_lenh"] = (order_header_time or "").strip()

                    if usage_part and _is_usage_line(usage_part):
                        current_drug = update_drug_usage(current_drug, usage_part, time_map)
                        hours = parse_hours_from_gio_dung(current_drug.get('gio_dung', ''))
                        for h in hours:
                            try:
                                all_hours.add(int(h))
                            except Exception as exc:
                                LOG.debug("Handled xu_ly fallback exception", exc_info=True)
                                pass

                        _push_categorized_drug(current_drug)
                        current_drug = None
                    continue

                # 2) Dòng hướng dẫn (chỉ khi không phải một dòng thuốc mới)
                if current_drug and _is_usage_line(line) and not _is_drug_line(line):
                    current_drug["raw_usage_line"] = line
                    current_drug = update_drug_usage(current_drug, line, time_map)
                    hours = parse_hours_from_gio_dung(current_drug.get('gio_dung', ''))
                    for h in hours:
                        try:
                            all_hours.add(int(h))
                        except Exception as exc:
                            LOG.debug("Handled xu_ly fallback exception", exc_info=True)
                            pass

                    _push_categorized_drug(current_drug)

                    current_drug = None
                    continue

            if current_drug:
                current_drug = _complete_orphan_infusion_order(current_drug)
                current_drug = _infer_orphan_self_paid_drug(current_drug)
                if current_drug.get("duong_dung_goc") or current_drug.get("gio_dung"):
                    _push_categorized_drug(current_drug)
                    hours = re.findall(r'(?<!:)(\d{1,2})(?=\s*(?:giờ|h)\b)', current_drug.get('gio_dung', ''), flags=re.IGNORECASE)
                    for h in hours:
                        try:
                            all_hours.add(int(h))
                        except Exception as exc:
                            LOG.debug("Handled xu_ly fallback exception", exc_info=True)
                else:
                    _push_unparsed_drug(current_drug)
            new_p["tong_hop_gio_dung"] = sorted(list(all_hours))
            new_p["y_lenh_khac"] = extract_other_orders(doc_content)
            # Gợi ý/đính kèm dung môi NaCl theo cùng giờ (NEFOPAM/TRAMADOL và các thuốc hay pha truyền)
            raw_dich_truyen, raw_thuoc_tiem = infer_and_reclassify_diluents(raw_dich_truyen, raw_thuoc_tiem)

            # Nếu NaCl/Sodium chỉ là dung môi đã được gắn vào thuốc truyền cùng giờ
            # thì không giữ thêm như một chai dịch truyền độc lập để tránh tính đôi
            # và tránh scheduler đẩy giờ thuốc chính xuống sau chai NaCl.
            raw_dich_truyen = _drop_sodium_diluent_duplicates(raw_dich_truyen)

            # LLM fallback: bổ sung field còn thiếu (toc_do, gio_dung, the_tich) sau regex parse
            try:
                from processing.llm_parser import enrich_drug_list
                raw_dich_truyen = enrich_drug_list(raw_dich_truyen, category="dich_truyen")
                raw_thuoc_tiem  = enrich_drug_list(raw_thuoc_tiem,  category="thuoc_tiem")
            except Exception as _llm_err:
                LOG.debug("[llm_parser] bo qua (khong anh huong pipeline): %s", _llm_err)

            new_p["thuoc"]["dich_truyen"] = calculate_infusion_times(raw_dich_truyen, ngay_record)
            new_p["thuoc"]["thuoc_tiem"] = clean_and_merge_injections(raw_thuoc_tiem)

            # Loại thuốc chỉ định 'trước rạch da ...' (không thực hiện tại đây), đưa sang y_lenh_khac['khac']
            filtered_inj = []
            for inj in (new_p.get("thuoc", {}).get("thuoc_tiem") or []):
                route_l = (inj.get("duong_dung_goc") or "").lower()
                if ("trước rạch da" in route_l) or ("truoc rach da" in route_l) or inj.get("thoi_gian_dac_biet"):
                    tg = inj.get("thoi_gian_dac_biet") or "Trước rạch da 30 phút"
                    note = f"{inj.get('ten_thuoc','').strip()}: {tg}"
                    new_p.setdefault("y_lenh_khac", {}).setdefault("khac", []).append(note)
                    continue
                filtered_inj.append(inj)
            new_p["thuoc"]["thuoc_tiem"] = filtered_inj

            
            # Làm sạch mục 'khac': loại trùng với các thuốc đã phân loại & bỏ bản ghi rỗng
            existing_keys = set()
            for _cat in ['dich_truyen','thuoc_tiem','thuoc_uong']:
                for _d in (new_p.get('thuoc', {}).get(_cat) or []):
                    k = _norm_upper(_d.get('ten_thuoc',''))
                    if k: existing_keys.add(k)
            # Thuốc trùng theo bệnh nhân ở các đoạn BS khác: nếu bản ghi hiện tại thiếu giờ/đường dùng thì bỏ (ưu tiên đoạn đầy đủ)
            prev_keys = set()
            for _pp in FINAL_DATA:
                if _pp.get('ma_bn') == new_p.get('ma_bn'):
                    for _cat2 in ['dich_truyen','thuoc_tiem','thuoc_uong','khac']:
                        for _dd in (_pp.get('thuoc', {}).get(_cat2) or []):
                            kk = _norm_upper(_dd.get('ten_thuoc',''))
                            if kk: prev_keys.add(kk)

            new_khac = []
            seen_khac = set()
            for _d in (new_p.get('thuoc', {}).get('khac') or []):
                k = _norm_upper(_d.get('ten_thuoc',''))
                if not k:
                    continue
                # trùng với thuốc đã phân loại trong cùng đoạn
                if k in existing_keys:
                    continue
                # trùng với đoạn trước của cùng bệnh nhân nhưng bản ghi này không có giờ/đường dùng -> bỏ
                if k in prev_keys and (not str(_d.get('gio_dung','')).strip()) and (not str(_d.get('duong_dung_goc','')).strip()):
                    continue
                # dung dịch/NaCl dạng 'tồn kho' không có giờ/đường dùng -> bỏ
                if (('SODIUM CHLORIDE' in k) or ('NATRI CLORID' in k)) and (not str(_d.get('gio_dung','')).strip()) and (not str(_d.get('duong_dung_goc','')).strip()):
                    continue
                if k in seen_khac:
                    continue
                seen_khac.add(k)
                new_khac.append(_d)
            new_p['thuoc']['khac'] = new_khac

            # Loại dòng +Y lệnh khác đã được parse thành thuốc (đặc biệt thuốc (TT)/(CS)) để không hiển thị trùng.
            classified_raw_texts = set()
            for _cat in ['dich_truyen', 'thuoc_tiem', 'thuoc_uong', 'thuoc_hit_xit', 'thuoc_boi', 'thuoc_nho', 'thuoc_dat']:
                for _d in (new_p.get('thuoc', {}).get(_cat) or []):
                    raw = str(_d.get('raw_text') or '').strip()
                    if raw:
                        classified_raw_texts.add(raw)
                    raw_usage_line = str(_d.get('raw_usage_line') or '').strip()
                    if raw_usage_line:
                        classified_raw_texts.add(raw_usage_line)
            if classified_raw_texts:
                _yk = new_p.get('y_lenh_khac') or {}
                _yk['khac'] = [x for x in (_yk.get('khac') or []) if str(x or '').strip() not in classified_raw_texts]
                new_p['y_lenh_khac'] = _yk

            # Thủ thuật
            chi_khac, chi_dvkt = extract_procedures_detailed(doc_content, p, ngay_record)
            new_p["chi_dinh_khac"] = chi_khac
            new_p["chi_dinh_dvkt"] = chi_dvkt
            
            FINAL_DATA.append(new_p)

    # V12: gộp bản ghi trùng theo (ngay_lam, ma_bn) và loại lặp trong các list
    FINAL_DATA = merge_records_by_patient_v12(FINAL_DATA)

    # Áp dụng rule nghiệp vụ sau khi đã gộp bệnh nhân/ngày.
    # Rule mới: thuốc/y lệnh có ghi trong mổ/sau mổ/SM thì bỏ qua vì xem như đã làm ở phòng mổ/hậu phẫu.
    # Tính lại tong_hop_gio_dung để preview/chăm sóc/dịch truyền dùng chung dữ liệu đã sạch.
    if apply_clinical_rules_to_record:
        FINAL_DATA = [apply_clinical_rules_to_record(x) for x in FINAL_DATA]

    # Final guard thể tích dịch truyền sau merge/clinical-rules:
    # không để TRASOLU/Tramadol pha NaCl mang 2ml của ống thuốc sang bước nhập.
    FINAL_DATA = [_normalize_final_infusion_operational_volumes(x) for x in (FINAL_DATA or [])]

    # Y lệnh phát sinh sau y lệnh thuốc gốc (ngưng cử / chuyển cử) chỉ có đủ
    # ngữ cảnh sau khi đã merge toàn bộ patient-day, nên áp dụng tại đây.
    FINAL_DATA = [_apply_order_execution_adjustments(x) for x in (FINAL_DATA or [])]

    # DOCTOR-ONLY-IN-INFUSION: làm sạch lần cuối (bỏ bác sĩ cấp BN, gắn bác sĩ vào từng giờ dịch truyền)
    FINAL_DATA = [attach_doctor_into_dich_truyen_hours(x) for x in (FINAL_DATA or [])]

    # VTYT tự động: gắn kế hoạch vật tư vào từng record sau khi thuốc/y lệnh đã sạch và đã gộp.
    # Đây là nguồn chuẩn cho tab Điều dưỡng hành chánh và worker input_vtyt.py.
    if build_required_supplies:
        for _rec in FINAL_DATA:
            try:
                _items = build_required_supplies([_rec])
                _rec['vtyt'] = {
                    'items': _items,
                    'warnings': [],
                    'source': 'auto_rules_v1',
                }
            except Exception as exc:
                LOG.warning('Không tạo được kế hoạch VTYT cho %s %s: %s', _rec.get('ma_bn'), _rec.get('ngay_lam'), exc)
                _rec['vtyt'] = {
                    'items': [],
                    'warnings': [str(exc)],
                    'source': 'auto_rules_v1_error',
                }

    return FINAL_DATA
