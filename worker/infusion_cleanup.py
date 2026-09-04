# -*- coding: utf-8 -*-
"""Scanning and cleanup helpers for infusion records in EMR modal."""
import re
import time
from datetime import datetime
try:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support import expected_conditions as EC
except ModuleNotFoundError:  # Cho phép test các helper chuẩn hóa/so khớp khi chưa cài Selenium.
    By = EC = None  # type: ignore

from utils import strip_accents
from input_infusions_utils import _log, _norm_text
from infusion_select2 import _norm_staff_key

def _norm_med_key(s: str) -> str:
    """Chuẩn hoá tên dịch truyền để so khớp (giảm lỗi do khoảng trắng, dấu câu, dấu tiếng Việt)."""
    s = strip_accents((s or "").lower())
    s = re.sub(r'\(\s*\d+(?:[\.,]\d+)?\s*ml\s*\)\s*$', '', s, flags=re.IGNORECASE)
    s = re.sub(r'\b\d+(?:[\.,]\d+)?\s*ml\s*$', '', s, flags=re.IGNORECASE)
    s = s.replace(",", ".")
    s = re.sub(r"[\t\r\n]+", " ", s)
    # Đồng nhất các cách viết dung môi thường gặp để tránh coi cùng một thuốc pha
    # là hai key khác nhau (ví dụ "natri clorid", "natriclorid", "NaCl").
    s = re.sub(r"\bsodium\s*chloride\b", "nacl", s)
    s = re.sub(r"\bnatri\s*clorid\b", "nacl", s)
    s = re.sub(r"\bnatriclorid\b", "nacl", s)
    s = re.sub(r"\bna\s*cl\b", "nacl", s)
    # giữ lại chữ/số và một số ký tự thường gặp trong tên thuốc
    s = re.sub(r"[^0-9a-zA-Z+/% .-]", " ", s)
    s = re.sub(r"\s+", " ", s).strip()
    # chuẩn hoá dấu +
    s = re.sub(r"\s*\+\s*", "+", s)
    return s

def _norm_med_base(s: str) -> str:
    """Lay loi ten thuoc de so khop mem khi EMR doi ham luong."""
    t = _norm_med_key(s)
    t = re.sub(r"\btt\b", " ", t)
    t = re.sub(r"\b\d+(?:[\.,]\d+)?\s*(mg|mcg|g|gram|ml|iu|ui|%)\s*(?:/\s*(ml|g|mg))?\b", " ", t)
    t = re.sub(r"\b\d+(?:[\.,]\d+)?\s*(chai|lo|ong|vien|goi|amp|tube|flacon)\b", " ", t)
    t = re.sub(r"[^0-9a-zA-Z+/% .-]", " ", t)
    t = re.sub(r"\s+", " ", t).strip()
    return t

def _norm_time_str(s: str) -> str:
    """Chuẩn hóa chuỗi giờ theo %H:%M %d/%m/%Y nếu parse được."""
    s = (s or "").strip()
    if not s:
        return ""
    for fmt in ("%H:%M %d/%m/%Y", "%H:%M %d/%m/%y", "%H:%M %d-%m-%Y", "%H:%M %d-%m-%y"):
        try:
            dt = datetime.strptime(s, fmt)
            return dt.strftime("%H:%M %d/%m/%Y")
        except Exception:
            pass
    # trường hợp thiếu số 0 (ví dụ 8:00 2/2/2026)
    try:
        m = re.match(r"^(\d{1,2}):(\d{2})\s+(\d{1,2})/(\d{1,2})/(\d{4})$", s)
        if m:
            h, mi, d, mo, y = map(int, m.groups())
            dt = datetime(y, mo, d, h, mi)
            return dt.strftime("%H:%M %d/%m/%Y")
    except Exception:
        pass
    return s

def _int_from_text(s: str, default=0) -> int:
    s = (s or "").strip()
    m = re.search(r"(\d+)", s)
    if not m:
        return default
    try:
        return int(m.group(1))
    except Exception:
        return default

