# -*- coding: utf-8 -*-
"""input_infusions.py — Tự động nhập dịch truyền vào EMR qua Selenium.

Phần tiện ích và chuẩn bị dữ liệu được tách sang input_infusions_utils.py.
"""
import time
import json
import os
import sys
import re
import unicodedata
from datetime import datetime, timedelta

from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.common.exceptions import TimeoutException

from utils import get_nurse_by_shift, load_config
from selenium_emr_helpers import wait_after_action as _wait_after_action
from task_progress_writer import mark_many, progress_path_from_input
from shared.worker_session import WorkerSession, open_session
from shared.json_io import read_json_critical

try:
    from clinical_rules import medication_skip_decision
except Exception:
    medication_skip_decision = None

# ── Import tiện ích từ module con ─────────────────────────────────────────────
from input_infusions_utils import (
    setup_logging, _log,
    _parse_date_dmy, _parse_hhmm_minutes, _resolve_doctor_by_time,
    _read_targets, chuan_bi_du_lieu_json,
    _norm_text, _build_display_med_name, _build_search_med_name,
    _extract_times_for_cleanup, _cleanup_display_name, _append_cleanup_tasks,
    _looks_like_tramadol_im,
)
from infusion_cleanup import (
    _compare_med_vs_web,
    _date_key_from_time_str,
    _delete_record_by_id,
    _get_total_pages_in_modal,
    _goto_page_in_modal,
    _info_matches_expected_med,
    _int_from_text,
    _norm_med_key,
    _norm_time_str,
    lay_danh_sach_chi_tiet_all_pages,
    tim_dich_truyen_legacy_parser_cu,
    xoa_dich_truyen_bi_rule_loai,
    xoa_dich_truyen_legacy_parser_cu,
    xoa_dich_truyen_thua_ngoai_du_lieu,
    xoa_trung_lap_100,
)
from infusion_form_actions import _nhap_moi_1_dich_truyen
from infusion_result_keys import result_keys_for_patient as _result_keys_for_patient


def _read_target_options(targets_path):
    try:
        if not targets_path or not os.path.exists(targets_path):
            return {}
        obj = read_json_critical(targets_path, {}, expected_type=dict) or {}
        if not isinstance(obj, dict):
            return {}
        return {
            'force_reinput_infusions': bool(
                obj.get('forceReinputInfusions')
                or obj.get('force_reinput_infusions')
                or obj.get('force_reinput')
            ),
            'recheck_existing': bool(obj.get('recheckExisting') or obj.get('recheck_existing')),
            'direct_emr_sync': bool(obj.get('directEmrSync') or obj.get('direct_emr_sync')),
            'visible_browser': bool(obj.get('visibleBrowser') or obj.get('visible_browser')),
            # Mặc định an toàn: KHÔNG xóa mọi dòng EMR chỉ vì parser hiện tại
            # không còn thấy chúng trong JSON. Chỉ bật khi người vận hành chủ động
            # yêu cầu đồng bộ trắng toàn bộ phiếu truyền dịch của ngày đang quản lý.
            'cleanup_orphan_infusions': bool(
                obj.get('cleanupOrphanInfusions') or obj.get('cleanup_orphan_infusions')
            ),
        }
    except Exception as exc:
        raise RuntimeError(f'Targets dịch truyền không hợp lệ: {exc}') from exc


# ==============================================================================
# XỬ LÝ NGHIỆP VỤ 1 BỆNH NHÂN
# ==============================================================================

