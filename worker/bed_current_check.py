# -*- coding: utf-8 -*-
"""Đọc buồng giường hiện tại cho 1 người bệnh.

Chỉ đọc dữ liệu: mở hồ sơ, bấm tab/nút Buồng giường (#btnBG/onShowBuongGiuong),
parse #vertical-timeline và xuất JSON. Không bấm các nút ghi/sửa/xác nhận.
"""
import argparse
import json
import os
import re
import sys
import time
import unicodedata
from datetime import datetime
from typing import Any, Dict, List, Optional

from utils import login_emr, load_config
from shared.worker_session import WorkerSession
from main_worker import AutoWorker, _build_inpatient_url, _debug_page, clean_name, normalize_room_code

try:
    from bs4 import BeautifulSoup
except ModuleNotFoundError:  # pragma: no cover
    BeautifulSoup = None  # type: ignore

try:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
except ModuleNotFoundError:  # pragma: no cover
    By = WebDriverWait = EC = None  # type: ignore

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass

CTCH_TK_DOCTORS = [
    "Nguyễn Thành Tấn",
    "Nguyễn Lê Hoan",
    "Nguyễn Chí Nguyện",
    "Hồ Điền",
    "Trần Quốc Toản",
    "Phạm Việt Tân",
    "Phan Văn Tuấn",
    "Trần Quang Sơn",
    "Nguyễn Tư Thái Bảo",
    "Trần Nguyễn Anh Duy",
    "Nguyễn Giang Tử",
]

ROOM_DOCTOR_MAP = {
    "P01": "Trần Nguyễn Anh Duy",
    "P02": "Trần Nguyễn Anh Duy",
    "P03": "Trần Quang Sơn",
    "P04": "Trần Quang Sơn",
    "P05": "Nguyễn Tư Thái Bảo",
    "P06": "Nguyễn Tư Thái Bảo",
    "P07": "Nguyễn Tư Thái Bảo",
    "P08": "Hồ Điền",
    "P09": "Trần Quốc Toản",
    "P10": "Nguyễn Chí Nguyện",
    "P11": "Phạm Việt Tân",
}


def _norm_text(value: Any) -> str:
    text = str(value or "").strip().lower()
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    text = text.replace("đ", "d")
    return re.sub(r"\s+", " ", text).strip()


def _is_ctch_tk_doctor(name: Any) -> bool:
    return _norm_text(name) in {_norm_text(x) for x in CTCH_TK_DOCTORS}


def _field(text: str, pattern: str) -> str:
    m = re.search(pattern, text or "", flags=re.IGNORECASE | re.DOTALL)
    return re.sub(r"\s+", " ", m.group(1)).strip() if m else ""


def _parse_dt(value: Any) -> Optional[datetime]:
    m = re.search(r"(\d{1,2}):(\d{2})\s+(\d{1,2})/(\d{1,2})/(\d{4})", str(value or ""))
    if not m:
        return None
    try:
        return datetime(int(m.group(5)), int(m.group(4)), int(m.group(3)), int(m.group(1)), int(m.group(2)))
    except Exception:
        return None


def _extract_room_name(h2: str) -> str:
    parts = str(h2 or "").split("|")
    if len(parts) < 2:
        return ""
    return re.sub(r"\([^)]*\)", "", parts[1]).strip()


def _room_norm(phong: str, ma_giuong: str = "") -> str:
    # Ưu tiên số phòng trong cụm “... - 10”. Nếu không có thì lấy từ mã giường K24.10.02.H030.
    m = re.search(r"[-–]\s*0*(\d{1,2})\s*$", str(phong or ""))
    if m:
        return f"P{int(m.group(1)):02d}"
    bed_parts = str(ma_giuong or "").split(".")
    if len(bed_parts) >= 2 and bed_parts[1].isdigit():
        return f"P{int(bed_parts[1]):02d}"
    return normalize_room_code(phong or ma_giuong)


def _bed_blocks(timeline: Any) -> List[Any]:
    rows = []
    for child in getattr(timeline, "children", []) or []:
        try:
            classes = child.get("class") or []
            if "row" in classes and child.find("h2"):
                rows.append(child)
        except Exception:
            pass
    if rows:
        return rows
    return timeline.find_all("div", class_="row") if timeline else []