def _get_total_pages_in_modal(driver):
    """Nhận biết số trang của bảng phiếu truyền dịch.

    Hỗ trợ:
      - DataTables paginate div (id dạng <tableId>_paginate)
      - ul.pagination + a.currentPaging dạng "Trang 1/3"
      - ul.pagination thường (đếm link số)
    """
    # 1) DataTables paginate div thường có id: <tableId>_paginate
    candidates = [
        "TablePhieuTruyenDich_paginate",
        "TablePTD_paginate",
        "tblPhieuTruyenDich_paginate",
        "tablePhieuTruyenDich_paginate",
        "tblKeHoachDinhDuong_paginate",
    ]
    for cid in candidates:
        try:
            paginate = driver.find_element(By.ID, cid)
            page_links = paginate.find_elements(
                By.XPATH,
                ".//a[normalize-space(text())!='' and not(contains(@class,'previous')) and not(contains(@class,'next'))]"
            )
            nums = []
            for a in page_links:
                t = (a.text or "").strip()
                if t.isdigit():
                    nums.append(int(t))
            if nums:
                return max(nums)
        except Exception:
            pass

    # helper: tìm ul.pagination liên quan nhất
    def _find_pagination_ul():
        xps = [
            "//table[@id='tblKeHoachDinhDuong']/following::ul[contains(@class,'pagination')][1]",
            "//tbody[@id='TableContentPhieuTruyenDich']/ancestor::div[1]//ul[contains(@class,'pagination')]",
            "//ul[contains(@class,'pagination')]",
        ]
        for xp in xps:
            try:
                ul = driver.find_element(By.XPATH, xp)
                return ul
            except Exception:
                continue
        return None

    ul = _find_pagination_ul()
    if ul is None:
        return 1

    # 2) Có currentPaging: "Trang 1/3"
    try:
        cur = ul.find_element(By.XPATH, ".//a[contains(@class,'currentPaging')]")
        txt = (cur.text or "").strip()
        m = re.search(r"Trang\s*(\d+)\s*/\s*(\d+)", txt, flags=re.IGNORECASE)
        if m:
            return int(m.group(2))
    except Exception:
        pass

    # 3) Đếm link số trong ul.pagination
    try:
        links = ul.find_elements(By.XPATH, ".//a[normalize-space(text())!='']")
        nums = []
        for a in links:
            t = (a.text or "").strip()
            if t.isdigit():
                nums.append(int(t))
        if nums:
            return max(nums)
    except Exception:
        pass

    return 1

def _goto_page_in_modal(driver, wait, page_num: int):
    """Chuyển trang trong bảng phiếu truyền dịch (nếu có).

    Với HTML kiểu:
      <a href="javascript:NextPagePhieuTruyenDich(1);">2</a>
    thì page_num là 1-based, hàm JS nhận 0-based.
    """
    if page_num <= 1:
        # cố gắng về trang 1 bằng JS nếu có (để ổn định trước khi scan)
        try:
            has_js = driver.execute_script("return typeof NextPagePhieuTruyenDich === 'function';")
            if has_js:
                driver.execute_script("NextPagePhieuTruyenDich(arguments[0]);", 0)
        except Exception:
            pass
        return True

    def _first_row_sig():
        try:
            row = driver.find_element(By.XPATH, "//tbody[@id='TableContentPhieuTruyenDich']/tr[1]")
            try:
                return (row.find_element(By.CSS_SELECTOR, "input.chkAddBn").get_attribute("value") or "").strip()
            except Exception:
                return (row.text or "").strip()
        except Exception:
            return ""

    def _current_page_from_ul():
        try:
            ul = driver.find_element(By.XPATH, "//table[@id='tblKeHoachDinhDuong']/following::ul[contains(@class,'pagination')][1]")
        except Exception:
            try:
                ul = driver.find_element(By.XPATH, "//ul[contains(@class,'pagination')]")
            except Exception:
                return None
        try:
            cur = ul.find_element(By.XPATH, ".//a[contains(@class,'currentPaging')]")
            txt = (cur.text or "").strip()
            m = re.search(r"Trang\s*(\d+)\s*/\s*(\d+)", txt, flags=re.IGNORECASE)
            if m:
                return int(m.group(1))
        except Exception:
            pass
        return None

    before = _first_row_sig()

    # ưu tiên gọi JS nếu có
    try:
        has_js = driver.execute_script("return typeof NextPagePhieuTruyenDich === 'function';")
    except Exception:
        has_js = False

    if has_js:
        try:
            driver.execute_script("NextPagePhieuTruyenDich(arguments[0]);", int(page_num) - 1)
        except Exception:
            has_js = False

    if not has_js:
        # click link số trong ul.pagination
        xps = [
            f"//table[@id='tblKeHoachDinhDuong']/following::ul[contains(@class,'pagination')][1]//a[normalize-space(text())='{page_num}']",
            f"//ul[contains(@class,'pagination')]//a[normalize-space(text())='{page_num}']",
        ]
        clicked = False
        for xp in xps:
            try:
                btn = wait.until(EC.element_to_be_clickable((By.XPATH, xp)))
                driver.execute_script("arguments[0].click();", btn)
                clicked = True
                break
            except Exception:
                continue
        if not clicked:
            return False

    # chờ table đổi / trang đổi
    try:
        wait.until(lambda d: (d.find_element(By.XPATH, "//tbody[@id='TableContentPhieuTruyenDich']").text or "").strip() != "")
    except Exception:
        pass

    try:
        # nếu có currentPaging thì ưu tiên chờ đúng trang
        wait.until(lambda d: (_current_page_from_ul() == page_num) or (_first_row_sig() != before))
    except Exception:
        time.sleep(0.8)

    return True

