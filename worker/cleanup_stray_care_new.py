# -*- coding: utf-8 -*-
"""cleanup_stray_care_new.py — Quét dọn phiếu chăm sóc trạng thái "Mới" (dở
dang, do tool tạo) còn tồn đọng trên EMR, trên nhiều bệnh nhân/nhiều ngày.

Bối cảnh: scan_cham_soc_cache() từng đọc sai cột (EMR thêm cột "Tác vụ"),
khiến input_care.py không bao giờ thấy được các phiếu "Mới" cũ để dọn —
chỉ dọn được phiếu trong ±1 ngày quanh ngày đang xử lý mỗi lần chạy bình
thường. Script này quét TOÀN BỘ lịch sử TT chăm sóc của từng BN được chỉ
định (không giới hạn ngày) để tìm và dọn phần tồn đọng đó.

CHỈ tính là "Mới tồn đọng do tool" khi ĐỦ CẢ 3: trạng thái = "Mới", người
lập khớp tên trong danh sách điều dưỡng (config.json -> ten_dieu_duong), và
nội dung khớp mẫu do tool tạo (xem care_cache._is_tool_content). Phiếu do
người khác tạo tay không bị đụng tới.

MẶC ĐỊNH CHỈ BÁO CÁO, KHÔNG XÓA GÌ — chạy với --confirm-delete để thực sự
xóa các phiếu đã liệt kê.

Cách dùng:
    python cleanup_stray_care_new.py --patients patients.json --out report.json
    python cleanup_stray_care_new.py --patients patients.json --out report.json --confirm-delete

patients.json: mảng các object {"ma_bn": "...", "ho_ten": "..."} (ho_ten tuỳ
chọn, chỉ để log cho dễ đọc), hoặc đơn giản là mảng chuỗi mã BN.
"""
from __future__ import annotations

import argparse
import json
import sys

from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC

from utils import load_config, chuan_hoa_unicode
from shared.worker_session import open_session
from care_cache import scan_cham_soc_cache, _is_tool_content, delete_cham_soc_new_by_id
from input_care_utils import kiem_tra_ten_trung_khop


def _lay_danh_sach_ten(config_names):
    """Gom mọi tên điều dưỡng xuất hiện trong ten_dieu_duong (mọi ngày/ca)."""
    names = []
    seen = set()

    def _add(name):
        s = str(name or "").strip()
        if not s:
            return
        key = chuan_hoa_unicode(s)
        if key in seen:
            return
        seen.add(key)
        names.append(s)

    def _consume(value):
        if isinstance(value, list):
            for item in value:
                _add(item)
        elif isinstance(value, dict):
            for k in ("work", "oncall", "ca_lam", "ca_truc", "caLam", "caTruc", "regular", "day", "night", "direct"):
                sub = value.get(k)
                if isinstance(sub, list):
                    for item in sub:
                        _add(item)

    if isinstance(config_names, dict):
        for key, value in config_names.items():
            if key == "days" and isinstance(value, dict):
                for day_value in value.values():
                    _consume(day_value)
            else:
                _consume(value)
    return names


def _load_patients(path):
    with open(path, "r", encoding="utf-8") as f:
        raw = json.load(f)
    out = []
    for row in raw or []:
        if isinstance(row, str):
            ma_bn, ho_ten = row.strip(), ""
        elif isinstance(row, dict):
            ma_bn = str(row.get("ma_bn") or "").strip()
            ho_ten = str(row.get("ho_ten") or "").strip()
        else:
            continue
        if ma_bn:
            out.append({"ma_bn": ma_bn, "ho_ten": ho_ten})
    return out


def _find_stray_new_entries(all_entries, list_nurse):
    stray = []
    for e in all_entries:
        status_norm = chuan_hoa_unicode(e.get("status") or "")
        if "moi" not in status_norm:
            continue
        if not kiem_tra_ten_trung_khop(e.get("creator", ""), list_nurse):
            continue
        if not _is_tool_content(e):
            continue
        stray.append(e)
    return stray


