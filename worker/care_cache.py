# -*- coding: utf-8 -*-
"""care_cache.py — quét, so sánh và dọn cache phiếu chăm sóc."""

import logging
import re
import time
from datetime import datetime, timedelta

try:
    from selenium.webdriver.common.by import By
    from selenium.webdriver.support.ui import WebDriverWait
    from selenium.webdriver.support import expected_conditions as EC
except ModuleNotFoundError:  # Cho phép import/test phần so sánh cache khi máy chưa cài Selenium.
    By = WebDriverWait = EC = None  # type: ignore

from utils import handle_popups, chuan_hoa_unicode
from input_care_utils import (
    _canon_time_key, _dt_from_time_key, _time_field_matches,
    kiem_tra_noi_dung_cham_soc, kiem_tra_ten_trung_khop, tao_thoi_gian_lap,
)
try:
    from care_web_actions import click_thu_hoi_va_xoa
except ModuleNotFoundError:
    def click_thu_hoi_va_xoa(*_args, **_kwargs):
        raise RuntimeError("Chưa cài Selenium nên không thể thao tác phiếu chăm sóc.")

LOG = logging.getLogger("cham_soc")

def _ctx_prefix():
    return ""

def _extract_id_from_onclick(onclick, fn_name):
    """Trích UUID/id từ onclick: fn_name('...')."""
    if not onclick:
        return None
    try:
        m = re.search(rf"{re.escape(fn_name)}\('([^']+)'\)", onclick)
        return m.group(1) if m else None
    except Exception as _e:  # was: bare except
        LOG.debug(f"[except] {_e}")
        return None


def _cs_wait_processing_done(driver, timeout=8):
    try:
        WebDriverWait(driver, timeout).until(
            lambda d: d.find_element(By.ID, "divProcessingChamSoc").value_of_css_property("display") in ("none", "")
        )
    except Exception as _e:  # was: bare except
        LOG.debug(f"[except] {_e}")
        pass


def _cs_get_total_pages(driver):
    """Đọc 'Trang X/Y' từ pagination, trả về tổng Y (>=1)."""
    try:
        txt = driver.find_element(By.CSS_SELECTOR, "ul.pagination li a.currentPaging").text.strip()
        m = re.search(r"Trang\s+\d+\s*/\s*(\d+)", txt)
        if m:
            return max(1, int(m.group(1)))
    except Exception as _e:  # was: bare except
        LOG.debug(f"[except] {_e}")
        pass
    return 1


def _cs_get_current_page_idx0(driver):
    """Đọc 'Trang X/Y' và trả về index 0-based của trang hiện tại (mặc định 0)."""
    try:
        txt = driver.find_element(By.CSS_SELECTOR, "ul.pagination li a.currentPaging").text.strip()
        m = re.search(r"Trang\s+(\d+)\s*/\s*(\d+)", txt)
        if m:
            return max(0, int(m.group(1)) - 1)
    except Exception as _e:  # was: bare except
        LOG.debug(f"[except] {_e}")
        pass
    return 0


def _cs_goto_page(driver, page_idx0):
    """NextPageDDChamSoc dùng index 0-based."""
    try:
        driver.execute_script("try{NextPageDDChamSoc(arguments[0]);}catch(e){}", int(page_idx0))
    except Exception as _e:  # was: bare except
        LOG.debug(f"[except] {_e}")
        pass
    time.sleep(0.6)
    _cs_wait_processing_done(driver)