def lay_danh_sach_chi_tiet_all_pages(driver, wait):
    """Quét bảng dịch truyền tất cả trang để đối chiếu.
    Return:
      - records: dict[(ten_thuoc_norm, tg_bat_dau_norm)] -> list[info]
      - total_pages: int
    info gồm: {id, ten, tg_bat_dau, tg_ket_thuc, the_tich, toc_do, bac_si, y_ta}
    """
    records = {}
    total_pages = _get_total_pages_in_modal(driver)

    # luôn cố gắng về trang 1 trước khi quét
    try:
        _goto_page_in_modal(driver, wait, 1)
    except Exception:
        pass

    def _read_row_value_by_span_prefix(row, prefix):
        try:
            sp = row.find_element(By.CSS_SELECTOR, f"span[id^='{prefix}']")
            return (sp.text or "").strip()
        except Exception:
            return ""

    def _scan_current_page():
        try:
            rows = driver.find_elements(By.XPATH, "//tbody[@id='TableContentPhieuTruyenDich']/tr")
        except Exception:
            rows = []

        for row in rows:
            try:
                tds = row.find_elements(By.TAG_NAME, "td")
                if len(tds) < 11:
                    continue

                ten_raw = (tds[1].text or "")

                ten_web = _norm_text(ten_raw)
                ten_key = _norm_med_key(ten_raw)

                # thời gian: ưu tiên span (đang hiển thị), fallback theo cột
                tg_bat_dau = _norm_time_str(_read_row_value_by_span_prefix(row, "spTgBatDauTD"))
                if not tg_bat_dau:
                    tg_bat_dau = _norm_time_str(tds[5].text if len(tds) > 5 else "")
                if not tg_bat_dau:
                    continue

                tg_ket_thuc = _norm_time_str(_read_row_value_by_span_prefix(row, "spTgKetThucTD"))
                if not tg_ket_thuc:
                    tg_ket_thuc = _norm_time_str(tds[6].text if len(tds) > 6 else "")

                # thể tích & tốc độ theo cấu trúc bảng bạn gửi:
                # [2]=Thể tích, [4]=Tốc độ
                the_tich = _int_from_text(tds[2].text if len(tds) > 2 else "", 0)
                toc_do = _int_from_text(tds[4].text if len(tds) > 4 else "", 0)

                # bác sĩ & y tá theo cột
                bac_si_raw = (tds[7].text if len(tds) > 7 else "")
                bac_si = _norm_text(bac_si_raw)
                bac_si_key = _norm_staff_key(bac_si_raw)
                y_ta_raw = (tds[8].text if len(tds) > 8 else "")
                y_ta = _norm_text(y_ta_raw)
                y_ta_key = _norm_staff_key(y_ta_raw)

                # ID: ưu tiên lấy từ checkbox value (ổn định nhất), fallback theo onclick Xoa("..")
                rec_id = ""
                try:
                    rec_id = (row.find_element(By.CSS_SELECTOR, "input.chkAddBn").get_attribute("value") or "").strip()
                except Exception:
                    rec_id = ""
                if not rec_id:
                    try:
                        btn_xoa = tds[10].find_element(By.XPATH, ".//a[contains(text(), 'Xóa')]")
                        onclick_attr = btn_xoa.get_attribute("onclick") or ""
                        match = re.search(r"Xoa\(\"(.+?)\"\)", onclick_attr)
                        rec_id = match.group(1) if match else ""
                    except Exception:
                        rec_id = ""

                key = (ten_key, tg_bat_dau)
                info = {
                    "id": rec_id,
                    "ten": ten_web,
                    "ten_key": ten_key,

                    "tg_bat_dau": tg_bat_dau,
                    "tg_ket_thuc": tg_ket_thuc,
                    "the_tich": the_tich,
                    "toc_do": toc_do,
                    "bac_si": bac_si,
                    "bac_si_key": bac_si_key,

                    "y_ta": y_ta,
                    "y_ta_key": y_ta_key,

                }
                records.setdefault(key, []).append(info)
            except Exception:
                continue

    # scan all pages
    for p in range(1, total_pages + 1):
        if p != 1:
            _goto_page_in_modal(driver, wait, p)
            time.sleep(0.4)
        _scan_current_page()

    # về lại trang 1 để thao tác nhập/xoá (tránh UI lạ)
    try:
        _goto_page_in_modal(driver, wait, 1)
    except Exception:
        pass

    return records, total_pages