def parse_bed_timeline(html: str) -> List[Dict[str, Any]]:
    if BeautifulSoup is None:
        raise RuntimeError("Thiếu thư viện bs4. Hãy cài: pip install beautifulsoup4")
    soup = BeautifulSoup(html or "", "html.parser")
    timeline = soup.find(id="vertical-timeline")
    if not timeline:
        return []

    result: List[Dict[str, Any]] = []
    for idx, block in enumerate(_bed_blocks(timeline)):
        h2_el = block.find("h2")
        if not h2_el:
            continue
        text = block.get_text("\n", strip=True)
        flat = re.sub(r"\s+", " ", text).strip()
        h2 = h2_el.get_text(" ", strip=True)
        p_el = block.find("p")
        p = p_el.get_text(" ", strip=True) if p_el else ""
        ma_giuong = _field(h2, r"Giường\s*([^|]+)")
        phong = _extract_room_name(h2)
        phong_norm = _room_norm(phong, ma_giuong)
        nguoi_chi_dinh = _field(flat, r"Người\s+chỉ\s+định:\s*(.*?)\s*Loại:")
        expected = ROOM_DOCTOR_MAP.get(phong_norm, "")
        doctor_matches = (not expected) or (not nguoi_chi_dinh) or (_norm_text(expected) == _norm_text(nguoi_chi_dinh))
        trang_thai = _field(flat, r"Trạng\s*thái:\s*(.*?)\s*Từ:")

        result.append({
            "index": idx,
            "trang_thai": trang_thai,
            "is_current": "dang thuc hien" in _norm_text(trang_thai),
            "tu": _field(flat, r"Từ:\s*([0-9: ]+\d{1,2}/\d{1,2}/\d{4})"),
            "den": _field(flat, r"Đến:\s*([0-9: ]+\d{1,2}/\d{1,2}/\d{4})"),
            "nguoi_chi_dinh": nguoi_chi_dinh,
            "loai_nam": _field(flat, r"Loại:\s*(.*?)(?:\s*Giường|$)"),
            "ma_giuong": ma_giuong,
            "phong": phong,
            "phong_norm": phong_norm,
            "khoa": _field(h2, r"\(([^)]+)\)"),
            "ten_dich_vu_giuong": (p.split("|")[0] or "").strip(),
            "mo_ta_day_du": p,
            "is_ctch_tk_doctor": _is_ctch_tk_doctor(nguoi_chi_dinh),
            "expected_doctor_by_room": expected,
            "doctor_matches_room": doctor_matches,
        })
    return result


def get_current_bed(timeline: List[Dict[str, Any]]) -> Optional[Dict[str, Any]]:
    active = [x for x in timeline if x.get("is_current")]
    rows = active or list(timeline)
    if not rows:
        return None
    return sorted(rows, key=lambda x: (_parse_dt(x.get("tu")) or datetime.min), reverse=True)[0]


def build_checks(timeline: List[Dict[str, Any]]) -> Dict[str, Any]:
    current = get_current_bed(timeline)
    warnings: List[str] = []
    if not timeline:
        warnings.append("Không đọc được timeline buồng giường.")
    if not current:
        warnings.append("Không xác định được giường hiện tại.")
    else:
        if not current.get("is_current"):
            warnings.append("Không thấy dòng trạng thái Đang thực hiện; đang lấy dòng mới nhất làm tạm thời.")
        if not current.get("phong_norm"):
            warnings.append("Không xác định được số phòng từ thông tin buồng giường.")
        if not current.get("nguoi_chi_dinh"):
            warnings.append("Thiếu người chỉ định buồng giường.")
        elif not current.get("is_ctch_tk_doctor"):
            warnings.append(f"Người chỉ định không nằm trong danh sách bác sĩ CTCH-TK: {current.get('nguoi_chi_dinh')}.")
        if current.get("expected_doctor_by_room") and current.get("nguoi_chi_dinh") and not current.get("doctor_matches_room"):
            warnings.append(
                f"Phòng {current.get('phong_norm')}: bác sĩ phụ trách dự kiến là {current.get('expected_doctor_by_room')}, "
                f"nhưng người chỉ định là {current.get('nguoi_chi_dinh')}."
            )
    return {
        "status": "warning" if warnings else "ok",
        "current": current,
        "timeline_count": len(timeline),
        "warnings": warnings,
    }