def scan_cham_soc_cache(driver, ngay_lam_viec, hours_needed=None):
    """Quét TT chăm sóc và tạo cache theo time_str.

    Nếu truyền hours_needed (list[int]): chỉ duyệt tới khi đã "phủ" được khoảng thời gian cần nhập.
    Nếu không truyền: quét hết các trang như cũ.
    """
    cache = {}
    entries = []

    # Chỉ quan tâm ngày làm việc và ngày +1 (0h, 5h, 6h có thể rơi vào ngày hôm sau)
    try:
        dt = datetime.strptime(ngay_lam_viec, "%d/%m/%Y")
        valid_dates = {dt.strftime("%d/%m/%Y"), (dt + timedelta(days=1)).strftime("%d/%m/%Y")}
    except Exception as _e:  # was: bare except
        LOG.debug(f"[except] {_e}")
        valid_dates = set()

    # chuẩn bị tập key cần tìm (nếu có)
    required_keys = set()
    min_target_dt = None
    if hours_needed:
        try:
            for h in hours_needed:
                # Cho phép truyền cả giờ nguyên (8, 16, 20) và time_full đặc biệt ("13:35 24/04/2026").
                if isinstance(h, str) and ":" in h:
                    k = _canon_time_key(h)
                else:
                    k = _canon_time_key(tao_thoi_gian_lap(int(h), ngay_lam_viec))
                if k:
                    required_keys.add(k)
            dts = [_dt_from_time_key(k) for k in required_keys]
            dts = [d for d in dts if d]
            if dts:
                min_target_dt = min(dts)
        except Exception as _e:  # was: bare except
            LOG.debug(f"[except] {_e}")
            required_keys = set()
            min_target_dt = None

    total = _cs_get_total_pages(driver)

    # nếu đang không ở trang 1 thì mới quay về (tránh gọi NextPageDDChamSoc không cần thiết)
    try:
        if _cs_get_current_page_idx0(driver) != 0:
            _cs_goto_page(driver, 0)
    except Exception as _e:  # was: bare except
        LOG.debug(f"[except] {_e}")
        pass

    oldest_scanned_dt = None
    found_keys = set()

    for p in range(total):
        if p > 0:
            # Chỉ lật trang khi cần: chưa đủ key cần tìm và còn khả năng nằm ở trang sau
            if required_keys and required_keys.issubset(found_keys):
                LOG.debug(_ctx_prefix() + f"[scan_cache] stop: all_required_keys_found ({len(found_keys)}/{len(required_keys)})")
                break
            if min_target_dt and oldest_scanned_dt and oldest_scanned_dt <= min_target_dt:
                LOG.debug(_ctx_prefix() + f"[scan_cache] stop: oldest_scanned_dt<=min_target_dt ({oldest_scanned_dt} <= {min_target_dt})")
                break
            _cs_goto_page(driver, p)

        try:
            rows = driver.find_elements(By.CSS_SELECTOR, "#divDanhSachChamSocContent table tbody tr")
        except Exception as _e:  # was: bare except
            LOG.debug(f"[except] {_e}")
            rows = []
        LOG.debug(_ctx_prefix() + f"[scan_cache] page={p+1}/{total} rows={len(rows)} found_keys={len(found_keys)}/{len(required_keys)} oldest_dt={oldest_scanned_dt} min_target={min_target_dt}")

        for r in rows:
            try:
                cols = r.find_elements(By.TAG_NAME, "td")
                if len(cols) < 11:
                    continue

                time_full_raw = cols[2].text.strip()
                time_full = _canon_time_key(time_full_raw)
                if not time_full or ":" not in time_full:
                    continue

                parts = time_full.split()
                if len(parts) < 2:
                    continue
                hhmm = parts[0].strip()
                ddmmyy = parts[1].strip()

                if valid_dates and ddmmyy not in valid_dates:
                    continue

                status = cols[1].text.strip()
                creator = cols[3].text.strip()

                nt = cols[4].text.strip()
                temp = cols[5].text.strip()
                mach = cols[6].text.strip()
                ha = cols[7].text.strip()
                cn = cols[8].text.strip()

                dien_bien = cols[9].text.strip()
                cham_soc = cols[10].text.strip()

                dt_key = _dt_from_time_key(time_full)
                if dt_key:
                    oldest_scanned_dt = dt_key if (oldest_scanned_dt is None or dt_key < oldest_scanned_dt) else oldest_scanned_dt

                # id sửa / id xoá
                id_edit = None
                id_delete = None
                try:
                    a_time = cols[2].find_element(By.TAG_NAME, "a")
                    id_edit = _extract_id_from_onclick(a_time.get_attribute("onclick"), "onDrawWebpartChamSoc")
                except Exception as _e:  # was: bare except
                    LOG.debug(f"[except] {_e}")
                    pass
                if not id_edit:
                    try:
                        a_sua = cols[0].find_elements(By.TAG_NAME, "a")
                        for a in a_sua:
                            if a.text.strip().lower() == "sửa":
                                id_edit = _extract_id_from_onclick(a.get_attribute("onclick"), "onDrawWebpartChamSoc")
                                break
                    except Exception as _e:  # was: bare except
                        LOG.debug(f"[except] {_e}")
                        pass
                try:
                    a_xoa = cols[0].find_elements(By.TAG_NAME, "a")
                    for a in a_xoa:
                        if a.text.strip().lower() == "xóa":
                            id_delete = _extract_id_from_onclick(a.get_attribute("onclick"), "fnSideDeleteChamSoc")
                            break
                except Exception as _e:  # was: bare except
                    LOG.debug(f"[except] {_e}")
                    pass

                e = {
                    "time_full": time_full,
                    "hhmm": hhmm,
                    "date": ddmmyy,
                    "status": status,
                    "creator": creator,
                    "nt": nt, "temp": temp, "mach": mach, "ha": ha, "cn": cn,
                    "dien_bien": dien_bien,
                    "cham_soc": cham_soc,
                    "id_edit": id_edit,
                    "id_delete": id_delete,
                }
                entries.append(e)
                cache.setdefault(time_full, []).append(e)

                if required_keys and time_full in required_keys:
                    found_keys.add(time_full)

            except Exception as _e:  # was: bare except
                LOG.debug(f"[except] {_e}")
                continue

    return cache, entries