def _record_signature(info: dict):
    """Tạo chữ ký 1 bản ghi để so trùng lặp 100% (theo giá trị đã chuẩn hoá)."""
    return (
        info.get("ten_key") or _norm_med_key(info.get("ten", "")),
        _norm_time_str(info.get("tg_bat_dau", "")),
        _norm_time_str(info.get("tg_ket_thuc", "")),
        int(info.get("the_tich", 0) or 0),
        int(info.get("toc_do", 0) or 0),
        info.get("bac_si_key") or _norm_staff_key(info.get("bac_si", "")),
        info.get("y_ta_key") or _norm_staff_key(info.get("y_ta", "")),
    )

def xoa_trung_lap_100(driver, wait, records: dict, keys_filter=None) -> int:
    """Xóa bản trùng lặp nếu trùng 100% tất cả trường.

    Trùng 100% = trùng chữ ký:
      (tên, giờ bắt đầu, giờ kết thúc, thể tích, tốc độ, bác sĩ, điều dưỡng)

    Giữ lại 1 bản, xóa các bản còn lại (chỉ khi có id).
    keys_filter: set các key (ten, tg_bat_dau) để áp dụng; None = áp dụng toàn bộ.
    """
    deleted = 0
    for key, lst in list(records.items()):
        if keys_filter is not None and key not in keys_filter:
            continue
        if not lst or len(lst) <= 1:
            continue

        groups = {}
        for info in lst:
            sig = _record_signature(info)
            groups.setdefault(sig, []).append(info)

        for _sig, infos in groups.items():
            if len(infos) <= 1:
                continue
            # giữ 1 bản, xóa phần còn lại
            for dup in infos[1:]:
                rec_id = (dup.get("id") or "").strip()
                if rec_id:
                    if _delete_record_by_id(driver, wait, rec_id):
                        deleted += 1
                        time.sleep(0.2)
    return deleted

def _delete_record_by_id(driver, wait, rec_id: str) -> bool:
    if not rec_id:
        return False
    try:
        driver.execute_script(f"Xoa('{rec_id}');")
        btn_confirm = wait.until(EC.element_to_be_clickable((By.CSS_SELECTOR, "button.confirm")))
        btn_confirm.click()
        time.sleep(1.2)
        return True
    except Exception:
        return False

def _info_matches_expected_med(info: dict, expected_meds: list) -> bool:
    """Tránh xóa nhầm bản ghi đang là dịch truyền hợp lệ hiện tại."""
    web_start = _norm_time_str(info.get('tg_bat_dau', ''))
    web_key = info.get('ten_key') or _norm_med_key(info.get('ten', ''))
    web_base = _norm_med_base(info.get('ten', ''))

    for med in expected_meds or []:
        exp_start = _norm_time_str(med.get('Time_Start_Str', ''))
        if not exp_start or exp_start != web_start:
            continue
        exp_key = _norm_med_key(med.get('Full_Name', ''))
        if exp_key and exp_key == web_key:
            return True
        exp_base = _norm_med_base(med.get('Full_Name', ''))
        if exp_base and web_base and (exp_base == web_base or exp_base in web_base or web_base in exp_base):
            return True
    return False

def _info_matches_cleanup_task(info: dict, cleanup: dict) -> bool:
    """So khớp bản ghi web với task cleanup.

    Không đòi tên khớp 100%, vì bản sai cũ có thể là:
      TRAMADOL-HAMELN50MG/ ML + Natri clorid 0.9%
    trong khi cleanup task chỉ có tên TRAMADOL.
    """
    exp_start = _norm_time_str(cleanup.get('Time_Start_Str', ''))
    web_start = _norm_time_str(info.get('tg_bat_dau', ''))
    if not exp_start or not web_start or exp_start != web_start:
        return False

    exp_name = cleanup.get('Full_Name') or cleanup.get('Search_Name') or ''
    web_name = info.get('ten') or ''
    exp_key = _norm_med_key(exp_name)
    web_key = info.get('ten_key') or _norm_med_key(web_name)
    if exp_key and web_key and (exp_key == web_key or exp_key in web_key or web_key in exp_key):
        return True

    exp_base = _norm_med_base(exp_name)
    web_base = _norm_med_base(web_name)
    if exp_base and web_base and (exp_base == web_base or exp_base in web_base or web_base in exp_base):
        return True

    # Rule riêng: cleanup TRAMADOL tiêm bắp phải xóa bản truyền cũ có kèm Natri/NaCl.
    if 'tramadol' in _norm_text(exp_name) and 'tramadol' in _norm_text(web_name):
        return True

    return False