def _write_report(path, report):
    """Ghi báo cáo ra đĩa — gọi lại sau MỖI BN, không chỉ lúc kết thúc, để lỡ
    script bị ngắt giữa chừng (mất mạng, Chrome crash...) vẫn còn kết quả các
    BN đã xử lý xong, không mất trắng."""
    try:
        with open(path, "w", encoding="utf-8") as f:
            json.dump(report, f, ensure_ascii=False, indent=2)
    except Exception as e:
        print(f"   [WARN] Không ghi được báo cáo tạm: {e}")


def main():
    parser = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--patients", required=True, help="File JSON danh sách BN cần quét")
    parser.add_argument("--out", default="cleanup_stray_care_report.json", help="File JSON kết quả")
    parser.add_argument("--confirm-delete", action="store_true", help="Thực sự xóa phiếu tìm thấy (mặc định chỉ báo cáo)")
    args = parser.parse_args()

    patients = _load_patients(args.patients)
    if not patients:
        print(">>> Không có bệnh nhân nào trong file --patients. Dừng.")
        return 0

    config = load_config()
    list_nurse = _lay_danh_sach_ten(config.get("ten_dieu_duong"))

    mode_text = "XÓA THẬT" if args.confirm_delete else "CHỈ BÁO CÁO (không xóa gì)"
    print(f">>> Quét dọn phiếu chăm sóc 'Mới' tồn đọng — {len(patients)} BN — chế độ: {mode_text}")

    report = {"mode": ("delete" if args.confirm_delete else "report_only"), "patients": []}

    with open_session("/dev/null", config=config) as ws:
        for p in patients:
            ma_bn, ho_ten = p["ma_bn"], p["ho_ten"]
            entry = {"ma_bn": ma_bn, "ho_ten": ho_ten, "found": [], "error": None}
            report["patients"].append(entry)
            print(f"\n[BN {ma_bn}] {ho_ten}")

            try:
                ws.search_patient(ma_bn, allow_completed=True)
            except Exception as e:
                entry["error"] = f"Không tìm/vào được BN: {e}"
                print(f"   [SKIP] {entry['error']}")
                _write_report(args.out, report)
                continue

            driver, wait = ws.driver, ws.wait
            try:
                wait.until(EC.element_to_be_clickable((By.XPATH, "//i[contains(@class, 'fa-eye')]"))).click()
                wait.until(EC.element_to_be_clickable((By.ID, "btnTTCS"))).click()
            except Exception as e:
                entry["error"] = f"Không vào được hồ sơ: {e}"
                print(f"   [SKIP] {entry['error']}")
                _write_report(args.out, report)
                continue

            _cache, all_entries = scan_cham_soc_cache(driver, "", all_dates=True)
            stray = _find_stray_new_entries(all_entries, list_nurse)
            print(f"   Tìm thấy {len(stray)} phiếu 'Mới' do tool tạo còn sót")

            for e in stray:
                info = {
                    "time_full": e.get("time_full"),
                    "creator": e.get("creator"),
                    "cham_soc": (e.get("cham_soc") or "")[:200],
                    "dien_bien": (e.get("dien_bien") or "")[:200],
                    "id_delete": e.get("id_delete") or e.get("id_edit"),
                    "delete_attempted": False,
                }
                entry["found"].append(info)
                print(f"      - {info['time_full']} ({info['creator']}): {info['cham_soc'][:60]}")

                if args.confirm_delete:
                    if info["id_delete"]:
                        delete_cham_soc_new_by_id(driver, info["id_delete"])
                        info["delete_attempted"] = True
                        print("        -> đã gửi lệnh xóa (chạy lại ở chế độ báo cáo để xác nhận đã mất chưa)")
                    else:
                        print("        -> [WARN] Không có id để xóa, bỏ qua")

            _write_report(args.out, report)

            try:
                ws.goto_inpatient_list()
            except Exception:
                pass

    total_found = sum(len(p["found"]) for p in report["patients"])
    total_attempted = sum(1 for p in report["patients"] for f in p["found"] if f["delete_attempted"])
    with open(args.out, "w", encoding="utf-8") as f:
        json.dump(report, f, ensure_ascii=False, indent=2)

    tail = f", đã gửi lệnh xóa {total_attempted}." if args.confirm_delete else ". Chưa xóa gì — thêm --confirm-delete để xóa."
    print(f"\n>>> XONG. Tổng cộng tìm thấy {total_found} phiếu 'Mới' tồn đọng{tail}")
    print(f">>> Báo cáo chi tiết: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