def _is_tool_content(entry):
    """Nhận cả dict phiếu hoặc chuỗi nội dung để tránh crash khi caller truyền text."""
    if isinstance(entry, dict):
        txt = chuan_hoa_unicode((entry.get("cham_soc") or "") + " " + (entry.get("dien_bien") or ""))
    else:
        txt = chuan_hoa_unicode(str(entry or ""))
    # keywords thực tế trong tool của bạn
    kws = [
        # ``txt`` đã đi qua chuan_hoa_unicode() nên ưu tiên từ khóa không dấu.
        "dau hieu sinh ton", "lay dau hieu sinh ton",
        "chi dinh thuoc", "thuc hien chi dinh thuoc",
        "lay dhst", "xet nghiem", "rut mau", "thay bang",
    ]
    return any(k in txt for k in kws)


def tool_rows_at_or_after(cache, cutoff_time_key, list_ten_dieu_duong):
    """Liệt kê phiếu do tool/team tạo còn tồn tại từ một cutoff trở đi."""
    cutoff_dt = _dt_from_time_key(str(cutoff_time_key or ""))
    if cutoff_dt is None:
        return []
    out = []
    for time_full, rows in (cache or {}).items():
        entry_dt = _dt_from_time_key(str(time_full or ""))
        if entry_dt is None or entry_dt < cutoff_dt:
            continue
        for row in rows or []:
            if not isinstance(row, dict):
                continue
            if not kiem_tra_ten_trung_khop(row.get("creator", ""), list_ten_dieu_duong):
                continue
            if not _is_tool_content(row):
                continue
            out.append({
                "time_full": time_full,
                "creator": row.get("creator", ""),
                "care": row.get("cham_soc", ""),
                "id_edit": row.get("id_edit"),
            })
    return out


def open_cham_soc_by_id(driver, care_id):
    """Mở phiếu chăm sóc theo id (không cần lật trang)."""
    if not care_id:
        raise RuntimeError("missing care_id")
    try:
        driver.execute_script("try{onDrawWebpartChamSoc(arguments[0]);}catch(e){}", care_id)
    except Exception as _e:  # was: bare except
        LOG.debug(f"[except] {_e}")
        # fallback: gọi dạng string
        driver.execute_script(f"try{{onDrawWebpartChamSoc('{care_id}');}}catch(e){{}}")
    time.sleep(1.3)