def xoa_dich_truyen_bi_rule_loai(driver, wait, records: dict, cleanup_tasks: list, expected_meds: list) -> int:
    """Xóa các dịch truyền cũ đã bị rule loại khỏi dữ liệu chuẩn.

    Đây là phần còn thiếu trước đây: khi rule mới loại một dịch truyền khỏi JSON,
    script không còn thấy thuốc đó trong danh_sach_hop_le nên cũng không xóa bản cũ trên EMR.
    """
    if not cleanup_tasks:
        return 0

    deleted = 0
    seen_ids = set()

    for cleanup in cleanup_tasks:
        if not cleanup.get('Time_Start_Str'):
            continue
        reason = cleanup.get('Cleanup_Reason') or 'Bị rule loại khỏi dữ liệu chuẩn'
        name = cleanup.get('Full_Name') or cleanup.get('Search_Name') or ''
        t = _norm_time_str(cleanup.get('Time_Start_Str', ''))

        # Ưu tiên quét theo key exact nếu có, sau đó quét toàn bộ records để bắt tên ghép với NaCl.
        candidate_lists = []
        key = (_norm_med_key(name), t)
        if key in records:
            candidate_lists.append(records.get(key) or [])
        candidate_lists.append([info for lst in (records or {}).values() for info in (lst or [])])

        for candidates in candidate_lists:
            for info in candidates:
                rec_id = (info.get('id') or '').strip()
                if rec_id and rec_id in seen_ids:
                    continue
                if _info_matches_expected_med(info, expected_meds):
                    continue
                if not _info_matches_cleanup_task(info, cleanup):
                    continue
                if rec_id:
                    _log(f"      [CLEANUP] Xóa dịch truyền cũ đã bị loại: {info.get('ten') or name} ({info.get('tg_bat_dau') or t}) | {reason}")
                    if _delete_record_by_id(driver, wait, rec_id):
                        deleted += 1
                        seen_ids.add(rec_id)
                        time.sleep(0.25)
                else:
                    _log(f"      [CLEANUP][!] Thấy bản cần xóa nhưng không lấy được ID: {info.get('ten') or name} ({info.get('tg_bat_dau') or t})")

    return deleted

def _date_key_from_time_str(raw: str) -> str:
    """Lấy dd/mm/YYYY từ chuỗi thời gian đã/ chưa chuẩn hóa."""
    raw = str(raw or "").strip()
    if not raw:
        return ""
    m = re.search(r"\b(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})\b", raw)
    if not m:
        return ""
    dd, mo, yy = m.groups()
    yy = int(yy)
    if yy < 100:
        yy += 2000
    return f"{int(dd):02d}/{int(mo):02d}/{yy:04d}"

def _expected_exact_keys_for_orphan(expected_meds: list) -> set:
    """Tập bản ghi hợp lệ theo kiểu đồng bộ trắng.

    Orphan cleanup phải so khớp CHẶT: tên thuốc/dịch truyền trên phiếu + giờ bắt đầu.
    Không dùng so khớp mềm theo hoạt chất/tên gần giống, vì ví dụ THERMODOL và
    Paracetamol 10mg/ml có thể cùng hoạt chất nhưng người dùng muốn giữ đúng dòng
    đã parse hiện tại và xóa dòng cũ nhập sai.
    """
    out = set()
    for med in expected_meds or []:
        t = _norm_time_str(med.get('Time_Start_Str') or '')
        if not t:
            continue
        for name in (med.get('Full_Name'), med.get('Search_Name')):
            k = _norm_med_key(name or '')
            if k:
                out.add((k, t))
    return out

def _info_matches_expected_med_strict_for_orphan(info: dict, expected_keys: set) -> bool:
    if not info or not expected_keys:
        return False
    web_t = _norm_time_str(info.get('tg_bat_dau') or '')
    web_k = info.get('ten_key') or _norm_med_key(info.get('ten') or '')
    if not web_t or not web_k:
        return False
    return (web_k, web_t) in expected_keys


def _is_legacy_parser_saline_name(name: str) -> bool:
    """Nhận diện tên giả từng bị parser cũ tạo từ *dòng hướng dẫn pha*.

    Ví dụ sai lịch sử:
      - ``Pha natriclorid 0.9% 100ml``
      - ``Pha NaCl 0.9% 100ml``

    Cố ý KHÔNG coi mọi dòng NaCl là legacy; chỉ nhận khi tên bắt đầu bằng
    ``Pha ...`` để tránh đụng vào dịch truyền NaCl thật do người dùng nhập.
    """
    raw = strip_accents(str(name or '').lower())
    raw = raw.replace(',', '.')
    raw = re.sub(r'\s+', ' ', raw).strip()
    return bool(re.match(
        r'^pha\s+(?:natri\s*clorid|natriclorid|na\s*cl|nacl|sodium\s*chloride)\b',
        raw,
        flags=re.IGNORECASE,
    ))


def _is_legacy_inferred_cipro_nacl_name(name: str) -> bool:
    """Nhận diện artifact Cipro + NaCl do rule suy luận dung môi cũ tạo nhầm.

    Chỉ nhận khi tên có ciprofloxacin *và* ``+ NaCl``. Dịch NaCl độc lập hoặc
    Ciprofloxacin Kabi truyền sẵn không bị coi là legacy.
    """
    key = _norm_med_key(name or '')
    return 'ciprofloxacin' in key and '+nacl' in key