def xu_ly_bn(
    driver,
    wait,
    med_list,
    config_names,
    force_reinput=False,
    cleanup_orphan_infusions=False,
):
    """Xử lý 1 bệnh nhân:
    - Quét đủ số trang phiếu truyền dịch để lấy tất cả bản ghi.
    - Với từng dịch truyền trong JSON: kiểm tra đúng tên, thể tích, tốc độ, thời gian, bác sĩ, điều dưỡng.
      Nếu sai -> xóa bản ghi sai và nhập lại.
    - Sau khi nhập xong: kiểm tra lần cuối, đúng hết mới qua BN tiếp theo (có cơ chế retry 1 lần).
    """
    # Tách 2 loại:
    # - danh_sach_hop_le: dịch truyền hiện tại cần nhập/đối chiếu
    # - cleanup_tasks: dịch truyền cũ đã bị rule loại, phải xóa nếu còn trên EMR
    danh_sach_hop_le = []
    cleanup_tasks = []
    managed_dates = set()
    for m in med_list:
        if m.get("__managed_date"):
            d = str(m.get("Managed_Date") or "").strip()
            if d:
                managed_dates.add(d)
            continue
        if m.get('__cleanup_only'):
            if (m.get('Time_Start_Str') or '').strip():
                cleanup_tasks.append(m)
            continue
        if (m.get('Time_Start_Str') or '').strip():
            danh_sach_hop_le.append(m)
        else:
            _log(f"      [!] BỎ QUA: '{m.get('Full_Name','')}' không có giờ bắt đầu. [BS: {m.get('Bac_Si','?')}]")

    if not danh_sach_hop_le and not cleanup_tasks and not managed_dates:
        return True

    # Sắp xếp theo giờ bắt đầu
    try:
        danh_sach_hop_le.sort(key=lambda x: datetime.strptime(x['Time_Start_Str'], "%H:%M %d/%m/%Y"))
    except Exception:
        pass
    try:
        cleanup_tasks.sort(key=lambda x: datetime.strptime(x['Time_Start_Str'], "%H:%M %d/%m/%Y"))
    except Exception:
        pass

    # --- 1) Quét dữ liệu web đủ trang ---
    _log("   -> Quét dữ liệu cũ (tất cả trang)...")
    danh_sach_web, total_pages = lay_danh_sach_chi_tiet_all_pages(driver, wait)
    _log(f"      [i] Tổng số trang phiếu truyền dịch: {total_pages}")

    expected_keys = set()
    for _m in danh_sach_hop_le:
        _s = (_m.get('Time_Start_Str') or '').strip()
        expected_keys.add((_norm_med_key(_m.get('Full_Name', '')), _norm_time_str(_s)))

    # --- 1a) Xóa các bản dịch truyền cũ đã bị rule loại khỏi dữ liệu chuẩn ---
    cleanup_cnt = xoa_dich_truyen_bi_rule_loai(driver, wait, danh_sach_web, cleanup_tasks, danh_sach_hop_le)
    if cleanup_cnt:
        _log(f"      [i] Đã xóa {cleanup_cnt} bản dịch truyền cũ bị rule loại. Quét lại để cập nhật...")
        time.sleep(0.8)
        danh_sach_web, total_pages = lay_danh_sach_chi_tiet_all_pages(driver, wait)

    # --- 1a.1) Dọn có mục tiêu artifact parser cũ nếu bản đúng đã có trên EMR ---
    legacy_cnt = xoa_dich_truyen_legacy_parser_cu(
        driver, wait, danh_sach_web, danh_sach_hop_le
    )
    if legacy_cnt:
        _log(f"      [i] Đã xóa {legacy_cnt} dòng legacy do parser cũ. Quét lại để cập nhật...")
        time.sleep(0.8)
        danh_sach_web, total_pages = lay_danh_sach_chi_tiet_all_pages(driver, wait)

    # --- 1a.2) Xóa các dòng thừa trong ngày đang quản lý nhưng không còn trong JSON chuẩn ---
    orphan_cnt = xoa_dich_truyen_thua_ngoai_du_lieu(
        driver,
        wait,
        danh_sach_web,
        managed_dates,
        danh_sach_hop_le,
        allow_delete=cleanup_orphan_infusions,
    )
    if orphan_cnt:
        _log(f"      [i] Đã xóa {orphan_cnt} dòng dịch truyền thừa không còn trong dữ liệu chuẩn. Quét lại để cập nhật...")
        time.sleep(0.8)
        danh_sach_web, total_pages = lay_danh_sach_chi_tiet_all_pages(driver, wait)

    if not danh_sach_hop_le:
        _log("   [v] Chỉ dọn bản dịch truyền cũ/thừa, không có dịch truyền mới cần nhập.")
        return True

    # --- 1b) Xóa bản trùng lặp 100% ---
    del_cnt = xoa_trung_lap_100(driver, wait, danh_sach_web, keys_filter=expected_keys)
    if del_cnt:
        _log(f"      [i] Đã xóa {del_cnt} bản trùng lặp (trùng 100%). Quét lại để cập nhật...")
        time.sleep(0.6)
        danh_sach_web, total_pages = lay_danh_sach_chi_tiet_all_pages(driver, wait)

    # --- 2) Đối chiếu từng dịch truyền trong data ---
    for med in danh_sach_hop_le:
        str_start = (med.get('Time_Start_Str') or '').strip()
        key = (_norm_med_key(med.get('Full_Name', '')), _norm_time_str(str_start))
        ten_y_ta_chuan = get_nurse_by_shift(str_start, config_names)

        candidates = danh_sach_web.get(key, []) or []

        if force_reinput and candidates:
            _log(f"      [↻] KIỂM TRA/SỬA LẠI: xóa bản hiện có để nhập lại đúng dữ liệu và số lô: {med.get('Full_Name')} ({str_start})")
            for info in candidates:
                if info.get("id"):
                    _delete_record_by_id(driver, wait, info["id"])
            time.sleep(0.5)
            danh_sach_web, total_pages = lay_danh_sach_chi_tiet_all_pages(driver, wait)
            candidates = danh_sach_web.get(key, []) or []

        ok_infos = []
        bad_infos = []
        best_errs = None
        best_info = None
        for info in candidates:
            errs = _compare_med_vs_web(med, info, ten_y_ta_chuan)
            if not errs:
                ok_infos.append(info)
            else:
                bad_infos.append((info, errs))
                if best_errs is None or len(errs) < len(best_errs):
                    best_errs = errs
                    best_info = info

        if ok_infos:
            if bad_infos:
                _log(f"      [i] Đã có bản đúng nhưng còn {len(bad_infos)} bản sai cùng thuốc/giờ -> xóa bản sai còn sót.")
                for info, errs in bad_infos:
                    if info.get("id"):
                        _delete_record_by_id(driver, wait, info["id"])
                time.sleep(0.5)
                danh_sach_web, total_pages = lay_danh_sach_chi_tiet_all_pages(driver, wait)
            _log(f"      [v] BỎ QUA: {med.get('Full_Name')} ({str_start}) đã đúng. [BS: {med.get('Bac_Si','?')} | DD: {ten_y_ta_chuan or '?'}]")
            continue

        if candidates:
            if best_errs:
                _log(f"      [!] PHÁT HIỆN SAI: {med.get('Full_Name')} ({str_start}) -> xóa và nhập lại | Lỗi: {', '.join(best_errs)} [BS: {med.get('Bac_Si','?')} | DD: {ten_y_ta_chuan or '?'}]")
            else:
                _log(f"      [!] PHÁT HIỆN SAI: {med.get('Full_Name')} ({str_start}) -> xóa và nhập lại [BS: {med.get('Bac_Si','?')} | DD: {ten_y_ta_chuan or '?'}]")
            for info in candidates:
                if info.get("id"):
                    _delete_record_by_id(driver, wait, info["id"])
            time.sleep(0.5)

        _log(f"      [+] NHẬP: {med.get('Full_Name')} ({str_start}) [BS: {med.get('Bac_Si','?')} | DD: {ten_y_ta_chuan or '?'}]")
        _nhap_moi_1_dich_truyen(driver, wait, med, config_names)

    # --- 2b) Sau khi nhập xong, dọn legacy lần nữa.
    # Nếu đầu lượt chưa có bản đúng thay thế thì bây giờ bản mới đã được nhập;
    # chỉ lúc này mới đủ điều kiện xóa an toàn dòng ``Pha natriclorid...`` cũ.
    try:
        web_after_insert, _ = lay_danh_sach_chi_tiet_all_pages(driver, wait)
        legacy_cnt2 = xoa_dich_truyen_legacy_parser_cu(
            driver, wait, web_after_insert, danh_sach_hop_le
        )
        if legacy_cnt2:
            _log(f"   [i] Đã xóa {legacy_cnt2} dòng legacy do parser cũ sau khi nhập bản đúng.")
            time.sleep(0.6)
    except Exception as exc:
        _log(f"   [CLEANUP_LEGACY][!] Không hoàn tất được lượt dọn legacy sau nhập: {exc}")

    # --- 3) Kiểm tra lần cuối ---
    def _final_check_and_fix_once():
        web_now, _pages = lay_danh_sach_chi_tiet_all_pages(driver, wait)

        # Legacy parser artifact còn sót cũng là lỗi cuối. Thử dọn đúng 1 lần;
        # nếu vẫn còn thì FAIL BN thay vì báo OK chỉ vì expected mới đã tồn tại.
        legacy_left = tim_dich_truyen_legacy_parser_cu(web_now, danh_sach_hop_le)
        if legacy_left:
            _log(
                f"   [!] KIỂM TRA CUỐI: còn {len(legacy_left)} dòng legacy parser cũ "
                "-> dọn có mục tiêu 1 lần..."
            )
            xoa_dich_truyen_legacy_parser_cu(
                driver, wait, web_now, danh_sach_hop_le
            )
            time.sleep(0.8)
            web_now, _pages = lay_danh_sach_chi_tiet_all_pages(driver, wait)
            legacy_left = tim_dich_truyen_legacy_parser_cu(web_now, danh_sach_hop_le)
            if legacy_left:
                for info, med in legacy_left:
                    _log(
                        f"   [!] LEGACY VẪN CÒN: {info.get('ten') or ''} "
                        f"({info.get('tg_bat_dau') or ''}) -> expected "
                        f"{med.get('Full_Name') or med.get('Search_Name') or ''}."
                    )
                return False

        problems = []

        for med in danh_sach_hop_le:
            str_start = (med.get('Time_Start_Str') or '').strip()
            key = (_norm_med_key(med.get('Full_Name', '')), _norm_time_str(str_start))
            ten_y_ta_chuan = get_nurse_by_shift(str_start, config_names)
            candidates = web_now.get(key, []) or []

            if not candidates:
                problems.append((med, "THIẾU BẢN GHI", None))
                continue

            matched = False
            bad_count = 0
            last_errs = []
            last_info = None
            for info in candidates:
                errs = _compare_med_vs_web(med, info, ten_y_ta_chuan)
                if not errs:
                    matched = True
                else:
                    bad_count += 1
                    last_errs = errs
                    last_info = info
            if (not matched) or bad_count:
                problems.append((med, "SAI DỮ LIỆU" if not matched else "CÒN BẢN SAI CÙNG GIỜ", {"errs": last_errs, "info": last_info}))

        if not problems:
            _log("   [v] KIỂM TRA CUỐI: OK (đúng hết). ")
            return True

        _log(f"   [!] KIỂM TRA CUỐI: phát hiện {len(problems)} vấn đề -> sửa 1 lần...")
        for med, kind, meta in problems:
            str_start = (med.get('Time_Start_Str') or '').strip()
            key = (_norm_med_key(med.get('Full_Name', '')), _norm_time_str(str_start))
            try:
                web_now, _ = lay_danh_sach_chi_tiet_all_pages(driver, wait)
                for info in (web_now.get(key, []) or []):
                    if info.get("id"):
                        _delete_record_by_id(driver, wait, info["id"])
            except Exception:
                pass
            _nhap_moi_1_dich_truyen(driver, wait, med, config_names)

        time.sleep(1.5)

        web_now2, _pages = lay_danh_sach_chi_tiet_all_pages(driver, wait)
        legacy_left2 = tim_dich_truyen_legacy_parser_cu(web_now2, danh_sach_hop_le)
        if legacy_left2:
            _log(
                f"   [!] KIỂM TRA CUỐI SAU SỬA: còn {len(legacy_left2)} dòng legacy parser cũ "
                "-> FAIL để tránh báo OK giả."
            )
            return False
        for med in danh_sach_hop_le:
            str_start = (med.get('Time_Start_Str') or '').strip()
            key = (_norm_med_key(med.get('Full_Name', '')), _norm_time_str(str_start))
            ten_y_ta_chuan = get_nurse_by_shift(str_start, config_names)
            candidates = web_now2.get(key, []) or []
            ok = False
            bad_count = 0
            for info in candidates:
                if not _compare_med_vs_web(med, info, ten_y_ta_chuan):
                    ok = True
                else:
                    bad_count += 1
            if (not ok) or bad_count:
                extra = f", còn {bad_count} bản sai cùng giờ" if bad_count else ""
                _log(f"   [!] VẪN SAI/THIẾU: {med.get('Full_Name')} ({str_start}){extra} -> sẽ bỏ qua BN này để tránh kẹt. [BS: {med.get('Bac_Si','?')} | DD: {ten_y_ta_chuan or '?'}]")
                return False

        _log("   [v] KIỂM TRA CUỐI SAU SỬA: OK.")
        return True

    # Xóa trùng lặp 100% thêm lần nữa trước kiểm tra cuối
    try:
        web_tmp, _ = lay_danh_sach_chi_tiet_all_pages(driver, wait)
        del_cnt2 = xoa_trung_lap_100(driver, wait, web_tmp, keys_filter=expected_keys)
        if del_cnt2:
            _log(f"   [i] Đã xóa {del_cnt2} bản trùng lặp (trùng 100%) trước kiểm tra cuối.")
            time.sleep(0.6)
    except Exception:
        pass

    return _final_check_and_fix_once()


