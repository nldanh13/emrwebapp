# -*- coding: utf-8 -*-
"""cleanup_stray_care_new.py — Quét dọn phiếu chăm sóc trạng thái "Mới" (dở
dang, do tool tạo) còn tồn đọng trên EMR, trên nhiều bệnh nhân/nhiều ngày.

Bối cảnh: scan_cham_soc_cache() từng đọc sai cột (EMR thêm cột "Tác vụ"),
khiến input_care.py không bao giờ thấy được các phiếu "Mới" cũ để dọn —
chỉ dọn được phiếu trong ±1 ngày quanh ngày đang xử lý mỗi lần chạy bình
thường. Script này quét TOÀN BỘ lịch sử TT chăm sóc của từng BN được chỉ
định (không giới hạn ngày) để tìm và dọn phần tồn đọng đó.

CHỈ tính là "Mới tồn đọng do tool" khi ĐỦ CẢ 3: trạng thái = "Mới", người
lập khớp danh sách điều dưỡng (roster config.json -> ds_dieu_duong, gộp thêm
mọi tên trong lịch ten_dieu_duong và --extra-names nếu có), và nội dung khớp
mẫu do tool tạo (xem care_cache._is_tool_content). Phiếu do người khác tạo
tay không bị đụng tới.

Để tránh xóa nhầm phiếu đang được điều dưỡng thao tác dở ngay lúc quét, mặc
định BỎ QUA các phiếu có mốc giờ trong vòng --min-age-hours giờ gần đây
(mặc định 6h) — chỉ coi là "tồn đọng" khi đã đủ cũ.

EMR hiện chỉ cho SỬA/XÓA phiếu bằng đúng tài khoản của người đã tạo phiếu đó
(không còn xóa hộ bằng tài khoản khác được nữa). Vì vậy script chạy 2 giai
đoạn: (1) quét hết mọi BN bằng 1 tài khoản để TÌM phiếu tồn đọng, nhóm theo
người tạo; (2) nếu --confirm-delete, lần lượt đăng nhập đúng tài khoản EMR
của từng người tạo (tra theo tên trong secrets/nurse_emr_accounts.json —
xem worker/nurse_emr_accounts.py) rồi mới xóa. Phiếu của người CHƯA có tài
khoản EMR cấu hình trong nurse_emr_accounts.json sẽ được liệt kê trong báo
cáo nhưng KHÔNG xóa được — cần tự xóa tay hoặc bổ sung tài khoản trước.

MẶC ĐỊNH CHỈ BÁO CÁO, KHÔNG XÓA GÌ — chạy với --confirm-delete để thực sự
xóa các phiếu đã liệt kê.

Cách dùng:
    python cleanup_stray_care_new.py --patients patients.json --out report.json
    python cleanup_stray_care_new.py --patients patients.json --out report.json --confirm-delete
    # Thêm tên điều dưỡng cũ (đã nghỉ/đổi ca, không còn trong roster hiện tại):
    python cleanup_stray_care_new.py --patients patients.json --out report.json --extra-names "Nguyễn Văn A,Trần Thị B"

patients.json: mảng các object {"ma_bn": "...", "ho_ten": "..."} (ho_ten tuỳ
chọn, chỉ để log cho dễ đọc), hoặc đơn giản là mảng chuỗi mã BN.
"""
from __future__ import annotations

import argparse
import json
import sys
from datetime import datetime, timedelta

from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC

from utils import load_config, chuan_hoa_unicode
from shared.worker_session import open_session
from care_cache import scan_cham_soc_cache, _is_tool_content, delete_cham_soc_new_by_id
from input_care_utils import kiem_tra_ten_trung_khop, _dt_from_time_key
from nurse_emr_accounts import get_emr_account_for_nurse


def _lay_danh_sach_ten(config, extra_names=None):
    """Gom TẤT CẢ tên điều dưỡng có thể liên quan: roster (ds_dieu_duong —
    rộng nhất, còn giữ cả người không còn được xếp ca), mọi tên xuất hiện
    trong lịch trực (ten_dieu_duong, mọi ngày/ca — phòng khi roster bị xoá
    tên nhưng lịch cũ vẫn còn), và --extra-names người dùng tự bổ sung (cho
    người đã nghỉ việc/đổi ca, không còn ở cả 2 nguồn trên)."""
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

    roster = config.get("ds_dieu_duong")
    if isinstance(roster, list):
        for item in roster:
            _add(item)

    config_names = config.get("ten_dieu_duong")
    if isinstance(config_names, dict):
        for key, value in config_names.items():
            if key == "days" and isinstance(value, dict):
                for day_value in value.values():
                    _consume(day_value)
            else:
                _consume(value)

    for item in extra_names or []:
        _add(item)

    return names