def delete_cham_soc_new_by_id(driver, care_id):
    """Xoá phiếu (đặc biệt trạng thái 'Mới') theo id."""
    if not care_id:
        return
    try:
        driver.execute_script("try{fnSideDeleteChamSoc(arguments[0]);}catch(e){}", care_id)
    except Exception as _e:  # was: bare except
        LOG.debug(f"[except] {_e}")
        driver.execute_script(f"try{{fnSideDeleteChamSoc('{care_id}');}}catch(e){{}}")
    time.sleep(1.0)
    handle_popups(driver)
    time.sleep(0.6)
    handle_popups(driver)


def cleanup_cham_soc_cache(
    driver,
    cache,
    sorted_hours,
    list_ten_dieu_duong,
    phase="start",
    extra_valid_time_keys=None,
    protect_before_time_key=None,
    remove_tool_rows_at_or_after_time_key=None,
):
    """Dọn cache phiếu chăm sóc.

    Quy tắc an toàn:
    - Phiếu trạng thái 'Mới' do tool tạo dư: xoá trong vùng thời gian tool được phép can thiệp.
    - Phiếu sai giờ do tool tạo: thu hồi + xoá trong vùng thời gian tool được phép can thiệp.
    - Với ngày hậu phẫu/chuyển về khoa, protect_before_time_key là mốc khoa nhận bệnh.
      Mọi phiếu trước mốc này được giữ nguyên, kể cả khi không nằm trong giờ cần nhập.
      Ví dụ nhận về 13:41 thì phiếu 08:00 đã có trước đó không bị thu hồi/xóa.
    - Với ngày đã chuyển/đi mổ, ``remove_tool_rows_at_or_after_time_key`` là mốc
      rời khoa. Các phiếu do tool/team tạo từ mốc đó trở đi được thu hồi/xóa,
      kể cả 05:00 ngày hôm sau. Phiếu trước mốc mổ và phiếu không nhận diện là
      do tool tạo vẫn được giữ nguyên.
    Cache sẽ bị mutate để loại bỏ các phiếu đã xoá.
    """
    valid_times = {f"{int(h):02d}:00" for h in (sorted_hours or [])}
    for _time_key in (extra_valid_time_keys or []):
        _m = re.search(r"(\d{1,2}:\d{2})", str(_time_key or ""))
        if _m:
            valid_times.add(_m.group(1))

    protect_before_dt = None
    if protect_before_time_key:
        try:
            protect_before_dt = _dt_from_time_key(str(protect_before_time_key))
        except Exception as _e:
            LOG.debug(f"[except] {_e}")
            protect_before_dt = None

    remove_at_or_after_dt = None
    if remove_tool_rows_at_or_after_time_key:
        try:
            remove_at_or_after_dt = _dt_from_time_key(str(remove_tool_rows_at_or_after_time_key))
        except Exception as _e:
            LOG.debug(f"[except] {_e}")
            remove_at_or_after_dt = None

    # Duyệt snapshot để tránh mutate khi loop
    items = [(k, list(v)) for k, v in (cache or {}).items()]
    for time_full, lst in items:
        entry_dt_for_cutoff = None
        if remove_at_or_after_dt is not None:
            try:
                entry_dt_for_cutoff = _dt_from_time_key(str(time_full or ""))
            except Exception as _e:
                LOG.debug(f"[except] {_e}")
        force_remove_after_surgery = bool(
            remove_at_or_after_dt is not None
            and entry_dt_for_cutoff is not None
            and entry_dt_for_cutoff >= remove_at_or_after_dt
        )

        # Bình thường không đụng tới các giờ trước 07:00. Riêng cleanup sau mổ
        # phải được phép dọn 05:00 ngày hôm sau vì đây vẫn là mốc sau cutoff mổ.
        try:
            hour_of_entry = int((time_full.split()[0] or '00:00').split(':')[0])
        except Exception as _e:  # was: bare except
            LOG.debug(f"[except] {_e}")
            hour_of_entry = None
        if hour_of_entry is not None and hour_of_entry < 7 and not force_remove_after_surgery:
            continue

        # Ngày hậu phẫu/chuyển về: không dọn/thu hồi/xóa bất kỳ phiếu nào trước mốc nhận bệnh.
        if protect_before_dt is not None:
            try:
                entry_dt = _dt_from_time_key(str(time_full or ""))
            except Exception as _e:
                LOG.debug(f"[except] {_e}")
                entry_dt = None
            if entry_dt is not None and entry_dt < protect_before_dt:
                LOG.info(
                    f"[DỌN {phase}] Bỏ qua phiếu trước mốc nhận khoa {protect_before_time_key}: {time_full}"
                )
                continue

        for e in lst:
            try:
                creator = e.get("creator", "")
                if not kiem_tra_ten_trung_khop(creator, list_ten_dieu_duong):
                    continue

                stt = (e.get("status") or "").strip()
                hhmm = (e.get("hhmm") or "").strip()

                # 0) Ngày đã chuyển/đi mổ: dọn các phiếu do tool tạo từ cutoff trở đi.
                # Đây là cleanup có mục tiêu; không dùng để xóa phiếu người khác/nội dung lạ.
                if force_remove_after_surgery and _is_tool_content(e):
                    cid = e.get("id_delete") or e.get("id_edit")
                    if cid:
                        print(f"   [DỌN {phase}][SURGERY] Thu hồi + xóa phiếu sau mốc đi mổ {time_full} ({creator})")
                        try:
                            if "mới" in chuan_hoa_unicode(stt) and e.get("id_delete"):
                                delete_cham_soc_new_by_id(driver, e.get("id_delete"))
                            else:
                                open_cham_soc_by_id(driver, e.get("id_edit") or cid)
                                WebDriverWait(driver, 10).until(EC.visibility_of_element_located((By.ID, "txtThoiGianLap")))
                                click_thu_hoi_va_xoa(driver)
                        except Exception as _e:
                            print(f"      [WARN] Không xoá được phiếu sau mổ: {_e}")
                        try:
                            back_btn = driver.find_element(By.XPATH, "//a[contains(@onclick, 'fnbackFormChamSoc')]")
                            driver.execute_script("arguments[0].click();", back_btn)
                            time.sleep(0.8)
                        except Exception as _e:
                            LOG.debug(f"[except] {_e}")
                    try:
                        cache.get(time_full, []).remove(e)
                    except Exception as _e:
                        LOG.debug(f"[except] {_e}")
                    continue

                # 1) Xoá phiếu 'Mới' (dư)
                if "mới" in chuan_hoa_unicode(stt):
                    cid = e.get("id_delete") or e.get("id_edit")
                    if cid:
                        print(f"   [DỌN {phase}] Xóa phiếu 'Mới' {time_full} ({creator})")
                        delete_cham_soc_new_by_id(driver, cid)
                    # remove khỏi cache
                    try:
                        cache.get(time_full, []).remove(e)
                    except Exception as _e:  # was: bare except
                        LOG.debug(f"[except] {_e}")
                        pass
                    continue

                # 2) Phiếu sai giờ (không thuộc danh sách giờ cần có) => chỉ xoá nếu do tool tạo
                if hhmm and valid_times and hhmm not in valid_times and _is_tool_content(e):
                    cid = e.get("id_edit")
                    if cid:
                        print(f"   [DỌN {phase}] Thu hồi + xóa phiếu sai giờ {time_full} ({creator})")
                        try:
                            open_cham_soc_by_id(driver, cid)
                            # chờ form
                            WebDriverWait(driver, 10).until(EC.visibility_of_element_located((By.ID, "txtThoiGianLap")))
                            click_thu_hoi_va_xoa(driver)
                        except Exception as _e:
                            print(f"      [WARN] Không xoá được: {_e}")
                        # về danh sách nếu cần
                        try:
                            back_btn = driver.find_element(By.XPATH, "//a[contains(@onclick, 'fnbackFormChamSoc')]")
                            driver.execute_script("arguments[0].click();", back_btn)
                            time.sleep(0.8)
                        except Exception as _e:  # was: bare except
                            LOG.debug(f"[except] {_e}")
                            pass
                    try:
                        cache.get(time_full, []).remove(e)
                    except Exception as _e:  # was: bare except
                        LOG.debug(f"[except] {_e}")
                        pass
            except Exception as _e:  # was: bare except
                LOG.debug(f"[except] {_e}")
                continue

    # dọn key rỗng
    for k in list(cache.keys()):
        if not cache[k]:
            del cache[k]

