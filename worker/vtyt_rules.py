# -*- coding: utf-8 -*-
"""vtyt_rules.py — Tính vật tư y tế cần kê khai từ dữ liệu đã phân loại.

Nguyên tắc nghiệp vụ hiện tại:
- Worker input_vtyt.py vẫn nhập đúng popup "Nhập thuốc/VTYT sử dụng" hiện có của EMR.
- Không làm dự trù 3 ngày, không tính lĩnh thêm/trả kho.
- Kế hoạch VTYT là kế hoạch BN/ngày, nhập thêm khi dữ liệu y lệnh thay đổi.
- Dictionary có thể cập nhật tại: config/vtyt_dictionary.json
  Nếu chưa có file thật, xem mẫu: config/vtyt_dictionary.example.json

Phân loại VTYT:
- daily: nhập mỗi ngày nếu thuộc điều kiện BN/ngày.
- medication: phát sinh theo thuốc/y lệnh thuốc.
- dvkt: phát sinh theo DVKT/thủ thuật/chăm sóc.
- interval: vật tư cách khoảng, cần nhìn lại lịch sử 3–4 ngày trước, ví dụ kim luồn.
"""
from __future__ import annotations

import json
import os
import re
import unicodedata
from shared.text_utils import norm_vi as norm
from collections import defaultdict
from datetime import datetime, timedelta
from typing import Any, Dict, Iterable, List, Mapping, Optional, Sequence, Tuple

CATALOG: Dict[str, Dict[str, Any]] = {
    "GANG_TAY_KHAM": {
        "code": "VTYT.000004174", "name": "Găng tay khám Latex có bột hiệu I-Med",
        "searchKeyword": "Găng tay khám", "aliases": ["găng tay khám", "gang tay kham", "latex"],
    },
    "DAY_TRUYEN_DICH": {
        "code": "VTYT.000004109", "name": "Dây truyền dịch",
        "searchKeyword": "Dây truyền dịch", "aliases": ["dây truyền dịch", "day truyen dich", "dây truyền"],
    },
    "KIM_TIEM_PHA": {
        "code": "VTYT.000004280", "name": "Kim tiêm Tanaphar",
        "searchKeyword": "Kim tiêm", "aliases": ["kim tiêm", "kim tiem", "kim pha"],
    },
    "BOM_TIEM_5ML": {
        "code": "VTYT.000004033", "name": "Bơm tiêm vô trùng sử dụng một lần 5ml/cc, kim các cỡ, VIKIMCO",
        "searchKeyword": "Bơm tiêm 5ml", "aliases": ["bơm tiêm 5ml", "bom tiem 5ml", "5ml"],
    },
    "BOM_TIEM_10ML": {
        "code": "VTYT.000004009", "name": "Bơm tiêm vô trùng sử dụng một lần 10ml/cc, kim các cỡ, VIKIMCO",
        "searchKeyword": "Bơm tiêm 10ml", "aliases": ["bơm tiêm 10ml", "bom tiem 10ml", "10ml"],
    },
    "BOM_TIEM_20ML": {
        "code": "VTYT.000004017", "name": "Bơm tiêm vô trùng sử dụng một lần 20ml/cc, kim các cỡ, VIKIMCO",
        "searchKeyword": "Bơm tiêm 20ml", "aliases": ["bơm tiêm 20ml", "bom tiem 20ml", "20ml"],
    },
    "BOM_TIEM_50ML_CHO_AN": {
        "code": "VTYT.000004023", "name": "Bơm tiêm vô trùng sử dụng một lần 50 ml/cc, loại cho ăn, VIKIMCO",
        "searchKeyword": "Bơm tiêm 50 ml", "aliases": ["bơm tiêm 50ml", "bom tiem 50ml", "50 ml", "loại cho ăn"],
    },
    "KIM_LUON_TM": {
        "code": "VTYT.000004259", "name": "Kim luồn tĩnh mạch an toàn MEDCATH",
        "searchKeyword": "Kim luồn tĩnh mạch", "aliases": ["kim luồn", "kim luon", "medcath"],
    },
    "BANG_DINH_KIM_LUON": {
        "code": "VTYT.000003906", "name": "Băng phim trong vô trùng không thấm nước 3M Tegaderm I.V 6,5cm x 7cm",
        "searchKeyword": "Tegaderm I.V", "aliases": ["tegaderm i.v", "băng dính kim luồn", "bang dinh kim luon", "6,5cm x 7cm"],
    },
    "NUT_KIM_LUON_OR_KHOA_3_NGA": {
        "code": "VTYT.000004306", "name": "Khóa 3 ngã có dây 25 cm",
        "searchKeyword": "Khóa 3 ngã", "aliases": ["khóa 3 ngã", "khoa 3 nga", "nút kim luồn", "nut kim luon"],
    },
    "BANG_THUN_3_MOC": {
        "code": "VTYT.000003914", "name": "Băng thun 3 móc",
        "searchKeyword": "Băng thun 3 móc", "aliases": ["băng thun", "bang thun", "3 móc"],
    },
    "BANG_DINH_250X90": {
        "code": "VTYT.000003860", "name": "Băng dính vô trùng vải không dệt, có gạc DECOMED (size 250x90 mm)",
        "searchKeyword": "Băng dính 250x90", "aliases": ["250x90", "băng dính 250", "decomed 250"],
    },
    "BANG_DINH_60X70": {
        "code": "VTYT.000003865", "name": "Băng dính vô trùng vải không dệt, có gạc DECOMED (size 60x70 mm)",
        "searchKeyword": "Băng dính 60x70", "aliases": ["60x70", "băng dính 6x7", "băng dính 60x70", "decomed 60"],
    },
    "TUI_NUOC_TIEU": {
        "code": "VTYT.000004553", "name": "Túi nước tiểu",
        "searchKeyword": "Túi nước tiểu", "aliases": ["túi nước tiểu", "tui nuoc tieu"],
    },
    "SONDE_FOLEY_2_NHANH": {
        "code": "VTYT.000004525", "name": "Sonde foley 2 nhánh các cỡ",
        "searchKeyword": "Sonde foley 2 nhánh", "aliases": ["sonde foley 2 nhánh", "foley 2 nhánh", "sonde tiểu"],
    },
    "DAY_OXY": {
        "code": "VTYT.000004094", "name": "Dây Oxy 2 nhánh người lớn",
        "searchKeyword": "Dây Oxy", "aliases": ["dây oxy", "day oxy", "oxy 2 nhánh"],
    },
    "MAT_NA_KHI_DUNG": {
        "code": "VTYT.000004354", "name": "Mặt nạ xông khí dung MPV",
        "searchKeyword": "Mặt nạ xông khí dung", "aliases": ["mặt nạ xông khí dung", "mặt nạ phun khí dung", "khí dung"],
    },
    "ONG_THONG_DA_DAY": {
        "code": "VTYT.000002214", "name": "Thông dạ dày các số",
        "searchKeyword": "Thông dạ dày", "aliases": ["thông dạ dày", "sonde dạ dày", "ống thông dạ dày"],
    },
}