def click_bed_button(driver: Any) -> bool:
    candidates = [
        (By.ID, "btnBG"),
        (By.CSS_SELECTOR, "#btnBG"),
        (By.XPATH, "//a[contains(@onclick,'onShowBuongGiuong') or contains(normalize-space(), 'Buồng giường')]"),
    ]
    last_err: Optional[Exception] = None
    for by, value in candidates:
        try:
            el = WebDriverWait(driver, 8).until(EC.element_to_be_clickable((by, value)))
            driver.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
            time.sleep(0.2)
            driver.execute_script("arguments[0].click();", el)
            WebDriverWait(driver, 15).until(
                lambda d: (
                    "vertical-timeline" in (d.page_source or "")
                    or "Thông tin buồng giường" in (d.page_source or "")
                    or "tabGiuongInfo" in (d.page_source or "")
                )
            )
            time.sleep(0.5)
            return True
        except Exception as exc:
            last_err = exc
    print(f"LOG: Không mở được tab Buồng giường: {last_err}")
    return False


def patient_id(row: Dict[str, Any]) -> str:
    return str(row.get("ma_bn") or row.get("Mã BN") or row.get("Mã YT") or row.get("id") or "").strip()


def run(input_path: str, out_path: str) -> None:
    config = load_config()
    with open(input_path, "r", encoding="utf-8") as f:
      rows = json.load(f)
    if not isinstance(rows, list) or not rows:
        raise RuntimeError("Input phải là danh sách có ít nhất 1 người bệnh.")
    row = rows[0] or {}
    ma_bn = patient_id(row)
    if not ma_bn:
        raise RuntimeError("Thiếu mã bệnh nhân.")

    worker = AutoWorker()
    _ws = WorkerSession(worker.config, "/dev/null")
    _ws.__enter__()
    worker.driver, worker.wait = _ws.driver, _ws.wait
    try:
        nav_url = _build_inpatient_url(worker.driver.current_url, worker.config.get("inpatient_wpid", "danhsachdieutrinoitrudraw"))
        print(f"[BED] Chuyển đến danh sách nội trú: {nav_url}")
        worker.driver.get(nav_url)
        WebDriverWait(worker.driver, 15).until(EC.presence_of_element_located((By.ID, "txtTimKiem")))

        denngay = datetime.now().strftime("%d/%m/%Y")
        if not worker._search_and_open_patient(ma_bn, denngay=denngay, row=row):
            raise RuntimeError(f"Không mở được hồ sơ người bệnh {ma_bn}.")
        if not click_bed_button(worker.driver):
            _debug_page(worker.driver, f"bed_cannot_open_{ma_bn}")
            raise RuntimeError("Không mở được tab/nút Buồng giường (#btnBG).")

        timeline = parse_bed_timeline(worker.driver.page_source or "")
        checks = build_checks(timeline)
        output = {
            "status": "ok",
            "checked_at": datetime.now().isoformat(timespec="seconds"),
            "patient": {
                "ma_bn": ma_bn,
                "ho_ten": clean_name(row.get("ho_ten") or row.get("Họ tên") or ""),
                "so_phong": row.get("so_phong") or row.get("Vi_Tri") or row.get("phong_giuong") or "",
            },
            "current_bed": checks.get("current"),
            "bed_timeline": timeline,
            "checks": checks,
        }
        with open(out_path, "w", encoding="utf-8") as f:
            json.dump(output, f, ensure_ascii=False, indent=2)
        cur = output.get("current_bed") or {}
        print(f"SUCCESS: Đọc buồng giường hiện tại BN {ma_bn}: {cur.get('ma_giuong') or '-'} | {cur.get('phong') or '-'}")
    finally:
        try:
            _ws.__exit__(None, None, None)
        except Exception:
            pass


def main() -> None:
    p = argparse.ArgumentParser()
    p.add_argument("--input", required=True)
    p.add_argument("--out", required=True)
    args = p.parse_args()
    run(args.input, args.out)


if __name__ == "__main__":
    main()