def _creator_matches_expected(creator, expected_creator):
    """So khớp người lập hiện có với người lập cần có theo lịch điều dưỡng hiện tại."""
    expected = str(expected_creator or "").strip()
    if not expected:
        return True
    return kiem_tra_ten_trung_khop(creator, [expected])


def kiem_tra_bang_cached(
    cache,
    time_str,
    gio_target,
    noi_dung,
    list_ten_dieu_duong,
    dien_bien_mong_muon="",
    needs_vitals=False,
    expected_creator="",
):
    """Kiểm tra bằng cache (KHÔNG quét lại tất cả trang mỗi giờ).

    Trạng thái trả về:
    - PERFECT: phiếu đã đúng giờ + nội dung + sinh hiệu + đúng người lập theo lịch.
    - UPDATE: có phiếu trùng đúng mốc giờ nhưng sai nội dung/sinh hiệu và có id sửa;
      thu hồi rồi cập nhật ngay trên phiếu đó.
    - EDIT: phiếu cũ dạng lỗi cần thu hồi/xóa rồi tạo lại.
    - SKIP: có phiếu nhưng EMR không trả id sửa/xóa, nên không tạo trùng.
    - MISSING: chưa có phiếu.
    """
    lst = (cache or {}).get(time_str, [])
    if not lst:
        LOG.debug(_ctx_prefix() + f"[check_cached] time={time_str} => MISSING (no rows)")
        return "MISSING", None

    # ưu tiên phiếu 'Hoàn tất' khi chọn candidate (nhưng vẫn phải check tất cả để tìm PERFECT)
    def score(e):
        stt = chuan_hoa_unicode(e.get("status") or "")
        return 0 if "hoàn tất" in stt else (1 if "mới" in stt else 2)

    lst2 = sorted(lst, key=score)

    # chuẩn hoá mong muốn để log/so sánh
    exp_care = noi_dung or ""
    exp_db0 = ""
    if dien_bien_mong_muon:
        exp_db0 = dien_bien_mong_muon.split("\n")[0].strip()

    best_update_candidate = None
    best_update_reason = ""
    best_update_priority = None

    # Quét hết các phiếu trùng giờ trước khi quyết định sửa để không bỏ sót
    # một phiếu PERFECT nằm sau một phiếu sai/phiếu trùng.
    for e in lst2:
        creator = e.get("creator", "") or ""
        care_ok = True
        db_ok = True
        dhst_ok = True

        if needs_vitals or gio_target in [5, 16]:
            dhst_ok = bool(e.get("nt") and e.get("temp") and e.get("mach") and e.get("ha"))

        if exp_care:
            care_ok = kiem_tra_noi_dung_cham_soc(e.get("cham_soc", "") or "", exp_care)

        if exp_db0:
            db_ok = exp_db0 in ((e.get("dien_bien") or ""))

        creator_ok = _creator_matches_expected(creator, expected_creator)
        if care_ok and db_ok and dhst_ok and creator_ok:
            LOG.info(_ctx_prefix() + f"[check_cached] time={time_str} => PERFECT (status='{e.get('status','')}', creator='{creator}')")
            return "PERFECT", e.get("id_edit")

        # Đã có phiếu đúng mốc giờ nhưng sai bất kỳ thành phần nào: ưu tiên cập nhật
        # phiếu của team/tool; nếu không có thì vẫn cập nhật phiếu trùng giờ có id sửa.
        # Đây là luồng hợp nhất: không tạo thêm phiếu mới khi đã tồn tại cùng mốc giờ.
        if e.get("id_edit"):
            mismatch = []
            if not care_ok:
                mismatch.append("care")
            if not db_ok:
                mismatch.append("dien_bien")
            if not dhst_ok:
                mismatch.append("dhst")
            if not creator_ok:
                mismatch.append("creator")

            creator_in_list = kiem_tra_ten_trung_khop(creator, list_ten_dieu_duong)
            is_tool = _is_tool_content(e)
            status_norm = chuan_hoa_unicode(e.get("status") or "")
            priority = (
                0 if (creator_in_list or is_tool) else 1,
                0 if "hoàn tất" in status_norm else 1,
            )
            if best_update_candidate is None or priority < best_update_priority:
                best_update_candidate = e
                best_update_priority = priority
                best_update_reason = "diff=" + ",".join(mismatch)

    if best_update_candidate:
        LOG.info(
            _ctx_prefix()
            + f"[check_cached] time={time_str} => UPDATE ({best_update_reason}; "
            + f"id={best_update_candidate.get('id_edit')}, status='{best_update_candidate.get('status','')}', "
            + f"creator='{best_update_candidate.get('creator','')}')"
        )
        return "UPDATE", best_update_candidate.get("id_edit")

    # 2) không có PERFECT/UPDATE: quyết định EDIT hay SKIP
    # chọn 1 candidate tốt nhất để EDIT (ưu tiên 'Mới', rồi tool-content)
    edit_candidate = None
    for e in lst2:
        stt_norm = chuan_hoa_unicode(e.get("status") or "")
        creator = e.get("creator", "") or ""
        cham_soc_txt = e.get("cham_soc", "") or ""
        dien_bien_txt = e.get("dien_bien", "") or ""

        is_moi = ("mới" in stt_norm)
        is_tool = _is_tool_content(cham_soc_txt) or _is_tool_content(dien_bien_txt)
        creator_in_list = kiem_tra_ten_trung_khop(creator, list_ten_dieu_duong)

        # nếu DHST thiếu ở 16h/5h hoặc phiếu đặc biệt cần sinh hiệu và là phiếu của team => ưu tiên sửa
        if needs_vitals or gio_target in [5, 16]:
            dhst_ok = bool(e.get("nt") and e.get("temp") and e.get("mach") and e.get("ha"))
            if (not dhst_ok) and creator_in_list and e.get("id_edit"):
                edit_candidate = e
                break

        if (is_moi or is_tool) and e.get("id_edit"):
            edit_candidate = e
            break

        # trực đêm nhưng người lập không đúng (chỉ khi thuộc team) => sửa
        if (gio_target >= 17 or gio_target < 7) and creator_in_list and e.get("id_edit"):
            edit_candidate = e
            break

    if edit_candidate:
        LOG.info(_ctx_prefix() + f"[check_cached] time={time_str} => EDIT (id={edit_candidate.get('id_edit')}, status='{edit_candidate.get('status','')}', creator='{edit_candidate.get('creator','')}')")
        return "EDIT", edit_candidate.get("id_edit")

    # có phiếu nhưng không PERFECT và không được phép đụng => SKIP
    top = lst2[0]
    LOG.warning(_ctx_prefix() + f"[check_cached] time={time_str} => SKIP (existing row has no editable id; creator='{top.get('creator','')}', status='{top.get('status','')}')")
    return "SKIP", top.get("id_edit")