ANTIBIOTIC_KEYWORDS = [
    "cefoxitin", "ceftriaxone", "cefuroxime", "ceftazidime", "cefazolin", "cefepime",
    "levofloxacin", "ciprofloxacin", "metronidazole", "vancomycin", "amikacin",
    "gentamicin", "meropenem", "imipenem", "piperacillin", "tazobactam", "clindamycin",
]

DEFAULT_QUANTITY_CONFIG = {
    "glovesPerPatientPerDayMin": 4,
    "glovesPerPatientPerDayMax": 5,
    "infusionContinuityGapMinutes": 180,
    "antibioticTmcSyringe20mlPerDose": 1,
    "otherTmcSyringe10mlPerDose": 1,
    "imSyringe5mlPerDose": 1,
    "naclMixSyringe10mlPerDose": 1,
    "mixingNeedlePerDose": 1,
    "ivCatheterPlugPerDay": 1,
    "ivCatheterDefaultQuantity": 1,
    "ivCatheterAge55PlusQuantity": 2,
    "ivCatheterLookbackDays": 4,
    "ivCatheterMinDaysBetween": 3,
    "postopElasticBandageDays": 4,
}


# norm → shared.text_utils.norm_vi (xem MIGRATION.md)


def includes_any(text: Any, keywords: Iterable[str]) -> bool:
    n = norm(text)
    return any(norm(k) in n for k in keywords if str(k or "").strip())


def to_number(value: Any, default: float = 0) -> float:
    if isinstance(value, (int, float)):
        return float(value)
    raw = str(value or "").strip().replace(",", ".")
    m = re.search(r"-?\d+(?:\.\d+)?", raw)
    if not m:
        return default
    try:
        return float(m.group(0))
    except Exception:
        return default


def _project_root() -> str:
    return os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))


def _read_json(path: str) -> Optional[Dict[str, Any]]:
    try:
        if path and os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                data = json.load(f)
            return data if isinstance(data, dict) else None
    except Exception:
        return None
    return None