# ==============================================================================
# MAIN
# ==============================================================================

def main():
    json_path    = sys.argv[1] if len(sys.argv) >= 2 else ""
    targets_path = sys.argv[2] if len(sys.argv) >= 3 else ""

    base_dir = os.path.dirname(os.path.abspath(__file__))
    if not json_path:
        for cand in ["data_phan_loai_chuan_v16.json"]:
            p = os.path.join(base_dir, cand)
            if os.path.exists(p):
                json_path = p
                break

    result_path   = os.path.join(os.path.dirname(os.path.abspath(json_path or __file__)), "input_infusions_result.json")
    progress_path = progress_path_from_input(json_path or __file__)

    patient_ids, d_from, d_to, selected_dates, patient_dates = _read_targets(targets_path)
    target_options = _read_target_options(targets_path)
    force_reinput_infusions = bool(target_options.get('force_reinput_infusions'))
    cleanup_orphan_infusions = bool(target_options.get('cleanup_orphan_infusions'))
    config = load_config()
    # Dịch truyền ưu tiên tài khoản EMR riêng nếu đã cấu hình, để có thể chạy
    # song song với chăm sóc (tài khoản chính) mà không đăng nhập trùng phiên.
    # Không cấu hình -> giữ nguyên hành vi cũ (dùng tài khoản chính).
    if config.get('infusion_username'):
        config['username'] = config['infusion_username']
    if config.get('infusion_password'):
        config['password'] = config['infusion_password']
    if target_options.get('direct_emr_sync') or target_options.get('visible_browser'):
        config['headless'] = False
        _log('[i] Chế độ đồng bộ trực tiếp: mở Chrome để kiểm tra / nhập / sửa dịch truyền trên EMR.')
    if force_reinput_infusions:
        _log('[i] Chế độ kiểm tra/sửa lại dịch truyền đã nhập: sẽ nhập lại các dòng dịch truyền trong phạm vi chọn để cập nhật số lô nếu có.')
    DATA = chuan_bi_du_lieu_json(
        json_path,
        patient_ids=patient_ids,
        date_from=d_from,
        date_to=d_to,
        selected_dates=selected_dates,
        patient_dates=patient_dates,
    )

    if not DATA:
        _log("[!] Không có dữ liệu dịch truyền để nhập.")
        WorkerSession.skip(result_path, "Không có dữ liệu dịch truyền phù hợp sau khi lọc.")
        return 0

    def _after_login(ws: WorkerSession) -> None:
        ws.ensure_inpatient_list()

    with open_session(result_path, config=config, post_login=_after_login) as ws:
        for ma_bn, list_thuoc in DATA.items():
            # Bỏ qua BN không có gì để làm
            co_viec_can_lam = any(
                (m.get('Time_Start_Str') or '').strip() or m.get("__managed_date")
                for m in list_thuoc
            )
            if not co_viec_can_lam:
                _log(f"\n[{ma_bn}] Bỏ qua: không có dịch truyền hợp lệ hoặc bản cũ cần dọn.")
                continue

            _log(f"\n[{ma_bn}]")
            progress_keys = _result_keys_for_patient(ma_bn, list_thuoc)
            mark_many(progress_path, "input_infusions", progress_keys, "running")

            # Tìm BN trên danh sách nội trú
            try:
                ws.search_patient(ma_bn)
            except Exception as _e:
                err_text = str(_e)
                if ("Đi mổ" in err_text) or ("Gây mê hồi sức" in err_text) or ("không còn ở khoa" in err_text.lower()):
                    _log(f"[SKIP][WARD_STATUS] BN {ma_bn}: {_e}")
                    for dk in progress_keys:
                        ws.mark_skipped(dk, str(_e))
                    mark_many(progress_path, "input_infusions", progress_keys, "skipped", str(_e))
                    continue
                raise

            # Nhập dịch truyền
            try:
                # Mở hồ sơ bệnh nhân
                ws.wait.until(EC.element_to_be_clickable((By.XPATH, "//i[contains(@class, 'fa-eye')]"))).click()

                # Mở modal phiếu truyền dịch
                btn_ptd = ws.wait.until(EC.element_to_be_clickable((By.ID, "btnPTD")))
                ws.driver.execute_script("arguments[0].click();", btn_ptd)
                _wait_after_action(ws.driver, 0.8, ready_timeout=10)

                verified_ok = xu_ly_bn(
                    ws.driver,
                    ws.wait,
                    list_thuoc,
                    ws.config.get('ten_dieu_duong') or {},
                    force_reinput=force_reinput_infusions,
                    cleanup_orphan_infusions=cleanup_orphan_infusions,
                )
                if verified_ok is False:
                    raise RuntimeError(
                        "Kiểm tra cuối dịch truyền vẫn còn dòng thiếu/sai; không đánh dấu hoàn thành để tránh bỏ sót."
                    )

                # Đóng modal
                try:
                    close = ws.driver.find_element(By.XPATH, "//strong[normalize-space(text())='X']/ancestor::*[self::button or self::a][1]")
                    ws.driver.execute_script("arguments[0].click();", close)
                    _wait_after_action(ws.driver, 0.3, ready_timeout=6)
                except Exception:
                    pass

                # Back về danh sách
                btn_back = ws.wait.until(EC.element_to_be_clickable((By.ID, "buttonBackNT")))
                ws.driver.execute_script("arguments[0].click();", btn_back)
                ws.ensure_inpatient_list()

                # Ghi kết quả theo key "ma_bn::ngay_lam" cho từng ngày đã xử lý
                done_keys = _result_keys_for_patient(ma_bn, list_thuoc)
                for dk in done_keys:
                    ws.mark_success(dk)
                mark_many(progress_path, "input_infusions", done_keys, "done")

            except Exception as e:
                _log(f"[!] Lỗi BN {ma_bn}: {e}")
                err_keys = _result_keys_for_patient(ma_bn, list_thuoc)
                for dk in err_keys:
                    ws.mark_failed(dk, e)
                mark_many(progress_path, "input_infusions", err_keys, "failed", str(e))
                try:
                    ws.goto_inpatient_list()
                except Exception:
                    pass

        _log("\n>>> HOÀN THÀNH NHẬP DỊCH TRUYỀN.")

    return 0


if __name__ == "__main__":
    setup_logging()
    rc = main()
    # Đọc lại result file để lấy exit code chính xác
    try:
        _rp = os.path.join(
            os.path.dirname(os.path.abspath(sys.argv[1] if len(sys.argv) >= 2 else __file__)),
            "input_infusions_result.json"
        )
        if os.path.exists(_rp):
            _r = json.load(open(_rp, encoding="utf-8"))
            if _r.get("failed"):
                sys.exit(2)
    except Exception:
        pass
    sys.exit(rc if isinstance(rc, int) else 0)