def _legacy_parser_artifact_kind(name: str) -> str:
    if _is_legacy_parser_saline_name(name):
        return 'pha_saline'
    if _is_legacy_inferred_cipro_nacl_name(name):
        return 'cipro_false_nacl'
    return ''


def _expected_is_legacy_replacement(med: dict, kind: str) -> bool:
    """Expected hợp lệ có thể thay thế an toàn cho từng loại artifact đã biết."""
    name = med.get('Full_Name') or med.get('Search_Name') or ''
    key = _norm_med_key(name)
    if kind == 'pha_saline':
        if 'nacl' not in key:
            return False
        return any(token in key for token in ('vancomycin', 'tramadol', 'trasolu'))
    if kind == 'cipro_false_nacl':
        # Parser mới phải giữ Cipro truyền sẵn, tuyệt đối không còn ``+ NaCl``.
        return 'ciprofloxacin' in key and 'nacl' not in key
    return False


def _expected_is_legacy_saline_replacement(med: dict) -> bool:
    # Tương thích helper/test cũ.
    return _expected_is_legacy_replacement(med, 'pha_saline')


def _info_matches_expected_shape(info: dict, med: dict) -> bool:
    """So thể tích/tốc độ khi expected có giá trị để tăng độ an toàn cleanup."""
    exp_volume = int(med.get('The_Tich', 0) or 0)
    exp_speed = _int_from_text(str(med.get('Toc_Do', '') or ''), 0)
    web_volume = int(info.get('the_tich', 0) or 0)
    web_speed = int(info.get('toc_do', 0) or 0)
    if exp_volume and web_volume != exp_volume:
        return False
    if exp_speed and web_speed != exp_speed:
        return False
    return True


def _find_expected_for_legacy_info(info: dict, expected_meds: list):
    """Tìm expected tương ứng theo cùng giờ + loại artifact + thể tích/tốc độ."""
    web_start = _norm_time_str(info.get('tg_bat_dau') or '')
    kind = _legacy_parser_artifact_kind(info.get('ten') or '')
    if not web_start or not kind:
        return None

    for med in expected_meds or []:
        if not _expected_is_legacy_replacement(med, kind):
            continue
        exp_start = _norm_time_str(med.get('Time_Start_Str') or '')
        if not exp_start or exp_start != web_start:
            continue
        if not _info_matches_expected_shape(info, med):
            continue
        return med
    return None


def tim_dich_truyen_legacy_parser_cu(records: dict, expected_meds: list) -> list:
    """Trả về các artifact parser cũ còn trên EMR và expected tương ứng.

    Hàm này không yêu cầu bản đúng thay thế đã tồn tại; dùng cho final verify để
    không thể báo OK khi legacy vẫn còn sót.
    """
    found = []
    seen = set()
    for lst in (records or {}).values():
        for info in (lst or []):
            rec_id = (info.get('id') or '').strip()
            sig = rec_id or (
                _norm_med_key(info.get('ten') or ''),
                _norm_time_str(info.get('tg_bat_dau') or ''),
                int(info.get('the_tich', 0) or 0),
                int(info.get('toc_do', 0) or 0),
            )
            if sig in seen:
                continue
            seen.add(sig)
            med = _find_expected_for_legacy_info(info, expected_meds)
            if med:
                found.append((info, med))
    return found


def _info_is_correct_replacement(info: dict, med: dict) -> bool:
    """So tên bản thay thế chặt hơn để legacy không tự được coi là bản đúng."""
    web_key = info.get('ten_key') or _norm_med_key(info.get('ten') or '')
    exp_key = _norm_med_key(med.get('Full_Name') or med.get('Search_Name') or '')
    if exp_key and web_key and exp_key == web_key:
        return True
    web_base = _norm_med_base(info.get('ten') or '')
    exp_base = _norm_med_base(med.get('Full_Name') or med.get('Search_Name') or '')
    return bool(exp_base and web_base and exp_base == web_base)


def _has_correct_replacement_on_web(legacy_info: dict, med: dict, all_infos: list) -> bool:
    """Chỉ xác nhận legacy khi bản đúng thay thế *đã tồn tại trên EMR*."""
    legacy_id = (legacy_info.get('id') or '').strip()
    legacy_start = _norm_time_str(legacy_info.get('tg_bat_dau') or '')
    for info in all_infos or []:
        if info is legacy_info:
            continue
        other_id = (info.get('id') or '').strip()
        if legacy_id and other_id and legacy_id == other_id:
            continue
        if _legacy_parser_artifact_kind(info.get('ten') or ''):
            continue
        if _norm_time_str(info.get('tg_bat_dau') or '') != legacy_start:
            continue
        if not _info_matches_expected_shape(info, med):
            continue
        if _info_is_correct_replacement(info, med):
            return True
    return False