def load_vtyt_dictionary(config: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    """Load dictionary từ config/vtyt_dictionary.json, có fallback an toàn.

    File cần sửa về sau: config/vtyt_dictionary.json
    File mẫu trong patch: config/vtyt_dictionary.example.json
    """
    base: Dict[str, Any] = {
        "version": 1,
        "catalog": dict(CATALOG),
        "quantityConfig": dict(DEFAULT_QUANTITY_CONFIG),
        "antibioticKeywords": list(ANTIBIOTIC_KEYWORDS),
        "dailySupplies": [
            {"key": "GANG_TAY_KHAM", "qty": DEFAULT_QUANTITY_CONFIG["glovesPerPatientPerDayMax"], "reason": "VTYT thường quy mỗi ngày", "enabled": True}
        ],
        "customRules": [],
    }
    candidates = [
        os.getenv("VTYT_DICTIONARY_PATH", ""),
        os.path.join(_project_root(), "config", "vtyt_dictionary.json"),
        os.path.join(_project_root(), "config", "vtyt_dictionary.example.json"),
    ]
    loaded: Dict[str, Any] = {}
    for p in candidates:
        data = _read_json(p)
        if data:
            loaded = data
            break
    if config and isinstance(config, Mapping):
        loaded = {**loaded, **dict(config)}

    catalog = dict(base["catalog"])
    if isinstance(loaded.get("catalog"), Mapping):
        for key, value in loaded.get("catalog", {}).items():
            if isinstance(value, Mapping):
                catalog[str(key)] = {**catalog.get(str(key), {}), **dict(value)}
    quantity = {**base["quantityConfig"], **(dict(loaded.get("quantityConfig") or {}) if isinstance(loaded.get("quantityConfig"), Mapping) else {})}
    return {
        **base,
        **{k: v for k, v in loaded.items() if k not in ("catalog", "quantityConfig")},
        "catalog": catalog,
        "quantityConfig": quantity,
        "dailySupplies": loaded.get("dailySupplies") if isinstance(loaded.get("dailySupplies"), list) else base["dailySupplies"],
        "customRules": loaded.get("customRules") if isinstance(loaded.get("customRules"), list) else [],
        "antibioticKeywords": loaded.get("antibioticKeywords") if isinstance(loaded.get("antibioticKeywords"), list) else base["antibioticKeywords"],
    }


def _catalog_payload(key: str, dictionary: Optional[Mapping[str, Any]] = None) -> Dict[str, Any]:
    catalog = (dictionary or {}).get("catalog") if isinstance(dictionary, Mapping) else None
    c = (catalog or CATALOG).get(key) or CATALOG.get(key) or {"code": "", "name": key, "searchKeyword": key}
    return {"key": key, "code": c.get("code", ""), "name": c.get("name", key), "searchKeyword": c.get("searchKeyword") or c.get("name") or key}


def add_req(
    acc: Dict[str, Dict[str, Any]],
    key: str,
    qty: float,
    reason: str,
    source: Optional[Mapping[str, Any]] = None,
    *,
    category: str = "medication",
    rule_id: str = "",
    dictionary: Optional[Mapping[str, Any]] = None,
    alert: bool = True,
    input_allowed: bool = True,
    needs_review: bool = False,
) -> None:
    catalog = (dictionary or {}).get("catalog") if isinstance(dictionary, Mapping) else None
    if not key or key not in (catalog or CATALOG) or qty <= 0:
        return
    row = acc.get(key) or {
        **_catalog_payload(key, dictionary),
        "required_quantity": 0,
        "reasons": [],
        "sources": [],
        "category": category,
        "rule_ids": [],
        "alert": alert,
        "input_allowed": input_allowed,
        "needs_review": needs_review,
    }
    row["required_quantity"] += int(qty) if float(qty).is_integer() else float(qty)
    if reason and reason not in row["reasons"]:
        row["reasons"].append(reason)
    if source:
        row["sources"].append(dict(source))
    if rule_id and rule_id not in row["rule_ids"]:
        row["rule_ids"].append(rule_id)
    # Nếu bất kỳ phần nào cần review thì giữ cờ để worker không nhập mù.
    row["needs_review"] = bool(row.get("needs_review") or needs_review)
    row["input_allowed"] = bool(row.get("input_allowed", True) and input_allowed)
    if category != row.get("category"):
        row["category"] = row.get("category") or category
    acc[key] = row


def item_text(item: Mapping[str, Any]) -> str:
    keys = [
        "ten_thuoc_vtyt", "ten_hien_thi", "ten_thuoc", "Full_Name", "name", "raw", "raw_text",
        "duong_dung", "duong_dung_goc", "route", "routeLabel", "Ghi_Chu", "ghi_chu",
        "gio_dung", "times", "scheduled_times", "time", "cach_dung",
    ]
    return " ".join(str(item.get(k) or "") for k in keys)


def is_antibiotic(text: Any, dictionary: Optional[Mapping[str, Any]] = None) -> bool:
    kws = (dictionary or {}).get("antibioticKeywords") if isinstance(dictionary, Mapping) else None
    return includes_any(text, kws or ANTIBIOTIC_KEYWORDS)


def is_infusion_item(item: Mapping[str, Any]) -> bool:
    return includes_any(item_text(item), ["truyền", "tiêm truyền", "tiem truyen", "dịch truyền", "dich truyen", "natri clorid", "ringer", "glucose"])


def is_tmc_item(item: Mapping[str, Any]) -> bool:
    return includes_any(item_text(item), ["tmc", "tĩnh mạch chậm", "tinh mach cham", "tiêm tĩnh mạch", "tiem tinh mach"])


def is_im_item(item: Mapping[str, Any]) -> bool:
    return includes_any(item_text(item), ["tiêm bắp", "tiem bap", " tb", "(tb)"])


def is_mixed_with_nacl(item: Mapping[str, Any], siblings: Sequence[Mapping[str, Any]]) -> bool:
    raw = item_text(item)
    if includes_any(raw, ["pha nacl", "pha natri clorid", "natri clorid 0,9%", "nacl 0,9%"]):
        return True
    if includes_any(raw, ["natri clorid", "nacl"]) and not is_tmc_item(item):
        return False
    return any(includes_any(item_text(x), ["natri clorid", "nacl"]) for x in siblings if x is not item)


def get_dose_count(item: Mapping[str, Any]) -> int:
    for key in ("gio_dung", "times", "scheduled_times", "gio", "time"):
        value = item.get(key)
        if isinstance(value, list):
            return max(1, len([x for x in value if str(x or "").strip()]))
        text = str(value or "").strip()
        if text:
            hits = re.findall(r"(?<!\d)(?:[01]?\d|2[0-3])(?::\d{2}|h)(?!\d)", text, flags=re.IGNORECASE)
            if hits:
                return max(1, len(set(hits)))
    for key in ("so_cu", "so_lan", "dose_count", "So_Cu"):
        n = int(to_number(item.get(key), 0))
        if n > 0:
            return n
    return 1


def _collect_meds(records: Sequence[Mapping[str, Any]]) -> Tuple[List[Mapping[str, Any]], List[Mapping[str, Any]], List[Mapping[str, Any]]]:
    infusions: List[Mapping[str, Any]] = []
    injections: List[Mapping[str, Any]] = []
    all_meds: List[Mapping[str, Any]] = []
    for r in records:
        thuoc = r.get("thuoc") or {}
        for x in thuoc.get("dich_truyen") or []:
            if isinstance(x, Mapping):
                infusions.append(x); all_meds.append(x)
        for x in thuoc.get("thuoc_tiem") or []:
            if isinstance(x, Mapping):
                injections.append(x); all_meds.append(x)
        for k, v in thuoc.items():
            if k in ("dich_truyen", "thuoc_tiem", "thuoc_uong", "thuoc_tra", "khac"):
                continue
            if isinstance(v, list):
                for x in v:
                    if isinstance(x, Mapping):
                        all_meds.append(x)
    return infusions, injections, all_meds


def _record_blob(records: Sequence[Mapping[str, Any]]) -> str:
    try:
        return json.dumps(records, ensure_ascii=False)
    except Exception:
        return " ".join(str(x) for x in records)


def _has_surgery_text(records: Sequence[Mapping[str, Any]]) -> bool:
    return includes_any(_record_blob(records), ["phẫu thuật", "phau thuat", "hậu phẫu", "hau phau", "sau mổ", "sau mo", "vết mổ", "vet mo", "nội soi", "noi soi"])


def _parse_dmy(value: Any) -> Optional[datetime]:
    m = re.search(r"(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})", str(value or ""))
    if not m:
        return None
    dd, mm, yy = int(m.group(1)), int(m.group(2)), int(m.group(3))
    if yy < 100:
        yy += 2000
    try:
        return datetime(yy, mm, dd)
    except Exception:
        return None


def _record_date(record: Mapping[str, Any]) -> Optional[datetime]:
    for k in ("ngay_lam", "date", "ngay", "ngay_y_lenh"):
        dt = _parse_dmy(record.get(k))
        if dt:
            return dt
    return None


def _same_day(a: Optional[datetime], b: Optional[datetime]) -> bool:
    return bool(a and b and a.date() == b.date())


def _time_to_minutes(value: str) -> Optional[int]:
    m = re.search(r"(?<!\d)([01]?\d|2[0-3])(?::(\d{2})|h(?:(\d{2}))?)(?!\d)", value, flags=re.IGNORECASE)
    if not m:
        return None
    h = int(m.group(1)); minute = int(m.group(2) or m.group(3) or 0)
    return h * 60 + minute


def _parse_time_ranges(text: str) -> List[Tuple[int, int]]:
    n = str(text or "")
    out: List[Tuple[int, int]] = []
    # 08:00-12:00, 08h-12h, 08:00 đến 12:00
    range_re = re.compile(r"((?:[01]?\d|2[0-3])(?::\d{2}|h\d{0,2}))\s*(?:-|–|đến|den|toi|tới)\s*((?:[01]?\d|2[0-3])(?::\d{2}|h\d{0,2}))", re.I)
    consumed = []
    for m in range_re.finditer(n):
        s = _time_to_minutes(m.group(1)); e = _time_to_minutes(m.group(2))
        if s is not None and e is not None:
            if e <= s:
                e += 24 * 60
            out.append((s, e))
            consumed.append((m.start(), m.end()))
    # single times not part of ranges
    singles = []
    for m in re.finditer(r"(?<!\d)((?:[01]?\d|2[0-3])(?::\d{2}|h\d{0,2}))(?!\d)", n, flags=re.I):
        if any(a <= m.start() < b for a, b in consumed):
            continue
        minute = _time_to_minutes(m.group(1))
        if minute is not None:
            singles.append(minute)
    for minute in sorted(set(singles)):
        out.append((minute, minute + 120))
    return out or [(12 * 60, 14 * 60)]


def _infusion_sessions(records: Sequence[Mapping[str, Any]]) -> List[Dict[str, Any]]:
    sessions: List[Dict[str, Any]] = []
    for r in records:
        d = _record_date(r)
        if not d:
            continue
        infusions, _, _ = _collect_meds([r])
        for item in infusions:
            if not isinstance(item, Mapping):
                continue
            for start_min, end_min in _parse_time_ranges(item_text(item)):
                start = d + timedelta(minutes=start_min)
                end = d + timedelta(minutes=end_min)
                sessions.append({"start": start, "end": end, "item": item, "record": r})
    return sorted(sessions, key=lambda x: x["start"])


def _count_new_infusion_sets(current_records: Sequence[Mapping[str, Any]], all_records: Sequence[Mapping[str, Any]], target_date: Optional[datetime], gap_minutes: int) -> int:
    current_sessions = _infusion_sessions(current_records)
    if not current_sessions:
        return 0
    if not target_date:
        # Fallback: gom phiên trong ngày đang xét theo khoảng cách, không tính theo từng chai/cử máy móc.
        count = 0; current_end = None
        for s in current_sessions:
            if current_end is None or (s["start"] - current_end).total_seconds() / 60 > gap_minutes:
                count += 1
            current_end = max(current_end or s["end"], s["end"])
        return max(1, count)

    history_sessions = _infusion_sessions(all_records or current_records)
    count = 0
    counted_groups: List[Tuple[datetime, datetime]] = []
    for s in current_sessions:
        if not _same_day(s["start"], target_date):
            continue
        continued = False
        for h in history_sessions:
            if h is s:
                continue
            # phiên trước đó còn liên quan, chưa quá khoảng gap: không cần dây mới.
            if h["start"] < s["start"] and 0 <= (s["start"] - h["end"]).total_seconds() / 60 <= gap_minutes:
                continued = True
                break
        if not continued:
            for a, b in counted_groups:
                if a <= s["start"] <= b + timedelta(minutes=gap_minutes):
                    continued = True
                    break
        if not continued:
            count += 1
            counted_groups.append((s["start"], s["end"]))
        else:
            if counted_groups:
                a, b = counted_groups[-1]
                counted_groups[-1] = (a, max(b, s["end"]))
    return count


def _has_iv_trigger(records: Sequence[Mapping[str, Any]]) -> bool:
    infusions, injections, _ = _collect_meds(records)
    return bool(infusions) or any(is_tmc_item(x) for x in injections)


def _has_explicit_iv_change(records: Sequence[Mapping[str, Any]]) -> bool:
    return includes_any(_record_blob(records), ["đặt kim luồn", "dat kim luon", "thay kim luồn", "thay kim luon", "kim luồn hỏng", "kim luon hong", "tắc kim", "tac kim"])


def _history_has_recent_iv_access(all_records: Sequence[Mapping[str, Any]], target_date: Optional[datetime], lookback_days: int) -> bool:
    if not all_records or not target_date:
        return False
    start = target_date - timedelta(days=lookback_days)
    for r in all_records:
        d = _record_date(r)
        if not d or not (start.date() <= d.date() < target_date.date()):
            continue
        blob = _record_blob([r])
        if includes_any(blob, ["KIM_LUON_TM", "kim luồn", "kim luon", "MEDCATH"]):
            return True
        # Nếu ngày trước vẫn có TMC/truyền dịch, coi như đường truyền còn đang được theo dõi trong cửa sổ 3–4 ngày.
        if _has_iv_trigger([r]):
            return True
    return False


def _add_daily_supplies(acc: Dict[str, Dict[str, Any]], records: Sequence[Mapping[str, Any]], dictionary: Mapping[str, Any]) -> None:
    for item in dictionary.get("dailySupplies") or []:
        if not isinstance(item, Mapping) or item.get("enabled") is False:
            continue
        key = str(item.get("key") or "").strip()
        qty = to_number(item.get("qty"), 1)
        reason = str(item.get("reason") or "VTYT nhập mỗi ngày")
        add_req(acc, key, qty, reason, category="daily", rule_id=str(item.get("id") or "daily"), dictionary=dictionary, alert=False)


def _add_keyword_supplies(acc: Dict[str, Dict[str, Any]], records: Sequence[Mapping[str, Any]], dictionary: Mapping[str, Any]) -> None:
    text = _record_blob(records)
    if includes_any(text, ["sonde tiểu", "đặt sonde tiểu", "foley", "thông tiểu"]):
        add_req(acc, "TUI_NUOC_TIEU", 1, "DVKT đặt sonde tiểu: túi nước tiểu", category="dvkt", rule_id="dvkt_urinary_catheter", dictionary=dictionary)
        add_req(acc, "SONDE_FOLEY_2_NHANH", 1, "DVKT đặt sonde tiểu: sonde Foley 2 nhánh", category="dvkt", rule_id="dvkt_urinary_catheter", dictionary=dictionary)
        add_req(acc, "BOM_TIEM_10ML", 1, "DVKT đặt sonde tiểu: bơm tiêm 10ml", category="dvkt", rule_id="dvkt_urinary_catheter", dictionary=dictionary)
    if includes_any(text, ["thở oxy", "tho oxy", "oxy"]):
        add_req(acc, "DAY_OXY", 1, "DVKT thở oxy: dây oxy", category="dvkt", rule_id="dvkt_oxygen", dictionary=dictionary)
    if includes_any(text, ["phun khí dung", "xông khí dung", "khi dung", "khí dung"]):
        add_req(acc, "MAT_NA_KHI_DUNG", 1, "DVKT khí dung: mặt nạ khí dung", category="dvkt", rule_id="dvkt_nebulizer", dictionary=dictionary)
    if includes_any(text, ["bơm rửa bàng quang", "rửa bàng quang"]):
        add_req(acc, "BOM_TIEM_50ML_CHO_AN", 1, "DVKT bơm/rửa bàng quang: bơm 50ml", category="dvkt", rule_id="dvkt_bladder_irrigation", dictionary=dictionary)
    if includes_any(text, ["sonde dạ dày", "đặt thông dạ dày", "ống thông dạ dày"]):
        add_req(acc, "BOM_TIEM_50ML_CHO_AN", 1, "DVKT sonde dạ dày: bơm 50ml", category="dvkt", rule_id="dvkt_gastric_tube", dictionary=dictionary)
        add_req(acc, "ONG_THONG_DA_DAY", 1, "DVKT sonde dạ dày: ống thông dạ dày", category="dvkt", rule_id="dvkt_gastric_tube", dictionary=dictionary)


def _add_surgery_supplies(acc: Dict[str, Dict[str, Any]], records: Sequence[Mapping[str, Any]], dictionary: Mapping[str, Any]) -> None:
    text = _record_blob(records)
    if not _has_surgery_text(records):
        return
    if includes_any(text, ["tay", "cẳng tay", "cánh tay", "bàn tay", "chân", "cẳng chân", "đùi", "bàn chân"]) and not includes_any(text, ["gãy xương đòn", "thay khớp háng"]):
        add_req(acc, "BANG_THUN_3_MOC", 1, "DVKT/phẫu thuật tay/chân: băng thun 3–4 ngày đầu", category="dvkt", rule_id="dvkt_postop_limb", dictionary=dictionary)
    if includes_any(text, ["lưng", "cột sống", "khớp háng", "háng", "thay băng", "vết mổ"]):
        add_req(acc, "BANG_DINH_250X90", 1, "DVKT/phẫu thuật vết mổ: băng dính 250x90", category="dvkt", rule_id="dvkt_wound_dressing", dictionary=dictionary)
    if includes_any(text, ["nội soi", "noi soi", "nội soi khớp", "arthroscopy"]):
        add_req(acc, "BANG_DINH_60X70", 2, "DVKT mổ nội soi: băng dính 6x7", category="dvkt", rule_id="dvkt_laparoscopy", dictionary=dictionary)


def _add_custom_rule_supplies(acc: Dict[str, Dict[str, Any]], records: Sequence[Mapping[str, Any]], all_records: Sequence[Mapping[str, Any]], target_date: Optional[datetime], dictionary: Mapping[str, Any]) -> None:
    current_text = _record_blob(records)
    infusions, injections, all_meds = _collect_meds(records)
    meds = [*infusions, *injections, *all_meds]
    for rule in dictionary.get("customRules") or []:
        if not isinstance(rule, Mapping) or rule.get("enabled") is False:
            continue
        category = str(rule.get("category") or "medication").strip().lower()
        matchers = rule.get("match") or rule.get("keywords") or []
        rule_id = str(rule.get("id") or "custom")
        supplies = [x for x in (rule.get("supplies") or []) if isinstance(x, Mapping)]
        if not supplies:
            continue
        if category == "daily":
            applies = not matchers or includes_any(current_text, matchers) or "*" in matchers
            if not applies:
                continue
            for sup in supplies:
                add_req(acc, str(sup.get("key") or ""), to_number(sup.get("qty"), 1), str(rule.get("reason") or "Custom daily VTYT"), category="daily", rule_id=rule_id, dictionary=dictionary, alert=bool(sup.get("alert", False)))
        elif category == "medication":
            for med in meds:
                if not includes_any(item_text(med), matchers):
                    continue
                for sup in supplies:
                    per_dose = sup.get("perDose", rule.get("perDose", True)) is not False
                    dose = get_dose_count(med) if per_dose else 1
                    add_req(acc, str(sup.get("key") or ""), to_number(sup.get("qty"), 1) * dose, str(rule.get("reason") or "Custom medication VTYT"), {"raw": item_text(med)[:220]}, category="medication", rule_id=rule_id, dictionary=dictionary)
        elif category == "dvkt":
            if not includes_any(current_text, matchers):
                continue
            for sup in supplies:
                add_req(acc, str(sup.get("key") or ""), to_number(sup.get("qty"), 1), str(rule.get("reason") or "Custom DVKT VTYT"), category="dvkt", rule_id=rule_id, dictionary=dictionary)
        elif category == "interval":
            if not includes_any(current_text, matchers):
                continue
            lookback = int(to_number(rule.get("lookbackDays"), 4))
            recent = _history_has_recent_iv_access(all_records, target_date, lookback) if "kim" in norm(json.dumps(supplies, ensure_ascii=False)) else False
            if recent and not rule.get("forceWhenMatched"):
                continue
            for sup in supplies:
                add_req(acc, str(sup.get("key") or ""), to_number(sup.get("qty"), 1), str(rule.get("reason") or f"Custom interval VTYT, đã nhìn lại {lookback} ngày"), category="interval", rule_id=rule_id, dictionary=dictionary, needs_review=not bool(all_records))


def build_required_supplies(
    records: Sequence[Mapping[str, Any]],
    *,
    config: Optional[Mapping[str, Any]] = None,
    all_records: Optional[Sequence[Mapping[str, Any]]] = None,
    target_date: Optional[str] = None,
) -> List[Dict[str, Any]]:
    dictionary = load_vtyt_dictionary(config)
    cfg = dictionary["quantityConfig"]
    acc: Dict[str, Dict[str, Any]] = {}
    records = [r for r in records if isinstance(r, Mapping)]
    history_records = [r for r in (all_records or records) if isinstance(r, Mapping)]
    target_dt = _parse_dmy(target_date or "") or next((_record_date(r) for r in records if _record_date(r)), None)
    patient_age = max([int(to_number(r.get("tuoi") or r.get("age"), 0)) for r in records] or [0])

    _add_daily_supplies(acc, records, dictionary)

    infusions, injections, all_meds = _collect_meds(records)
    has_tmc_or_infusion = bool(infusions)

    infusion_sets = _count_new_infusion_sets(records, history_records, target_dt, int(cfg.get("infusionContinuityGapMinutes", 180)))
    if infusion_sets > 0:
        add_req(
            acc, "DAY_TRUYEN_DICH", infusion_sets,
            "Có dịch/thuốc truyền: dây truyền tính theo phiên truyền liên tục; không tính thêm nếu y lệnh mới còn dùng cùng dây",
            {"session_count": infusion_sets}, category="medication", rule_id="med_infusion_continuity", dictionary=dictionary,
        )

    for item in injections:
        dose = get_dose_count(item)
        raw = item_text(item)
        if is_tmc_item(item):
            has_tmc_or_infusion = True
            if is_antibiotic(raw, dictionary):
                add_req(acc, "BOM_TIEM_20ML", dose * cfg["antibioticTmcSyringe20mlPerDose"], "Kháng sinh TMC: bơm tiêm 20ml mỗi cử", {"raw": raw[:220]}, category="medication", rule_id="med_tmc_antibiotic", dictionary=dictionary)
                add_req(acc, "KIM_TIEM_PHA", dose * cfg["mixingNeedlePerDose"], "Kháng sinh TMC: kim pha mỗi cử", {"raw": raw[:220]}, category="medication", rule_id="med_tmc_antibiotic", dictionary=dictionary)
            else:
                add_req(acc, "BOM_TIEM_10ML", dose * cfg["otherTmcSyringe10mlPerDose"], "Thuốc TMC khác: bơm tiêm 10ml mỗi cử", {"raw": raw[:220]}, category="medication", rule_id="med_tmc_other", dictionary=dictionary)
                add_req(acc, "KIM_TIEM_PHA", dose * cfg["mixingNeedlePerDose"], "Thuốc TMC khác: kim pha mỗi cử", {"raw": raw[:220]}, category="medication", rule_id="med_tmc_other", dictionary=dictionary)
        if is_im_item(item):
            add_req(acc, "BOM_TIEM_5ML", dose * cfg["imSyringe5mlPerDose"], "Tiêm bắp: bơm tiêm 5ml mỗi cử", {"raw": raw[:220]}, category="medication", rule_id="med_im", dictionary=dictionary)
            add_req(acc, "KIM_TIEM_PHA", dose * cfg["mixingNeedlePerDose"], "Tiêm bắp: kim pha mỗi cử", {"raw": raw[:220]}, category="medication", rule_id="med_im", dictionary=dictionary)
        if is_mixed_with_nacl(item, all_meds):
            add_req(acc, "BOM_TIEM_10ML", dose * cfg["naclMixSyringe10mlPerDose"], "Thuốc pha NaCl: bơm tiêm 10ml mỗi cử", {"raw": raw[:220]}, category="medication", rule_id="med_mix_nacl", dictionary=dictionary)
            add_req(acc, "KIM_TIEM_PHA", dose * cfg["mixingNeedlePerDose"], "Thuốc pha NaCl: kim pha mỗi cử", {"raw": raw[:220]}, category="medication", rule_id="med_mix_nacl", dictionary=dictionary)

    if has_tmc_or_infusion:
        add_req(acc, "NUT_KIM_LUON_OR_KHOA_3_NGA", cfg["ivCatheterPlugPerDay"], "Có TMC/truyền dịch: nút/khóa kim luồn theo ngày có đường truyền", category="daily", rule_id="daily_iv_plug", dictionary=dictionary)
        lookback = int(cfg.get("ivCatheterLookbackDays", 4))
        has_history = bool(history_records and target_dt and len([r for r in history_records if _record_date(r) and _record_date(r).date() < target_dt.date()]) > 0)
        recent_line = _history_has_recent_iv_access(history_records, target_dt, lookback)
        explicit_change = _has_explicit_iv_change(records)
        if explicit_change or not recent_line:
            iv_qty = cfg["ivCatheterAge55PlusQuantity"] if patient_age >= 55 else cfg["ivCatheterDefaultQuantity"]
            needs_review = bool(all_records is not None and not has_history and not explicit_change)
            input_allowed = not needs_review
            reason = "Kim luồn cách khoảng 3–4 ngày: " + ("có y lệnh đặt/thay kim luồn" if explicit_change else f"không thấy kim luồn/TMC-truyền dịch trong {lookback} ngày trước")
            if needs_review:
                reason += "; thiếu dữ liệu lịch sử nên cần kiểm lại trước khi nhập"
            add_req(acc, "KIM_LUON_TM", iv_qty, reason, category="interval", rule_id="interval_iv_catheter", dictionary=dictionary, input_allowed=input_allowed, needs_review=needs_review)
            add_req(acc, "BANG_DINH_KIM_LUON", iv_qty, "Băng dính kim luồn đi kèm lần đặt/thay kim luồn", category="interval", rule_id="interval_iv_catheter", dictionary=dictionary, input_allowed=input_allowed, needs_review=needs_review)

    _add_keyword_supplies(acc, records, dictionary)
    _add_surgery_supplies(acc, records, dictionary)
    _add_custom_rule_supplies(acc, records, history_records, target_dt, dictionary)

    return sorted(acc.values(), key=lambda x: (x.get("category", ""), x["name"], x["key"]))


def _dmy_key(value: Any) -> str:
    dt = _parse_dmy(value)
    return dt.strftime("%d/%m/%Y") if dt else ""


def _dmy_next(value: Any) -> str:
    dt = _parse_dmy(value)
    return (dt + timedelta(days=1)).strftime("%d/%m/%Y") if dt else ""


def _row_has_order_payload(row: Mapping[str, Any]) -> bool:
    hay = " ".join(str(row.get(k) or "") for k in ("y_lenh", "Y lệnh", "dien_bien", "Diễn biến"))
    if hay.strip():
        return True
    ncs = row.get("nhap_cham_soc")
    if isinstance(ncs, Mapping) and (ncs.get("y_lenh") or ncs.get("dien_bien")):
        return True
    for key in ("thuoc", "dich_truyen", "thuoc_tiem", "raw_order_events"):
        val = row.get(key)
        if isinstance(val, list) and val:
            return True
    return False


def _exit_date_from_row(row: Mapping[str, Any]) -> str:
    # Ưu tiên ngày ra viện rõ ràng; nếu chỉ có field ngày ra dạng ISO/DMY thì chuẩn hóa về DMY.
    for key in ("ngay_ra_vien", "ngay_ra_vien_date", "ngay_ra", "ngay_chuyen_khoa"):
        d = _dmy_key(row.get(key))
        if d:
            return d
    text = " ".join(str(row.get(k) or "") for k in ("gio_ra_vien", "thoi_gian_ra", "thoi_gian_ra_vien", "xu_tri", "Xử trí"))
    m = re.search(r"(\d{1,2}[/-]\d{1,2}[/-]\d{2,4})", text)
    if m:
        return _dmy_key(m.group(1))
    return ""


def _augment_next_day_vtyt_dates(out: Dict[str, set], processed_rows: Sequence[Mapping[str, Any]]) -> None:
    """Nếu ca ra/chuyển khoa vào ngày mai và file đã có y lệnh ngày mai, tự thêm ngày đó cho VTYT.

    Đây chỉ mở rộng thêm đúng +1 ngày kế tiếp của ngày đã chọn, không tự kéo cả đợt điều trị.
    """
    if not out:
        return
    rows_by_pid: Dict[str, List[Mapping[str, Any]]] = defaultdict(list)
    for row in processed_rows or []:
        if not isinstance(row, Mapping):
            continue
        pid = str(row.get("ma_bn") or row.get("id") or "").strip()
        if pid in out:
            rows_by_pid[pid].append(row)
    for pid, selected in out.items():
        if not selected:
            continue
        rows = rows_by_pid.get(pid) or []
        dates_with_orders = {_dmy_key(r.get("ngay_lam") or r.get("date") or r.get("ngay_y_lenh")) for r in rows if _row_has_order_payload(r)}
        dates_with_orders.discard("")
        add_dates = set()
        for d in list(selected):
            nd = _dmy_next(d)
            if not nd or nd not in dates_with_orders:
                continue
            # Chỉ tự thêm ngày mai nếu có dấu hiệu ra/chuyển khoa trùng ngày mai,
            # hoặc ngày mai đã có record của chính BN trong file phân loại.
            has_exit_tomorrow = any(_exit_date_from_row(r) == nd for r in rows)
            if has_exit_tomorrow:
                add_dates.add(nd)
        if add_dates:
            selected.update(add_dates)


def selected_patient_dates(targets: Mapping[str, Any], processed_rows: Sequence[Mapping[str, Any]]) -> Dict[str, set]:
    ids = [str(x or "").strip() for x in (targets.get("patientIds") or []) if str(x or "").strip()]
    patient_dates_raw = targets.get("patientDates") if isinstance(targets.get("patientDates"), Mapping) else {}
    selected_dates = [str(x or "").strip() for x in (targets.get("selectedDates") or []) if str(x or "").strip()]
    out: Dict[str, set] = {pid: set() for pid in ids}
    for pid in ids:
        ds = patient_dates_raw.get(pid) if patient_dates_raw else []
        if isinstance(ds, list) and ds:
            out[pid].update(str(x or "").strip() for x in ds if str(x or "").strip())
        elif selected_dates:
            out[pid].update(selected_dates)
    for row in processed_rows:
        pid = str(row.get("ma_bn") or row.get("id") or "").strip()
        if pid in out and not out[pid]:
            date = str(row.get("ngay_lam") or "").strip()
            if date:
                out[pid].add(date)
    _augment_next_day_vtyt_dates(out, processed_rows)
    return out


def group_records_for_targets(processed_rows: Sequence[Mapping[str, Any]], targets: Mapping[str, Any]) -> Dict[Tuple[str, str], List[Mapping[str, Any]]]:
    wanted = selected_patient_dates(targets, processed_rows)
    grouped: Dict[Tuple[str, str], List[Mapping[str, Any]]] = defaultdict(list)
    for row in processed_rows:
        pid = str(row.get("ma_bn") or row.get("id") or "").strip()
        date = str(row.get("ngay_lam") or "").strip()
        if not pid or not date or pid not in wanted or date not in wanted[pid]:
            continue
        grouped[(pid, date)].append(row)
    return grouped


def _patient_history(processed_rows: Sequence[Mapping[str, Any]], pid: str, date: str) -> List[Mapping[str, Any]]:
    target_dt = _parse_dmy(date)
    rows: List[Mapping[str, Any]] = []
    for row in processed_rows:
        row_pid = str(row.get("ma_bn") or row.get("id") or "").strip()
        if row_pid != pid:
            continue
        d = _record_date(row)
        if target_dt and d and d.date() > target_dt.date():
            continue
        rows.append(row)
    return rows


def build_vtyt_jobs(processed_rows: Sequence[Mapping[str, Any]], targets: Mapping[str, Any]) -> List[Dict[str, Any]]:
    jobs = []
    grouped = group_records_for_targets(processed_rows, targets)
    for (pid, date), records in sorted(grouped.items(), key=lambda x: (x[0][1], x[0][0])):
        if not records:
            continue
        history = _patient_history(processed_rows, pid, date)
        supplies = build_required_supplies(records, all_records=history, target_date=date)
        if not supplies:
            continue
        first = records[0]
        review_items = [x for x in supplies if x.get("needs_review") or x.get("input_allowed") is False]
        jobs.append({
            "key": f"{pid}::{date}",
            "ma_bn": pid,
            "ngay_lam": date,
            "ho_ten": first.get("ho_ten") or first.get("Họ tên") or "",
            "so_phong": first.get("so_phong") or first.get("Vi_Tri") or "",
            "tg_vao": first.get("thoi_gian_vao_khoa") or first.get("tg_vao") or first.get("T/G vào") or "",
            "thoi_gian_vao_khoa": first.get("thoi_gian_vao_khoa") or first.get("tg_vao") or first.get("T/G vào") or "",
            "khoa_chuyen_den": first.get("ten_khoa_dieu_tri") or first.get("khoa_dieu_tri") or first.get("khoa_chuyen_den") or first.get("Khoa chuyển đến") or "",
            "khoa_dieu_tri": first.get("ten_khoa_dieu_tri") or first.get("khoa_dieu_tri") or first.get("khoa_chuyen_den") or first.get("Khoa chuyển đến") or "",
            "ten_khoa_dieu_tri": first.get("ten_khoa_dieu_tri") or first.get("khoa_dieu_tri") or first.get("khoa_chuyen_den") or first.get("Khoa chuyển đến") or "",
            "ngay_ra_vien": first.get("ngay_ra_vien") or "",
            "ngay_ra_vien_date": first.get("ngay_ra_vien_date") or "",
            "gio_ra_vien": first.get("gio_ra_vien") or "",
            "ra_vien_hom_nay": bool(first.get("ra_vien_hom_nay")),
            "supplies": supplies,
            "review_items": review_items,
            "record_count": len(records),
        })
    return jobs


__all__ = [
    "CATALOG", "DEFAULT_QUANTITY_CONFIG", "norm", "includes_any", "get_dose_count",
    "load_vtyt_dictionary", "build_required_supplies", "build_vtyt_jobs", "group_records_for_targets",
]