def _is_old_enough(time_full, min_age_hours, now=None):
    """True nếu mốc giờ của phiếu đã cũ hơn min_age_hours so với hiện tại —
    dùng để loại các phiếu 'Mới' quá gần đây (có thể đang được thao tác dở,
    chưa chắc là tồn đọng do lỗi). Không parse được giờ thì coi là đủ cũ
    (không loại), vì bản thân dữ liệu bất thường không nên được bảo vệ ngầm.
    """
    if min_age_hours <= 0:
        return True
    dt = _dt_from_time_key(str(time_full or ""))
    if dt is None:
        return True
    now = now or datetime.now()
    return (now - dt) >= timedelta(hours=min_age_hours)


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


def _find_stray_new_entries(all_entries, list_nurse, min_age_hours=0, now=None):
    stray = []
    for e in all_entries:
        status_norm = chuan_hoa_unicode(e.get("status") or "")
        if "moi" not in status_norm:
            continue
        if not kiem_tra_ten_trung_khop(e.get("creator", ""), list_nurse):
            continue
        if not _is_tool_content(e):
            continue
        if not _is_old_enough(e.get("time_full"), min_age_hours, now=now):
            continue
        stray.append(e)
    return stray


def _build_stray_infos(stray):
    """Chuyển các bản ghi 'Mới' tồn đọng (dict thô từ scan_cham_soc_cache)
    thành info để đưa vào báo cáo, đồng thời nhóm theo tài khoản EMR của
    người tạo (tra qua worker/nurse_emr_accounts.py) — EMR hiện chỉ cho đúng
    tài khoản người tạo tự sửa/xóa phiếu của mình.

    Trả về (infos, by_username, passwords):
    - infos: list info theo đúng thứ tự stray, dùng để đưa vào report["found"].
    - by_username: {username: [info, ...]} — chỉ gồm info đã tra được tài khoản.
    - passwords: {username: password} — để đăng nhập lại ở Phase 2.
    """
    infos = []
    by_username = {}
    passwords = {}
    for e in stray:
        creator = e.get("creator") or ""
        account = get_emr_account_for_nurse(creator)
        username = account["username"] if account else None
        info = {
            "time_full": e.get("time_full"),
            "creator": creator,
            "cham_soc": (e.get("cham_soc") or "")[:200],
            "dien_bien": (e.get("dien_bien") or "")[:200],
            "id_delete": e.get("id_delete") or e.get("id_edit"),
            "emr_account": username,
            "delete_attempted": False,
            "delete_blocked_reason": None if username else (
                f"Chưa cấu hình tài khoản EMR cho '{creator}' trong "
                "secrets/nurse_emr_accounts.json (tab Lịch điều dưỡng) — "
                "EMR chỉ cho đúng tài khoản người tạo tự xóa."
            ),
        }
        infos.append(info)
        if username:
            by_username.setdefault(username, []).append(info)
            passwords.setdefault(username, account["password"])
    return infos, by_username, passwords


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
    parser.add_argument(
        "--min-age-hours", type=float, default=6.0,
        help="Chỉ coi là tồn đọng nếu mốc giờ phiếu cũ hơn X giờ so với hiện tại (mặc định 6, đặt 0 để tắt)",
    )
    parser.add_argument(
        "--extra-names", default="",
        help="Tên điều dưỡng bổ sung (ngoài roster/lịch trực hiện tại), cách nhau bằng dấu phẩy — cho người đã nghỉ/đổi ca",
    )
    args = parser.parse_args()

    patients = _load_patients(args.patients)
    if not patients:
        print(">>> Không có bệnh nhân nào trong file --patients. Dừng.")
        return 0

    config = load_config()
    extra_names = [n.strip() for n in args.extra_names.split(",") if n.strip()]
    list_nurse = _lay_danh_sach_ten(config, extra_names=extra_names)

    mode_text = "XÓA THẬT" if args.confirm_delete else "CHỈ BÁO CÁO (không xóa gì)"
    print(f">>> Quét dọn phiếu chăm sóc 'Mới' tồn đọng — {len(patients)} BN — chế độ: {mode_text}")
    print(f">>> Chỉ tính tồn đọng nếu cũ hơn {args.min_age_hours:g}h — {len(list_nurse)} tên điều dưỡng được nhận diện")

    report = {"mode": ("delete" if args.confirm_delete else "report_only"), "patients": []}
    # patient_plans: mỗi phần tử {"ma_bn", "entry", "by_username": {username: [info, ...]}}
    # username=None nghĩa là không tra được tài khoản EMR riêng cho người tạo phiếu đó.
    patient_plans = []
    account_passwords = {}   # username -> password
    account_order = []       # thứ tự tài khoản lần đầu xuất hiện (không tính None)

    with open_session("/dev/null", config=config) as ws:
        # ── PHASE 1: quét hết mọi BN (dùng 1 tài khoản, chỉ ĐỌC nên không bị
        # luật "chỉ tài khoản người tạo mới sửa/xóa được" chi phối) để TÌM
        # phiếu tồn đọng, nhóm theo tài khoản EMR của người tạo.
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
            stray = _find_stray_new_entries(all_entries, list_nurse, min_age_hours=args.min_age_hours)
            print(f"   Tìm thấy {len(stray)} phiếu 'Mới' do tool tạo còn sót")

            infos, by_username, found_passwords = _build_stray_infos(stray)
            for info in infos:
                entry["found"].append(info)
                acc_text = info["emr_account"] or "CHƯA CẤU HÌNH"
                print(f"      - {info['time_full']} ({info['creator']} -> tài khoản: {acc_text}): {info['cham_soc'][:60]}")
            for username, password in found_passwords.items():
                account_passwords.setdefault(username, password)
                if username not in account_order:
                    account_order.append(username)

            patient_plans.append({"ma_bn": ma_bn, "entry": entry, "by_username": by_username})
            _write_report(args.out, report)

            try:
                ws.goto_inpatient_list()
            except Exception:
                pass

        # ── PHASE 2: nếu được xác nhận xóa, lần lượt đăng nhập đúng tài khoản
        # của từng người tạo rồi mới xóa phiếu của người đó — hết mọi BN của
        # 1 tài khoản mới đổi sang tài khoản kế tiếp (giống input_care.py).
        if args.confirm_delete:
            for username in account_order:
                password = account_passwords[username]
                prev_username = str(ws.config.get("username") or "").strip()
                if username != prev_username:
                    print(f"\n>>> Đổi sang tài khoản EMR: {username}")
                    if not ws.switch_account(username, password):
                        print(f"   [WARN] Không đổi được tài khoản EMR ({username}); bỏ qua các phiếu của tài khoản này.")
                        continue

                for plan in patient_plans:
                    infos = plan["by_username"].get(username)
                    if not infos:
                        continue
                    ma_bn = plan["ma_bn"]
                    print(f"\n[BN {ma_bn}] xóa {len(infos)} phiếu của tài khoản {username}")
                    try:
                        ws.search_patient(ma_bn, allow_completed=True)
                        wait = ws.wait
                        wait.until(EC.element_to_be_clickable((By.XPATH, "//i[contains(@class, 'fa-eye')]"))).click()
                        wait.until(EC.element_to_be_clickable((By.ID, "btnTTCS"))).click()
                    except Exception as e:
                        for info in infos:
                            info["delete_blocked_reason"] = f"Không mở lại được hồ sơ BN để xóa: {e}"
                        print(f"   [SKIP] Không mở lại được hồ sơ BN: {e}")
                        _write_report(args.out, report)
                        continue

                    driver = ws.driver
                    for info in infos:
                        if not info["id_delete"]:
                            info["delete_blocked_reason"] = "Không có id để xóa"
                            print(f"      - {info['time_full']}: [WARN] không có id để xóa, bỏ qua")
                            continue
                        delete_cham_soc_new_by_id(driver, info["id_delete"])
                        info["delete_attempted"] = True
                        print(f"      - {info['time_full']}: đã gửi lệnh xóa")

                    _write_report(args.out, report)
                    try:
                        ws.goto_inpatient_list()
                    except Exception:
                        pass

    total_found = sum(len(p["found"]) for p in report["patients"])
    total_attempted = sum(1 for p in report["patients"] for f in p["found"] if f["delete_attempted"])
    total_blocked = sum(1 for p in report["patients"] for f in p["found"] if f["delete_blocked_reason"] and not f["delete_attempted"])
    _write_report(args.out, report)

    if args.confirm_delete:
        tail = f", đã gửi lệnh xóa {total_attempted}, không xóa được {total_blocked} (xem delete_blocked_reason trong báo cáo)."
    else:
        tail = ". Chưa xóa gì — thêm --confirm-delete để xóa."
    print(f"\n>>> XONG. Tổng cộng tìm thấy {total_found} phiếu 'Mới' tồn đọng{tail}")
    print(f">>> Báo cáo chi tiết: {args.out}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