def xoa_dich_truyen_legacy_parser_cu(driver, wait, records: dict, expected_meds: list) -> int:
    """Xóa có mục tiêu các dòng sai do parser cũ tạo từ câu ``Pha NaCl...``.

    Các artifact được hỗ trợ có mục tiêu:
      1. ``Pha natriclorid/Pha NaCl...`` -> VANCOMYCIN/TRAMADOL/TRASOLU + NaCl;
      2. ``CIPROFLOXACIN ... + NaCl`` do suy luận dung môi cũ -> Cipro truyền sẵn.

    Điều kiện bắt buộc trước khi xóa:
      - cùng giờ bắt đầu;
      - thể tích/tốc độ khớp expected (nếu expected có giá trị);
      - trên EMR *đã có* một dòng đúng thay thế cùng giờ và cùng shape.

    Vì vậy hàm không xóa trước rồi mới hy vọng nhập lại thành công. Các orphan
    khác vẫn do ``xoa_dich_truyen_thua_ngoai_du_lieu`` xử lý REPORT_ONLY mặc định.
    """
    if not records or not expected_meds:
        return 0

    all_infos = [info for lst in (records or {}).values() for info in (lst or [])]
    deleted = 0
    seen_ids = set()

    for info, med in tim_dich_truyen_legacy_parser_cu(records, expected_meds):
        rec_id = (info.get('id') or '').strip()
        if rec_id and rec_id in seen_ids:
            continue
        if not _has_correct_replacement_on_web(info, med, all_infos):
            _log(
                f"      [CLEANUP_LEGACY][SAFE] Giữ dòng legacy vì chưa thấy bản đúng thay thế: "
                f"{info.get('ten') or ''} ({info.get('tg_bat_dau') or ''})"
            )
            continue

        name = info.get('ten') or ''
        t = info.get('tg_bat_dau') or ''
        if not rec_id:
            _log(f"      [CLEANUP_LEGACY][!] Đủ điều kiện xóa nhưng không lấy được ID: {name} ({t})")
            continue

        _log(
            f"      [CLEANUP_LEGACY] Xóa dòng sai do parser cũ: {name} ({t}) "
            f"-> đã có {med.get('Full_Name') or med.get('Search_Name') or ''} thay thế."
        )
        if _delete_record_by_id(driver, wait, rec_id):
            deleted += 1
            seen_ids.add(rec_id)
            time.sleep(0.25)

    return deleted

def xoa_dich_truyen_thua_ngoai_du_lieu(
    driver,
    wait,
    records: dict,
    managed_dates: set,
    expected_meds: list,
    allow_delete: bool = False,
) -> int:
    """Quét các dòng dịch truyền ngoài dữ liệu chuẩn trong ngày đang quản lý.

    Mặc định ``allow_delete=False``: chỉ log cảnh báo, KHÔNG xóa. Đây là chế độ an
    toàn vì parser/JSON không phải nguồn sự thật tuyệt đối và EMR có thể chứa phiếu
    do người dùng khác nhập. Chỉ khi caller bật rõ ``allow_delete=True`` mới thực
    hiện đồng bộ trắng và xóa dòng ngoài expected_meds.

    Điểm sửa quan trọng:
    - managed_dates không chỉ lấy từ ngay_lam của record, mà còn lấy từ ngày thật
      trong Time_Start_Str của từng dịch truyền hợp lệ. Vì một record ngày 24/04
      vẫn có thể chứa dịch truyền 25/04, 26/04, 27/04.
    - So khớp giữ lại dùng chế độ CHẶT, không so mềm theo hoạt chất/tên gần giống.
      Ví dụ expected là THERMODOL thì Paracetamol 10mg/ml cùng giờ vẫn bị xem là
      dòng thừa và sẽ bị xóa.
    """
    managed_dates = set(str(x or "").strip() for x in (managed_dates or []) if str(x or "").strip())

    # Bổ sung ngày quản lý từ chính giờ truyền hợp lệ. Đây là chỗ trước đây bị sót:
    # record ngày 24/04 nhưng phiếu truyền nằm ngày 25/04-27/04 thì orphan cleanup
    # không đụng tới 25-27.
    for med in expected_meds or []:
        d = _date_key_from_time_str(med.get('Time_Start_Str') or '')
        if d:
            managed_dates.add(d)

    if not managed_dates:
        return 0

    expected_keys = _expected_exact_keys_for_orphan(expected_meds)
    if not expected_keys:
        return 0

    mode = "DELETE" if allow_delete else "REPORT_ONLY"
    _log(
        f"      [CLEANUP_ORPHAN][SCAN][{mode}] Quét tổng quát các ngày: "
        f"{', '.join(sorted(managed_dates))}; giữ lại {len(expected_keys)} key hợp lệ."
    )

    deleted = 0
    seen_ids = set()
    all_infos = [info for lst in (records or {}).values() for info in (lst or [])]

    for info in all_infos:
        rec_id = (info.get("id") or "").strip()
        if rec_id and rec_id in seen_ids:
            continue

        row_date = _date_key_from_time_str(info.get("tg_bat_dau") or "")
        if row_date not in managed_dates:
            continue

        # Giữ đúng những dòng hiện tại còn trong JSON chuẩn. Không dùng _info_matches_expected_med
        # vì hàm đó có so mềm, có thể giữ sót dòng cũ sai tên.
        if _info_matches_expected_med_strict_for_orphan(info, expected_keys):
            continue

        name = info.get("ten") or ""
        t = info.get("tg_bat_dau") or ""
        if rec_id:
            if not allow_delete:
                # Parser không phải nguồn sự thật tuyệt đối. Mặc định chỉ cảnh báo
                # để tránh xóa nhầm phiếu do người dùng/điều dưỡng khác nhập.
                _log(
                    f"      [CLEANUP_ORPHAN][SAFE] Phát hiện dòng ngoài JSON nhưng KHÔNG XÓA: "
                    f"{name} ({t})"
                )
                seen_ids.add(rec_id)
                continue
            _log(f"      [CLEANUP_ORPHAN] Xóa dòng thừa ngoài dữ liệu chuẩn: {name} ({t})")
            if _delete_record_by_id(driver, wait, rec_id):
                deleted += 1
                seen_ids.add(rec_id)
                time.sleep(0.25)
        else:
            _log(f"      [CLEANUP_ORPHAN][!] Thấy dòng thừa nhưng không lấy được ID: {name} ({t})")

    return deleted