def don_dep_phieu_sai(driver, danh_sach_gio_can_co, list_ten_dieu_duong, ngay_lam_viec):
    print(f"   [Clean] Quét dọn phiếu lỗi...", end=" ")
    valid_times = [f"{h:02d}:00" for h in danh_sach_gio_can_co]
    
    # Xác định các ngày liên quan (hôm nay và ngày mai của ngày làm việc)
    dt_base = datetime.strptime(ngay_lam_viec, "%d/%m/%Y")
    current_date_str = dt_base.strftime('%d/%m/%Y')
    tomorrow_date_str = (dt_base + timedelta(days=1)).strftime('%d/%m/%Y')
    
    max_retries = 10; loop_count = 0

    while loop_count < max_retries:
        loop_count += 1; found_err = False
        try:
            rows = driver.find_elements(By.XPATH, "//div[@id='divDanhSachChamSocContent']//table/tbody/tr")
            for row in rows:
                try:
                    cols = row.find_elements(By.TAG_NAME, "td")
                    if len(cols) < 11: continue
                    
                    txt_time_full = cols[2].text.strip()
                    parts = txt_time_full.split(" ")
                    if len(parts) < 2: continue
                    
                    short_time = parts[0]; date_part = parts[1]
                    # Chỉ xử lý các phiếu nằm trong phạm vi ngày đang làm việc
                    if date_part != current_date_str and date_part != tomorrow_date_str: continue 

                    is_wrong_time = short_time not in valid_times
                    is_new_status = "Mới" in row.text
                    
                    if is_wrong_time or is_new_status:
                        txt_content = cols[10].text.strip()
                        txt_creator = cols[3].text.strip()
                        is_my_ticket = kiem_tra_ten_trung_khop(txt_creator, list_ten_dieu_duong)
                        is_tool_content = "dấu hiệu sinh tồn" in txt_content or "chỉ định thuốc" in txt_content
                        
                        if is_my_ticket and is_tool_content:
                            print(f"\n     [!] Xóa phiếu lỗi {txt_time_full} ({txt_creator})...", end=" ")
                            link = cols[2].find_element(By.TAG_NAME, "a")
                            driver.execute_script("arguments[0].click();", link)
                            time.sleep(1.5); click_thu_hoi_va_xoa(driver)
                            time.sleep(1.5); found_err = True; break
                except Exception as _e:
                    LOG.debug(f"[except] {_e}")  # was: except: continue
                    continue
            if not found_err: print("Sạch."); break
        except Exception as _e:
            LOG.debug(f"[except] {_e}")  # was: except: break
            break


