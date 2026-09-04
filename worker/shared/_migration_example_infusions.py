# ============================================================
# MIGRATION EXAMPLE: input_infusions.py → dùng WorkerSession
# ============================================================
# File này chỉ để minh hoạ — KHÔNG chạy trực tiếp.
# Cho thấy cách thay thế ~40 dòng boilerplate bằng WorkerSession.
# ============================================================

# ── TRƯỚC ────────────────────────────────────────────────────────────────────
#
# def main():
#     ...
#     CONFIG = load_config()
#     result_path = os.path.join(...)
#     progress_path = progress_path_from_input(json_path or __file__)
#     patient_results = {}
#
#     DATA = chuan_bi_du_lieu_json(...)
#     if not DATA:
#         _log("[!] Không có dữ liệu dịch truyền để nhập.")
#         try:
#             with open(result_path, "w", ...) as rf:
#                 json.dump(build_worker_result({}, skipped_reason="..."), rf, ...)
#         except Exception as _e:
#             print(f"[WARN] Không ghi được result file rỗng: {_e}")
#         return 0
#
#     headless_mode = bool(CONFIG.get("headless", False))
#     print(f">>> Mở trình duyệt Chrome: headless={headless_mode}")
#     driver, wait = init_driver(headless=headless_mode)
#     try:
#         login_emr(driver, wait, CONFIG)
#         _ensure_inpatient_list(driver, wait, CONFIG)
#
#         for ma_bn, list_thuoc in DATA.items():
#             progress_keys = _result_keys_for_patient(ma_bn, list_thuoc)
#             mark_many(progress_path, "input_infusions", progress_keys, "running")
#             try:
#                 _search_patient(driver, wait, CONFIG, ma_bn)
#             except Exception as _e:
#                 err_text = str(_e)
#                 if "Đi mổ" in err_text or "không còn ở khoa" in err_text.lower():
#                     for dk in progress_keys:
#                         patient_results[dk] = {"success": True, "skipped": True, "reason": str(_e), "error": None}
#                     mark_many(progress_path, "input_infusions", progress_keys, "skipped", str(_e))
#                     continue
#                 raise
#
#             try:
#                 xu_ly_bn(driver, wait, list_thuoc, CONFIG.get('ten_dieu_duong') or {})
#                 done_keys = _result_keys_for_patient(ma_bn, list_thuoc)
#                 for dk in done_keys:
#                     patient_results[dk] = {"success": True, "error": None}
#                 mark_many(progress_path, "input_infusions", done_keys, "done")
#             except Exception as e:
#                 err_keys = _result_keys_for_patient(ma_bn, list_thuoc)
#                 for dk in err_keys:
#                     patient_results[dk] = {"success": False, "error": str(e)}
#                 mark_many(progress_path, "input_infusions", err_keys, "failed", str(e))
#                 try:
#                     _goto_inpatient_list(driver, wait, CONFIG)
#                 except Exception:
#                     pass
#                 continue
#
#         return 0
#     finally:
#         try: driver.quit()
#         except Exception: pass
#         try:
#             result_obj = build_worker_result(patient_results)
#             write_worker_result(result_path, result_obj)
#             print(f"[RESULT] ...")
#         except Exception as _we:
#             print(f"[WARN] Không ghi được result file: {_we}")


# ── SAU ───────────────────────────────────────────────────────────────────────
#
# from shared.worker_session import WorkerSession, open_session
#
# def main():
#     json_path     = sys.argv[1] if len(sys.argv) >= 2 else ""
#     targets_path  = sys.argv[2] if len(sys.argv) >= 3 else ""
#     result_path   = os.path.join(os.path.dirname(os.path.abspath(json_path or __file__)), "input_infusions_result.json")
#     progress_path = progress_path_from_input(json_path or __file__)
#
#     patient_ids, d_from, d_to, selected_dates, patient_dates = _read_targets(targets_path)
#     DATA = chuan_bi_du_lieu_json(json_path, patient_ids=patient_ids, ...)
#
#     if not DATA:
#         _log("[!] Không có dữ liệu dịch truyền để nhập.")
#         WorkerSession.skip(result_path, "Không có dữ liệu dịch truyền phù hợp sau khi lọc.")
#         return 0
#
#     def _after_login(ws):
#         ws.ensure_inpatient_list()          # <-- thay _ensure_inpatient_list(driver, wait, CONFIG)
#
#     with open_session(result_path, post_login=_after_login) as ws:
#         for ma_bn, list_thuoc in DATA.items():
#             progress_keys = _result_keys_for_patient(ma_bn, list_thuoc)
#             mark_many(progress_path, "input_infusions", progress_keys, "running")
#
#             try:
#                 ws.search_patient(ma_bn)    # <-- thay _search_patient(driver, wait, CONFIG, ma_bn)
#             except Exception as _e:
#                 err_text = str(_e)
#                 if "Đi mổ" in err_text or "không còn ở khoa" in err_text.lower():
#                     for dk in progress_keys:
#                         ws.mark_skipped(dk, str(_e))
#                     mark_many(progress_path, "input_infusions", progress_keys, "skipped", str(_e))
#                     continue
#                 raise
#
#             try:
#                 xu_ly_bn(ws.driver, ws.wait, list_thuoc, ws.config.get('ten_dieu_duong') or {})
#                 done_keys = _result_keys_for_patient(ma_bn, list_thuoc)
#                 for dk in done_keys:
#                     ws.mark_success(dk)
#                 mark_many(progress_path, "input_infusions", done_keys, "done")
#             except Exception as e:
#                 err_keys = _result_keys_for_patient(ma_bn, list_thuoc)
#                 for dk in err_keys:
#                     ws.mark_failed(dk, e)
#                 mark_many(progress_path, "input_infusions", err_keys, "failed", str(e))
#                 try:
#                     ws.goto_inpatient_list()    # <-- thay _goto_inpatient_list(driver, wait, CONFIG)
#                 except Exception:
#                     pass
#
#     return 0   # driver.quit() + write_worker_result() đã chạy tự động khi thoát with


# ── Tóm tắt những gì bị xóa ──────────────────────────────────────────────────
#
# XÓA (không còn cần nữa — WorkerSession lo hết):
#   - load_config()                          → ws.config
#   - init_driver(headless=...)              → ws.driver, ws.wait
#   - login_emr(driver, wait, CONFIG)        → tự động trong __enter__
#   - finally: driver.quit()                 → tự động trong __exit__
#   - finally: build_worker_result(...)      → tự động trong __exit__
#   - finally: write_worker_result(...)      → tự động trong __exit__
#   - _goto_inpatient_list(driver, wait, CONFIG)    → ws.goto_inpatient_list()
#   - _ensure_inpatient_list(driver, wait, CONFIG)  → ws.ensure_inpatient_list()
#   - _search_patient(driver, wait, CONFIG, ma_bn)  → ws.search_patient(ma_bn)
#   - patient_results[k] = {"success": True, ...}  → ws.mark_success(k)
#   - patient_results[k] = {"success": True, "skipped": True, ...} → ws.mark_skipped(k, reason)
#   - patient_results[k] = {"success": False, ...} → ws.mark_failed(k, error)
#
# GIỮ NGUYÊN (logic nghiệp vụ riêng của từng worker):
#   - chuan_bi_du_lieu_json(...)
#   - xu_ly_bn(ws.driver, ws.wait, ...)
#   - mark_many(progress_path, ...)
#   - _result_keys_for_patient(...)