def _compare_med_vs_web(med, web_info, ten_y_ta_chuan):
    """So sánh dữ liệu JSON (med) với bản ghi web; trả về list lỗi (rỗng nếu khớp).

    Lưu ý: so bác sĩ/điều dưỡng theo *tên* (đã bỏ chức danh) để tránh sai do khác cách hiển thị.
    """
    errs = []

    exp_name_key = _norm_med_key(med.get("Full_Name", ""))
    exp_start = _norm_time_str(med.get("Time_Start_Str", ""))
    exp_end = _norm_time_str(med.get("Time_End_Str", ""))
    exp_the_tich = int(med.get("The_Tich", 0) or 0)
    exp_toc_do = _int_from_text(str(med.get("Toc_Do", "")), 0)

    exp_bac_si_key = _norm_staff_key(med.get("Bac_Si", "")) if med.get("Bac_Si") else ""
    exp_y_ta_key = _norm_staff_key(ten_y_ta_chuan or "") if ten_y_ta_chuan else ""

    web_name_key = web_info.get("ten_key") or _norm_med_key(web_info.get("ten", ""))
    web_start = _norm_time_str(web_info.get("tg_bat_dau", ""))
    web_end = _norm_time_str(web_info.get("tg_ket_thuc", ""))
    web_the_tich = int(web_info.get("the_tich", 0) or 0)
    web_toc_do = int(web_info.get("toc_do", 0) or 0)
    web_bs_key = web_info.get("bac_si_key") or _norm_staff_key(web_info.get("bac_si", ""))
    web_yta_key = web_info.get("y_ta_key") or _norm_staff_key(web_info.get("y_ta", ""))

    if web_name_key != exp_name_key:
        exp_base = _norm_med_base(med.get("Full_Name", ""))
        web_base = _norm_med_base(web_info.get("ten", ""))
        if not (exp_base and web_base and (exp_base == web_base or exp_base in web_base or web_base in exp_base)):
            errs.append("sai tên dịch truyền")
    if web_start != exp_start:
        errs.append("sai giờ bắt đầu")
    # Không kiểm tra giờ kết thúc: EMR tự tính từ thể tích + tốc độ,
    # và chỉ hiển thị dạng "HH:MM" (không có ngày) nên không so sánh được chính xác.
    # if exp_end and web_end != exp_end:
    #     errs.append("sai giờ kết thúc")
    if exp_the_tich and web_the_tich != exp_the_tich:
        errs.append("sai thể tích")
    if exp_toc_do and web_toc_do != exp_toc_do:
        errs.append("sai tốc độ")
    # Bắt buộc đúng bác sĩ/điều dưỡng. Nếu sai, bản ghi sẽ bị xóa và nhập lại.
    if exp_bac_si_key and web_bs_key and not (exp_bac_si_key == web_bs_key or exp_bac_si_key in web_bs_key or web_bs_key in exp_bac_si_key):
        errs.append("sai bác sĩ")
    if exp_y_ta_key and web_yta_key and not (exp_y_ta_key == web_yta_key or exp_y_ta_key in web_yta_key or web_yta_key in exp_y_ta_key):
        errs.append("sai điều dưỡng")

    return errs