def kiem_tra_bang(driver, time_str, gio_target, noi_dung, list_ten_dieu_duong, dien_bien_mong_muon=""):
    try:
        rows = driver.find_elements(By.XPATH, "//div[@id='divDanhSachChamSocContent']//table/tbody/tr")
        for row in rows:
            try:
                cols = row.find_elements(By.TAG_NAME, "td")
                if len(cols) < 11: continue
                
                txt_time = cols[2].text.strip()
                if time_str not in txt_time: continue 
                
                link = cols[2].find_element(By.TAG_NAME, "a")
                txt_creator = cols[3].text.strip()
                
                # Kiểm tra người lập nếu là ngoài giờ
                if (gio_target >= 17 or gio_target < 8):
                    if not kiem_tra_ten_trung_khop(txt_creator, list_ten_dieu_duong): return "EDIT", link
                
                # Kiểm tra có DHST ở các giờ 5, 16
                if gio_target in [5, 16]:
                    if not all([cols[i].text.strip() for i in range(4, 8)]): return "EDIT", link
                
                # Kiểm tra nội dung chăm sóc
                keywords_cs = [k.strip() for k in noi_dung.split("+") if k.strip()]
                txt_current_cs = chuan_hoa_unicode(cols[10].text.strip())
                for kw in keywords_cs:
                    if chuan_hoa_unicode(kw) not in txt_current_cs: return "EDIT", link

                # Kiểm tra diễn biến mong muốn (so theo từng dòng để ổn định và dễ mở rộng)
                if dien_bien_mong_muon:
                    txt_current_db = chuan_hoa_unicode(cols[9].text.strip())
                    for line in str(dien_bien_mong_muon).splitlines():
                        line_norm = chuan_hoa_unicode(line)
                        if line_norm and line_norm not in txt_current_db:
                            return "EDIT", link

                return "PERFECT", None
            except Exception as _e:
                LOG.debug(f"[except] {_e}")  # was: except: continue
                continue
        return "MISSING", None
    except Exception as _e:
        LOG.debug(f"[except] {_e}")  # was: except: return "MISSING", None
        return "MISSING", None
