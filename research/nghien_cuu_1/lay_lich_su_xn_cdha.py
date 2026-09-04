# -*- coding: utf-8 -*-
"""
lay_lich_su_xn_cdha.py

Lấy lịch sử Xét nghiệm và Chẩn đoán hình ảnh từ EMR cho các nghiên cứu lâm sàng.
(Phần thuốc đã được tách ra khỏi script này do chất lượng parse text tự do không
đủ tin cậy cho mục đích nghiên cứu.)

Input mặc định:
  ds_hoan_tat.csv

Output mặc định:
  research_store/<project_id>/runs/<run_id>/
    mau_nghien_cuu.csv           # thông tin hành chính bệnh nhân
    du_lieu_goc.csv              # alias cho kho dữ liệu gốc
    du_lieu_ban_dau.csv          # danh sách thô từ bảng Hoàn tất (Bước 1)
    lich_su_xn.csv               # kết quả xét nghiệm (raw)
    lich_su_cdha.csv             # kết quả CĐHA (raw)
    normalized/                  # dữ liệu đã chuẩn hóa schema cố định
      patients.csv
      encounters.csv
      lab_results.csv
      imaging_results.csv
      patient_day.csv
      extract_status.csv
    progress.json
    errors.csv
    manifest.json
    input/ds_hoan_tat.csv

Cơ chế:
  - Bước 1 (--list-only): quét bảng danh sách Hoàn tất, tạo du_lieu_ban_dau.csv.
    Không mở popup Điều dưỡng, nhanh và ít lỗi.
  - Bước 3 (deep): mở từng bệnh nhân, lấy XN và CĐHA, commit theo lượt điều trị.
  - Resume tự động qua progress.json; crash giữa chừng chạy lại từ ca chưa xong.
  - Commit an toàn: giữ snapshot cũ đến khi XN+CĐHA đã lấy xong, ghi staging rồi replace.
  - visit_key phân biệt bệnh nhân đang nằm viện (inpatient) với đã xuất viện.

Ví dụ chạy:
  python lay_lich_su_xn_cdha.py
  python lay_lich_su_xn_cdha.py --headless
  python lay_lich_su_xn_cdha.py --from-date 01/05/2026 --to-date 31/05/2026
  python lay_lich_su_xn_cdha.py --project-id nghien_cuu_khang_sinh_sau_mo
  python lay_lich_su_xn_cdha.py --list-only --from-date 01/01/2026 --to-date 31/05/2026
"""

import argparse
import csv
import json
import os
import re
import shutil
import signal
import subprocess
import sys
import time
import threading
import unicodedata
import warnings
from datetime import datetime, timedelta
from html import unescape
from pathlib import Path
from urllib.parse import parse_qsl, urlencode, urlsplit, urlunsplit

from bs4 import BeautifulSoup
from selenium import webdriver
from selenium.webdriver.common.by import By
from selenium.webdriver.support.ui import WebDriverWait
from selenium.webdriver.support import expected_conditions as EC

try:
    sys.stdout.reconfigure(encoding="utf-8")
except Exception:
    pass


# ── Performance / stability knobs ───────────────────────────────────────────
# Mặc định ưu tiên tốc độ: không mở màn Điều dưỡng trước khi lấy XN/CĐHA.
# Màn Điều dưỡng hay mở cùng tab rồi gây lỗi DateTime/Back của EMR, làm quét chậm
# và kẹt click. Nếu cần lấy sâu thông tin hành chính từ Điều dưỡng, đặt
# RESEARCH_SKIP_NURSING_FIRST=0 trước khi chạy.
RESEARCH_SKIP_NURSING_FIRST = os.getenv("RESEARCH_SKIP_NURSING_FIRST", "1").strip().lower() not in {"0", "false", "no"}
FAST_UI = os.getenv("RESEARCH_FAST_UI", "1").strip().lower() not in {"0", "false", "no"}
# Chống treo im lặng: nếu không có log/heartbeat trong N giây thì ghi cảnh báo
# rồi thoát process để lần chạy sau resume từ progress.json. Mặc định 4 phút.
RESEARCH_WATCHDOG = os.getenv("RESEARCH_WATCHDOG", "1").strip().lower() not in {"0", "false", "no"}
RESEARCH_STALL_TIMEOUT_SEC = int(os.getenv("RESEARCH_STALL_TIMEOUT_SEC", "180") or "180")
RESEARCH_PAGE_LOAD_TIMEOUT_SEC = int(os.getenv("RESEARCH_PAGE_LOAD_TIMEOUT_SEC", "45") or "45")
RESEARCH_SCRIPT_TIMEOUT_SEC = int(os.getenv("RESEARCH_SCRIPT_TIMEOUT_SEC", "25") or "25")

# Theo dõi RAM/CPU nhẹ để chẩn đoán treo sau khi chạy lâu. Không dùng để
# quyết định commit dữ liệu; chỉ ghi resource_status.json/resource_log.jsonl.
RESEARCH_RESOURCE_MONITOR = os.getenv("RESEARCH_RESOURCE_MONITOR", "1").strip().lower() not in {"0", "false", "no"}
RESEARCH_RESOURCE_INTERVAL_SEC = int(os.getenv("RESEARCH_RESOURCE_INTERVAL_SEC", "30") or "30")
RESEARCH_RESOURCE_LOG_EVERY_SEC = int(os.getenv("RESEARCH_RESOURCE_LOG_EVERY_SEC", "120") or "120")
RESEARCH_CHROME_RAM_WARN_MB = int(os.getenv("RESEARCH_CHROME_RAM_WARN_MB", "2500") or "2500")
RESEARCH_TOTAL_TRACKED_RAM_WARN_MB = int(os.getenv("RESEARCH_TOTAL_TRACKED_RAM_WARN_MB", "3500") or "3500")

# Tự recycle Chrome để tránh leak RAM/treo lệnh Selenium sau khi chạy lâu.
# Dữ liệu đã commit theo từng lượt điều trị nên restart giữa các BN là an toàn.
RESEARCH_AUTO_RESTART_BROWSER = os.getenv("RESEARCH_AUTO_RESTART_BROWSER", "1").strip().lower() not in {"0", "false", "no"}
RESEARCH_CHROME_RESTART_EVERY = int(os.getenv("RESEARCH_CHROME_RESTART_EVERY", "30") or "30")
RESEARCH_CHROME_MAX_MB = int(os.getenv("RESEARCH_CHROME_MAX_MB", "1800") or "1800")
RESEARCH_RESTART_CHECK_EVERY = int(os.getenv("RESEARCH_RESTART_CHECK_EVERY", "1") or "1")
RESEARCH_BROWSER_QUIT_TIMEOUT_SEC = int(os.getenv("RESEARCH_BROWSER_QUIT_TIMEOUT_SEC", "10") or "10")
# Khi restart Chrome mà EMR/network chậm, driver.get(login.aspx) có thể trả
# net::ERR_CONNECTION_TIMED_OUT. Đây là lỗi hạ tầng tạm thời, không được làm
# hỏng cả phiên nghiên cứu; thử mở lại Chrome vài lần rồi resume từ BN hiện tại.
RESEARCH_BROWSER_RESTART_MAX_ATTEMPTS = int(os.getenv("RESEARCH_BROWSER_RESTART_MAX_ATTEMPTS", "5") or "5")
RESEARCH_BROWSER_RESTART_RETRY_DELAY_SEC = float(os.getenv("RESEARCH_BROWSER_RESTART_RETRY_DELAY_SEC", "8") or "8")
RESEARCH_BROWSER_RESTART_RETRY_BACKOFF_SEC = float(os.getenv("RESEARCH_BROWSER_RESTART_RETRY_BACKOFF_SEC", "5") or "5")
# Nếu Chrome vượt ngưỡng RAM ngay sau khi mở mới, việc restart liên tục có thể
# gây vòng lặp. Đặt tối thiểu số BN giữa hai lần restart do RAM.
RESEARCH_CHROME_RAM_RESTART_MIN_ITEMS = int(os.getenv("RESEARCH_CHROME_RAM_RESTART_MIN_ITEMS", "3") or "3")
# Khi có nhiều Chrome/Chromedriver treo sau timeout, dọn các tiến trình con còn sót
# do chính worker này mở. Không kill Chrome người dùng đang mở ngoài Selenium.
RESEARCH_CLEAN_OWNED_CHROME_ON_RESTART_FAIL = os.getenv("RESEARCH_CLEAN_OWNED_CHROME_ON_RESTART_FAIL", "1").strip().lower() not in {"0", "false", "no"}
# Khi chạy sâu nhiều trăm ca, EMR đôi lúc đóng popup xong nhưng vẫn còn
# trạng thái/modal/URL chi tiết làm ca kế tiếp đứng im trước khi in dòng FIND.
# Mặc định ép mở lại danh sách trước mỗi BN để chạy chậm hơn một chút nhưng ổn định hơn.
RESEARCH_FORCE_LIST_ON_PATIENT_START = os.getenv("RESEARCH_FORCE_LIST_ON_PATIENT_START", "1").strip().lower() not in {"0", "false", "no"}
# Giới hạn timeout HTTP lệnh Selenium/ChromeDriver để không treo vô hạn ở execute_script/click/get.
RESEARCH_SELENIUM_HTTP_TIMEOUT_SEC = int(os.getenv("RESEARCH_SELENIUM_HTTP_TIMEOUT_SEC", "60") or "60")

_WATCHDOG_LAST_TS = time.time()
_WATCHDOG_STAGE = "khởi động"
_WATCHDOG_STOP = threading.Event()
_WATCHDOG_LOCK = threading.Lock()

_RESOURCE_STOP = threading.Event()
_RESOURCE_LOCK = threading.Lock()
_RESOURCE_LAST_SNAPSHOT = {}
_RESOURCE_LAST_LOG_TS = 0.0


def touch_watchdog(stage=None):
    """Cập nhật heartbeat cho watchdog. Gọi ở mọi điểm có log/chuyển bước."""
    global _WATCHDOG_LAST_TS, _WATCHDOG_STAGE
    try:
        with _WATCHDOG_LOCK:
            _WATCHDOG_LAST_TS = time.time()
            if stage:
                _WATCHDOG_STAGE = str(stage)[:300]
    except Exception:
        pass



def _mb(value):
    try:
        return round(float(value) / (1024 * 1024), 1)
    except Exception:
        return 0.0


def _parse_tasklist_mem_mb(text):
    # Windows tasklist CSV: "123,456 K" hoặc "123.456 K" tùy locale.
    try:
        raw = str(text or "")
        digits = re.sub(r"[^0-9]", "", raw)
        if not digits:
            return 0.0
        return round(int(digits) / 1024, 1)
    except Exception:
        return 0.0


def collect_resource_snapshot():
    """Lấy ảnh chụp RAM của Python/Chrome/chromedriver/Node.
    Ưu tiên psutil nếu có; fallback tasklist trên Windows hoặc ps trên Linux.
    Hàm này không đụng WebDriver để tránh làm nặng thêm khi Selenium đang treo.
    """
    current_pid = os.getpid()
    snap = {
        "time": datetime.now().isoformat(timespec="seconds"),
        "pid": current_pid,
        "method": "unknown",
        "python_mb": 0.0,
        "chrome_mb": 0.0,
        "chromedriver_mb": 0.0,
        "node_mb": 0.0,
        "msedge_mb": 0.0,
        "total_tracked_mb": 0.0,
        "top": [],
        "warning": "",
    }
    rows = []
    try:
        import psutil  # type: ignore
        snap["method"] = "psutil"
        try:
            vm = psutil.virtual_memory()
            snap["system_total_mb"] = round(vm.total / (1024 * 1024), 1)
            snap["system_used_mb"] = round(vm.used / (1024 * 1024), 1)
            snap["system_percent"] = float(vm.percent)
        except Exception:
            pass
        for proc in psutil.process_iter(["pid", "name", "memory_info"]):
            try:
                name = (proc.info.get("name") or "").lower()
                rss = getattr(proc.info.get("memory_info"), "rss", 0) or 0
                mb = _mb(rss)
                if mb <= 0:
                    continue
                rows.append({"pid": int(proc.info.get("pid") or 0), "name": name, "mb": mb})
            except Exception:
                continue
    except Exception:
        try:
            if os.name == "nt":
                snap["method"] = "tasklist"
                cp = subprocess.run(
                    ["tasklist", "/FO", "CSV", "/NH"],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=8,
                )
                if cp.returncode == 0:
                    for rec in csv.reader(cp.stdout.splitlines()):
                        if len(rec) < 5:
                            continue
                        name = (rec[0] or "").lower()
                        try:
                            pid = int(rec[1])
                        except Exception:
                            pid = 0
                        mb = _parse_tasklist_mem_mb(rec[4])
                        if mb > 0:
                            rows.append({"pid": pid, "name": name, "mb": mb})
            else:
                snap["method"] = "ps"
                cp = subprocess.run(
                    ["ps", "-eo", "pid=,comm=,rss="],
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    errors="replace",
                    timeout=8,
                )
                if cp.returncode == 0:
                    for line in cp.stdout.splitlines():
                        parts = line.split(None, 2)
                        if len(parts) != 3:
                            continue
                        pid_s, name, rss_kb = parts
                        try:
                            mb = round(int(rss_kb) / 1024, 1)
                            rows.append({"pid": int(pid_s), "name": name.lower(), "mb": mb})
                        except Exception:
                            continue
        except Exception as e:
            snap["method"] = "unavailable"
            snap["error"] = str(e)[:300]

    def add_if(key, predicate):
        total = sum(r["mb"] for r in rows if predicate(r["name"]))
        snap[key] = round(total, 1)

    # Chỉ tính Python process hiện tại vào python_mb để không lẫn Python khác.
    for r in rows:
        if r.get("pid") == current_pid:
            snap["python_mb"] = round(r.get("mb") or 0, 1)
            break
    add_if("chrome_mb", lambda n: "chrome" in n and "driver" not in n)
    add_if("chromedriver_mb", lambda n: "chromedriver" in n)
    add_if("node_mb", lambda n: n.startswith("node") or "node.exe" in n)
    add_if("msedge_mb", lambda n: "msedge" in n and "driver" not in n)
    snap["total_tracked_mb"] = round(
        snap.get("python_mb", 0) + snap.get("chrome_mb", 0) +
        snap.get("chromedriver_mb", 0) + snap.get("node_mb", 0) + snap.get("msedge_mb", 0),
        1,
    )
    interesting = []
    for r in rows:
        name = r.get("name", "")
        if any(k in name for k in ("chrome", "chromedriver", "python", "node", "msedge")):
            interesting.append(r)
    interesting.sort(key=lambda x: x.get("mb", 0), reverse=True)
    snap["top"] = interesting[:12]

    warnings = []
    if snap.get("chrome_mb", 0) >= RESEARCH_CHROME_RAM_WARN_MB:
        warnings.append(f"Chrome RAM cao: {snap.get('chrome_mb')} MB")
    if snap.get("total_tracked_mb", 0) >= RESEARCH_TOTAL_TRACKED_RAM_WARN_MB:
        warnings.append(f"Tổng RAM nhóm app cao: {snap.get('total_tracked_mb')} MB")
    if snap.get("system_percent", 0) and snap.get("system_percent", 0) >= 90:
        warnings.append(f"RAM hệ thống cao: {snap.get('system_percent')}%")
    snap["warning"] = "; ".join(warnings)
    return snap


def _replace_with_retry(src, dst, attempts=12, delay=0.05):
    """Atomic replace có retry cho khóa file tạm thời trên Windows.

    Node/UI có thể đang đọc file JSON/CSV đúng lúc Python commit bằng
    ``os.replace``. Trên Windows, cửa sổ race rất ngắn này có thể trả
    WinError 5 (Access is denied) hoặc WinError 32 (file in use).
    Retry chỉ áp dụng cho các lỗi khóa/quyền tạm thời; lỗi khác vẫn nổi lên.
    """
    src = Path(src)
    dst = Path(dst)
    last_err = None
    for i in range(max(1, int(attempts))):
        try:
            os.replace(src, dst)
            return
        except PermissionError as e:
            last_err = e
        except OSError as e:
            if getattr(e, "winerror", None) not in (5, 32):
                raise
            last_err = e

        if i < attempts - 1:
            # Backoff ngắn, có trần: đủ vượt qua lúc Node/antivirus đang giữ handle
            # nhưng không làm worker đứng lâu nếu file thực sự không thể thay thế.
            time.sleep(min(delay * (i + 1), 0.25))

    raise last_err


def _write_json_atomic(path, payload):
    try:
        path = Path(path)
        mkdirp(path.parent) if 'mkdirp' in globals() else path.parent.mkdir(parents=True, exist_ok=True)
        tmp = path.with_suffix(path.suffix + ".tmp")
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(payload, f, ensure_ascii=False, indent=2)
        _replace_with_retry(tmp, path)
        return True
    except Exception:
        return False


def write_resource_snapshot(run_dir, reason="interval", force_log=False):
    global _RESOURCE_LAST_SNAPSHOT, _RESOURCE_LAST_LOG_TS
    try:
        snap = collect_resource_snapshot()
        with _WATCHDOG_LOCK:
            snap["stage"] = _WATCHDOG_STAGE
            snap["seconds_since_last_progress"] = round(time.time() - _WATCHDOG_LAST_TS, 1)
        snap["reason"] = reason
        run_dir = Path(run_dir)
        _write_json_atomic(run_dir / "resource_status.json", snap)
        try:
            with open(run_dir / "resource_log.jsonl", "a", encoding="utf-8", buffering=1) as f:
                f.write(json.dumps(snap, ensure_ascii=False) + "\n")
        except Exception:
            pass
        with _RESOURCE_LOCK:
            _RESOURCE_LAST_SNAPSHOT = snap
        now = time.time()
        if force_log or snap.get("warning") or (now - _RESOURCE_LAST_LOG_TS >= RESEARCH_RESOURCE_LOG_EVERY_SEC):
            _RESOURCE_LAST_LOG_TS = now
            line = (
                f"[RESOURCE] RAM python={snap.get('python_mb', 0)}MB "
                f"chrome={snap.get('chrome_mb', 0)}MB chromedriver={snap.get('chromedriver_mb', 0)}MB "
                f"node={snap.get('node_mb', 0)}MB tracked={snap.get('total_tracked_mb', 0)}MB"
            )
            if snap.get("system_percent"):
                line += f" system={snap.get('system_percent')}%"
            if snap.get("warning"):
                line += f" ⚠ {snap.get('warning')}"
            print(line, flush=True)
        return snap
    except Exception as e:
        return {"time": datetime.now().isoformat(timespec="seconds"), "error": str(e)[:300]}


def get_last_resource_snapshot():
    try:
        with _RESOURCE_LOCK:
            if _RESOURCE_LAST_SNAPSHOT:
                return dict(_RESOURCE_LAST_SNAPSHOT)
    except Exception:
        pass
    return collect_resource_snapshot()


def start_resource_monitor(run_dir):
    """Ghi resource_status.json định kỳ để kiểm tra có tràn RAM không."""
    if not RESEARCH_RESOURCE_MONITOR or RESEARCH_RESOURCE_INTERVAL_SEC <= 0:
        return None
    _RESOURCE_STOP.clear()

    def _loop():
        try:
            write_resource_snapshot(run_dir, reason="start", force_log=True)
        except Exception:
            pass
        while not _RESOURCE_STOP.wait(max(5, RESEARCH_RESOURCE_INTERVAL_SEC)):
            try:
                write_resource_snapshot(run_dir, reason="interval")
            except Exception:
                pass

    t = threading.Thread(target=_loop, name="research-resource-monitor", daemon=True)
    t.start()
    return t


def stop_resource_monitor(run_dir=None):
    try:
        _RESOURCE_STOP.set()
        if run_dir:
            write_resource_snapshot(run_dir, reason="stop", force_log=True)
    except Exception:
        pass

def _watchdog_snapshot(run_dir, stage, stale_sec):
    """Ghi file mô tả nơi bị treo để frontend/người dùng biết nguyên nhân."""
    try:
        run_dir = Path(run_dir)
        payload = {
            "level": "FATAL",
            "time": now_iso() if 'now_iso' in globals() else datetime.now().isoformat(timespec="seconds"),
            "kind": "watchdog_stall",
            "stage": stage,
            "stale_seconds": int(stale_sec),
            "message": f"Không có tiến trình/log mới trong {int(stale_sec)} giây. Có thể Chrome/EMR/Selenium bị treo.",
            "hint": "Chạy lại tác vụ để resume từ progress.json. Có thể tăng RESEARCH_STALL_TIMEOUT_SEC nếu EMR rất chậm.",
            "resource": get_last_resource_snapshot(),
        }
        for name in ("watchdog_stall.json", "fatal_alert.json"):
            with open(run_dir / name, "w", encoding="utf-8") as f:
                json.dump(payload, f, ensure_ascii=False, indent=2)
    except Exception:
        pass


def start_watchdog(run_dir, driver_ref):
    """Daemon phát hiện script đứng im. Khi treo, thoát process để không kẹt vô hạn."""
    if not RESEARCH_WATCHDOG or RESEARCH_STALL_TIMEOUT_SEC <= 0:
        return None
    _WATCHDOG_STOP.clear()

    def _loop():
        while not _WATCHDOG_STOP.wait(5):
            try:
                with _WATCHDOG_LOCK:
                    stale = time.time() - _WATCHDOG_LAST_TS
                    stage = _WATCHDOG_STAGE
                if stale < RESEARCH_STALL_TIMEOUT_SEC:
                    continue
                msg = (
                    f"[WATCHDOG] Không có heartbeat tiến độ {int(stale)} giây tại: {stage}. "
                    "Thoát để tránh treo im lặng; lần chạy sau sẽ resume."
                )
                print(msg, flush=True)
                _watchdog_snapshot(run_dir, stage, stale)
                # Cố gắng hạ chromedriver để giải phóng Chrome, nhưng không chờ lâu.
                try:
                    drv = driver_ref() if callable(driver_ref) else None
                    svc = getattr(drv, "service", None) if drv else None
                    if svc is not None:
                        try:
                            svc.stop()
                        except Exception:
                            pass
                except Exception:
                    pass
                os._exit(76)
            except Exception:
                # Không để watchdog tự chết vì lỗi phụ.
                pass

    t = threading.Thread(target=_loop, name="research-watchdog", daemon=True)
    t.start()
    return t


def stop_watchdog():
    try:
        _WATCHDOG_STOP.set()
    except Exception:
        pass


def _fast_sleep(seconds):
    time.sleep(min(seconds, 0.25) if FAST_UI else seconds)


def wait_document_idle(driver, timeout=1.5):
    """Đợi ngắn cho trang/ajax lắng xuống, không chờ cứng nhiều giây."""
    end = time.time() + max(0.1, timeout)
    while time.time() < end:
        try:
            ready, active = driver.execute_script("""
                return [
                  document.readyState || '',
                  (window.jQuery && typeof window.jQuery.active === 'number') ? window.jQuery.active : 0
                ];
            """)
            if ready == "complete" and int(active or 0) == 0:
                return True
        except Exception:
            return False
        time.sleep(0.08)
    return False


# ── Action Logger ─────────────────────────────────────────────────────────────
class ActionLogger:
    """Ghi log từng bước thao tác vào action_log.txt trong run_dir.
    Mỗi dòng có timestamp + cấp độ + nội dung để dễ grep khi debug.
    """
    def __init__(self, run_dir=None):
        self._fh = None
        if run_dir:
            self.open(run_dir)

    def open(self, run_dir):
        try:
            log_path = Path(run_dir) / "action_log.txt"
            self._fh = open(log_path, "a", encoding="utf-8", buffering=1)
            self._write("INFO", f"=== Phiên mới bắt đầu: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')} ===")
        except Exception as e:
            print(f"[LOG] Không mở được action_log.txt: {e}")

    def _write(self, level, msg):
        touch_watchdog(f"{level.strip()} {str(msg)[:220]}")
        ts = datetime.now().strftime("%H:%M:%S")
        line = f"[{ts}] {level:5s} {msg}"
        print(line)
        if self._fh:
            try:
                self._fh.write(line + "\n")
            except Exception:
                pass

    def step(self, msg):   self._write("STEP ", msg)
    def click(self, msg):  self._write("CLICK", msg)
    def find(self, msg):   self._write("FIND ", msg)
    def ok(self, msg):     self._write("OK   ", msg)
    def warn(self, msg):   self._write("WARN ", msg)
    def error(self, msg):  self._write("ERROR", msg)
    def info(self, msg):   self._write("INFO ", msg)

    def close(self):
        if self._fh:
            try:
                self._write("INFO", "=== Phiên kết thúc ===")
                self._fh.close()
            except Exception:
                pass
            self._fh = None




# ── Research case trace: 10 ca gần nhất ──────────────────────────────────────
_CASE_TRACE_FILE = "research_case_trace.jsonl"
_CASE_TRACE_RECENT_FILE = "research_case_trace_recent.json"
_CASE_TRACE_RECENT_LIMIT = 10
_CASE_TRACE_CURRENT = None
# Mặc định KHÔNG in [TRACE] ra console để log dễ đọc — vẫn lưu đủ vào
# research_case_trace*.json để xem lại chi tiết qua UI khi cần debug sâu.
# Bật lại bằng biến môi trường RESEARCH_TRACE_CONSOLE=1 khi cần soi trực tiếp.
_TRACE_TO_CONSOLE = os.environ.get("RESEARCH_TRACE_CONSOLE", "0") == "1"

def _trace_clip(value, limit=900):
    return re.sub(r"\s+", " ", str(value or "")).strip()[:limit]

def _trace_event_dict(tag, step, screen="", sees="", takes="", writes="", target=""):
    return {
        "ts": datetime.now().isoformat(timespec="seconds"),
        "tag": _trace_clip(tag, 80),
        "step": _trace_clip(step, 260),
        "screen": _trace_clip(screen, 260),
        "sees": _trace_clip(sees, 900),
        "takes": _trace_clip(takes, 900),
        "writes": _trace_clip(writes, 900),
        "target": _trace_clip(target, 420),
    }

def case_trace_start(run_dir, ctx, index=0, total=0, mode="xn_cdha"):
    global _CASE_TRACE_CURRENT
    case_id = _trace_clip(ctx.get("Research key") or ctx.get("Mã NC") or f"{ctx.get('Mã BN','')}|{ctx.get('Ngày vào viện','')}", 220)
    _CASE_TRACE_CURRENT = {
        "case_id": case_id,
        "ts": datetime.now().isoformat(timespec="seconds"),
        "mode": mode,
        "status": "running",
        "index": index,
        "total": total,
        "ma_bn": _trace_clip(ctx.get("Mã BN"), 80),
        "ho_ten": _trace_clip(ctx.get("Họ tên"), 160),
        "research_code": _trace_clip(ctx.get("Mã NC"), 120),
        "date_from": _trace_clip(ctx.get("Ngày vào viện") or ctx.get("T/G vào"), 80),
        "date_to": _trace_clip(ctx.get("Ngày ra viện") or ctx.get("T/G ra"), 80),
        "files": ["xn", "cdha"],
        "events": [],
    }
    case_trace_event("CASE.START", "Bắt đầu lấy sâu XN/CĐHA cho một lượt điều trị", "D/s Điều trị nội trú",
                     f"Mã BN={ctx.get('Mã BN','')}; Mã NC={ctx.get('Mã NC','')}; lượt={index}/{total}",
                     "thông tin lượt điều trị từ popup", "khởi tạo trace cho case", _CASE_TRACE_RECENT_FILE)

def case_trace_event(tag, step, screen="", sees="", takes="", writes="", target=""):
    if not _CASE_TRACE_CURRENT:
        return
    ev = _trace_event_dict(tag, step, screen, sees, takes, writes, target)
    _CASE_TRACE_CURRENT.setdefault("events", []).append(ev)
    if not _TRACE_TO_CONSOLE:
        return
    try:
        log_info(f"[TRACE][{ev['tag']}] {ev['step']} | vào={ev['screen']} | thấy={ev['sees']} | lấy={ev['takes']} | ghi={ev['writes']}")
    except Exception:
        pass

def case_trace_finish(run_dir, status="done", counts=None, error=""):
    global _CASE_TRACE_CURRENT
    if not _CASE_TRACE_CURRENT:
        return
    case = dict(_CASE_TRACE_CURRENT)
    case["status"] = status
    case["finished_at"] = datetime.now().isoformat(timespec="seconds")
    case["counts"] = counts or {}
    if error:
        case["error"] = _trace_clip(error, 1000)
        case.setdefault("events", []).append(_trace_event_dict("ERROR", "Case kết thúc với lỗi", "worker XN/CĐHA", error, "exception", "progress.status=incomplete", "progress.json"))
    else:
        case.setdefault("events", []).append(_trace_event_dict("CASE.END", "Case kết thúc và đã commit dữ liệu", "worker XN/CĐHA", f"counts={counts or {}}", "rows_by_table", "lich_su_xn.csv + lich_su_cdha.csv", "run dir"))
    try:
        run_dir = Path(run_dir)
        mkdirp(run_dir)
        with open(run_dir / _CASE_TRACE_FILE, "a", encoding="utf-8", buffering=1) as f:
            f.write(json.dumps(case, ensure_ascii=False) + "\n")
        recent_path = run_dir / _CASE_TRACE_RECENT_FILE
        recent = []
        if recent_path.exists():
            try:
                data = json.loads(recent_path.read_text(encoding="utf-8"))
                if isinstance(data, list):
                    recent = data
            except Exception:
                recent = []
        recent = [x for x in recent if x.get("case_id") != case.get("case_id")]
        recent.append(case)
        _write_json_atomic(recent_path, recent[-_CASE_TRACE_RECENT_LIMIT:])
    except Exception as e:
        try:
            log_warn(f"Ghi case trace lỗi: {e}")
        except Exception:
            pass
    _CASE_TRACE_CURRENT = None


# Global logger — được khởi tạo lại trong main() sau khi có run_dir
_LOG = ActionLogger()


def log_step(msg):   _LOG.step(msg)
def log_click(msg):  _LOG.click(msg)
def log_find(msg):   _LOG.find(msg)
def log_ok(msg):     _LOG.ok(msg)
def log_warn(msg):   _LOG.warn(msg)
def log_error_raw(msg): _LOG.error(msg)
def log_info(msg):   _LOG.info(msg)


def _handle_stop_signal(signum, frame):
    raise KeyboardInterrupt


try:
    signal.signal(signal.SIGTERM, _handle_stop_signal)
except Exception:
    pass

# ── Mặc định ──────────────────────────────────────────────────────────────────
DEFAULT_INPUT_CSV = "ds_hoan_tat.csv"
DEFAULT_PROJECT_ID = "nghien_cuu_1"
PROGRESS_FILE = "progress.json"
ERRORS_FILE = "errors.csv"

COL_PATIENTS = [
    # Mẫu nghiên cứu sau khi đã tìm từng người bệnh và mở màn hình Điều dưỡng.
    "Mã NC", "Mã BN", "Mã vào viện", "Mã điều trị", "Mã nội trú",
    "URL bác sĩ", "URL điều dưỡng",
    "Họ tên", "Giới", "Ngày sinh", "Tuổi",
    "Địa chỉ", "Điện thoại", "Số CMND", "Đối tượng", "Số thẻ", "Loại", "Giá trị từ", "Giá trị đến",
    "Ngày vào viện", "Ngày ra viện", "Thời gian điều trị", "Chẩn đoán vào viện",
]

COL_PATIENT_EXTRA = [
    # Bổ sung từ Quản lý Bệnh nhân → D/s Bệnh nhân.
    "Mã BN", "Họ tên", "Năm sinh", "Địa chỉ", "Số thẻ BHYT", "Điện thoại", "Số CMND",
    "Lấy lúc", "Trạng thái", "Ghi chú",
]

COL_INITIAL_LIST = [
    # Dữ liệu ban đầu: giữ luôn khóa lượt điều trị và URL EMR để các bước sau
    # không phải tìm lại chỉ bằng Mã BN + thời gian.
    "T/G vào", "Mã BN", "Mã nội trú", "URL bác sĩ", "URL điều dưỡng",
    "Họ tên", "Tuổi", "GT", "Trạng thái", "Khoa chuyển đến", "Xử trí",
]

COL_XN = [
    "Mã NC", "Mã BN", "Mã vào viện", "Mã điều trị",
    "TG chỉ định", "Ngày chỉ định", "Giờ chỉ định", "Người chỉ định", "Khoa/Phòng",
    "Loại XN", "Mã phiếu", "Trạng thái", "Chỉ số", "Kết quả",
    "Khoảng tham chiếu", "Đơn vị", "Bất thường",
]

COL_CDHA = [
    "Mã NC", "Mã BN", "Mã vào viện", "Mã điều trị",
    "TG chỉ định", "Ngày chỉ định", "Giờ chỉ định", "Người chỉ định", "Khoa/Phòng",
    "Tên dịch vụ", "Nhóm dịch vụ", "Mô tả/Kết quả", "Kết luận", "Trạng thái",
]

COL_ERRORS = [
    "Thời gian", "Mức độ", "Mã NC", "Mã BN", "Họ tên", "Tab", "Bước", "Lỗi",
]

# Mức độ lỗi:
#   WARN  — bỏ qua được, không ảnh hưởng kết quả chính (VD: không tìm thấy BN trong filter hiện tại)
#   ERROR — lỗi thật, cần xem xét (VD: không mở được popup, selenium exception)
#   FATAL — lỗi nghiêm trọng, đã dừng script (VD: invalid session, crash toàn bộ)
ERR_WARN  = "WARN"
ERR_ERROR = "ERROR"
ERR_FATAL = "FATAL"

# ── Tiện ích ──────────────────────────────────────────────────────────────────
def now_iso():
    return datetime.now().isoformat(timespec="seconds")


def safe_filename(s):
    s = (s or "").strip().lower()
    s = re.sub(r"[^a-z0-9A-Z_\-]+", "_", s)
    s = re.sub(r"_+", "_", s).strip("_")
    return s or DEFAULT_PROJECT_ID


def normalize_text(s):
    return (s or "").replace("\xa0", " ").strip()


def strip_accents(s):
    return "".join(
        ch for ch in unicodedata.normalize("NFD", str(s or ""))
        if unicodedata.category(ch) != "Mn"
    ).replace("đ", "d").replace("Đ", "D")


def first_value(row, names, default=""):
    """Lấy giá trị đầu tiên theo nhiều biến thể tên cột."""
    if not row:
        return default
    direct = {str(k).strip().lower(): v for k, v in row.items()}
    for name in names:
        key = name.strip().lower()
        if key in direct and str(direct[key]).strip() != "":
            return normalize_text(str(direct[key]))
    # fallback: bỏ dấu cách/ký tự đặc biệt nhẹ
    compact = {re.sub(r"\W+", "", str(k).lower()): v for k, v in row.items()}
    for name in names:
        key = re.sub(r"\W+", "", name.lower())
        if key in compact and str(compact[key]).strip() != "":
            return normalize_text(str(compact[key]))
    return default


def parse_vn_datetime(text):
    """Trả về datetime nếu tìm thấy dd/mm/yyyy hoặc hh:mm dd/mm/yyyy."""
    text = normalize_text(text)
    if not text:
        return None
    patterns = [
        r"(?P<h>\d{1,2}):(?P<m>\d{2})\s+(?P<d>\d{1,2})[/-](?P<mo>\d{1,2})[/-](?P<y>\d{4})",
        r"(?P<d>\d{1,2})[/-](?P<mo>\d{1,2})[/-](?P<y>\d{4})\s+(?P<h>\d{1,2}):(?P<m>\d{2})",
        r"(?P<d>\d{1,2})[/-](?P<mo>\d{1,2})[/-](?P<y>\d{4})",
    ]
    for pat in patterns:
        m = re.search(pat, text)
        if not m:
            continue
        gd = m.groupdict()
        h = int(gd.get("h") or 0)
        minute = int(gd.get("m") or 0)
        try:
            return datetime(int(gd["y"]), int(gd["mo"]), int(gd["d"]), h, minute)
        except Exception:
            return None
    return None


def split_vn_datetime(text):
    dt = parse_vn_datetime(text)
    if not dt:
        return "", ""
    return dt.strftime("%d/%m/%Y"), dt.strftime("%H:%M") if (dt.hour or dt.minute) else ""


def parse_date_arg(text):
    if not text:
        return None
    text = text.strip()
    for fmt in ("%d/%m/%Y", "%d-%m-%Y", "%Y-%m-%d"):
        try:
            return datetime.strptime(text, fmt)
        except ValueError:
            pass
    raise ValueError(f"Ngày không hợp lệ: {text}. Dùng dd/mm/yyyy hoặc yyyy-mm-dd")


def in_date_range(text, from_dt=None, to_dt=None):
    if not from_dt and not to_dt:
        return True
    dt = parse_vn_datetime(text)
    if not dt:
        return True  # Không parse được thì vẫn giữ lại, tránh mất dữ liệu âm thầm.
    day = datetime(dt.year, dt.month, dt.day)
    if from_dt and day < datetime(from_dt.year, from_dt.month, from_dt.day):
        return False
    if to_dt and day > datetime(to_dt.year, to_dt.month, to_dt.day):
        return False
    return True



def day_start(dt):
    if not dt:
        return None
    return datetime(dt.year, dt.month, dt.day)


def date_key(dt):
    if not dt:
        return ""
    return day_start(dt).strftime("%Y-%m-%d")


def iter_days(from_dt, to_dt):
    """Sinh từng ngày trong khoảng lọc.

    Dữ liệu gốc không resume theo trang vì danh sách Hoàn tất thay đổi mỗi ngày
    và người mới xuất viện sẽ đẩy các lượt cũ sang trang sau. Vì vậy mỗi lần quét
    sẽ khóa từng ngày ra viện/hoàn tất, bắt đầu từ trang 1 của ngày đó, chống trùng
    bằng khóa Mã BN + Ngày vào viện + Ngày ra viện.
    """
    if from_dt and not to_dt:
        to_dt = from_dt
    if to_dt and not from_dt:
        from_dt = to_dt
    if not from_dt and not to_dt:
        today = datetime.now()
        from_dt = today
        to_dt = today
    start = day_start(from_dt)
    end = day_start(to_dt)
    if start > end:
        start, end = end, start
    cur = start
    while cur <= end:
        yield cur
        cur += timedelta(days=1)


def should_rescan_day(day, to_dt, recent_days=7):
    """Quét chồng các ngày gần cuối khoảng để bắt kịp hồ sơ hoàn tất muộn."""
    if recent_days is None:
        recent_days = 0
    try:
        recent_days = int(recent_days)
    except Exception:
        recent_days = 0
    if recent_days <= 0:
        return False
    end = day_start(to_dt or datetime.now())
    return day_start(day) >= end - timedelta(days=recent_days - 1)


def format_emr_date(dt):
    """Định dạng ngày thường dd/mm/yyyy."""
    if not dt:
        return ""
    return dt.strftime("%d/%m/%Y")


def format_emr_datetime(dt, end_of_day=False):
    """Định dạng đúng cho 2 ô datetimepicker của EMR: HH:mm dd/mm/yyyy.

    Danh sách Hoàn tất dùng input #dtTuNgay/#dtDenNgay có cả giờ phút. Nếu chỉ
    gán dd/mm/yyyy, datetimepicker có thể giữ giờ/ngày nội bộ thành 01/01/0000
    và EMR báo lỗi "String was not recognized as a valid DateTime".
    """
    if not dt:
        return ""
    prefix = "23:59" if end_of_day else "00:00"
    return f"{prefix} {dt.strftime('%d/%m/%Y')}"


def dismiss_sweet_alert(driver, timeout=3):
    """Đóng SweetAlert/Bootstrap alert nếu đang hiện.

    Lưu ý: popup "Lịch sử KCB" cũng là Bootstrap modal. Các bản trước nhận nhầm
    popup lịch sử là cảnh báo rồi bấm nút đóng, làm tab XN/CĐHA không load được.
    Hàm này chỉ đóng modal thật sự là cảnh báo/confirm của EMR, không đụng vào
    modal Lịch sử KCB đang dùng để đọc XN/CĐHA.
    """
    end = time.time() + max(0, float(timeout or 0))
    last_msg = ""

    js = r"""
        function visible(el){
          if(!el) return false;
          var st = window.getComputedStyle(el);
          return st.display !== 'none' && st.visibility !== 'hidden' &&
                 (el.offsetParent !== null || st.position === 'fixed');
        }
        function norm(s){
          try { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
          catch(e){ return String(s || '').toLowerCase(); }
        }
        function isHistoryModal(text){
          var t = norm(text);
          return t.indexOf('lich su kcb') >= 0 ||
                 t.indexOf('lich su xet nghiem') >= 0 ||
                 t.indexOf('lich su cdha') >= 0 ||
                 (t.indexOf('nguoi benh:') >= 0 && t.indexOf('lich su') >= 0) ||
                 (t.indexOf('lich su y lenh') >= 0 && t.indexOf('lich su') >= 0);
        }
        function isRealWarning(text){
          var t = norm(text);
          return t.indexOf('canh bao') >= 0 ||
                 t.indexOf('string was not recognized') >= 0 ||
                 t.indexOf('chua chon khoa phong') >= 0 ||
                 t.indexOf('loi') >= 0 ||
                 t.indexOf('khong hop le') >= 0 ||
                 t.indexOf('warning') >= 0;
        }
        var candidates = Array.prototype.slice.call(document.querySelectorAll(
          '.sweet-alert.visible,.sweet-alert,.swal2-popup,.swal2-container,.bootbox.modal,.modal.show,.modal.in'
        )).filter(visible);
        if (!candidates.length) return {found:false, ignored:false, clicked:0, text:''};

        var ignoredHistory = false;
        for (var r=0; r<candidates.length; r++) {
          var root = candidates[r];
          var text = '';
          try { text = (root.innerText || root.textContent || '').trim(); } catch(e) {}
          if (isHistoryModal(text)) { ignoredHistory = true; continue; }
          if ((root.className || '').toString().indexOf('modal') >= 0 && !isRealWarning(text)) {
            continue;
          }
          var btns = Array.prototype.slice.call(root.querySelectorAll(
            'button.confirm,.swal2-confirm,.btn-primary,button[data-dismiss="modal"],.modal-footer button,button'
          )).filter(visible);
          var clicked = 0;
          for (var i=0; i<btns.length; i++) {
            var bt = norm(btns[i].innerText || btns[i].value || btns[i].title || '');
            if (bt && !(bt.indexOf('ok') >= 0 || bt.indexOf('dong') >= 0 || bt.indexOf('chap nhan') >= 0 || bt.indexOf('xac nhan') >= 0 || bt.indexOf('co') >= 0)) {
              continue;
            }
            try { btns[i].click(); clicked++; break; } catch(e) {}
          }
          return {found:true, ignored:false, clicked:clicked, text:text};
        }
        return {found:false, ignored:ignoredHistory, clicked:0, text:''};
    """

    first = True
    while True:
        try:
            res = driver.execute_script(js) or {}
            # Nếu đang mở popup Lịch sử KCB thì trả ngay, tránh chờ timeout và
            # tuyệt đối không bấm đóng popup này.
            if res.get("ignored"):
                return False
            if res.get("found"):
                last_msg = normalize_text(res.get("text") or "")
                if last_msg:
                    log_warn(f"EMR cảnh báo: {last_msg[:180]}")
                    print(f"    ⚠ EMR cảnh báo: {last_msg[:180]}")
                _fast_sleep(0.18)
                return last_msg or True
        except Exception:
            pass
        # Tối ưu tốc độ: hầu hết lần gọi không có cảnh báo. Nếu kiểm tra nhanh lần
        # đầu không thấy gì và timeout ngắn, thoát ngay.
        if first and (timeout or 0) <= 0.5:
            return False
        first = False
        if time.time() >= end or timeout <= 0:
            return False
        time.sleep(0.10)

def set_select_by_text_or_value(driver, selectors, text_tokens=None, values=None):
    text_tokens = [normalize_for_match(x) for x in (text_tokens or [])]
    values = {str(x) for x in (values or [])}
    js = r"""
        var selectors = arguments[0] || [];
        var textTokens = arguments[1] || [];
        var values = arguments[2] || [];
        function norm(s){
          try { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
          catch(e){ return (s || '').toLowerCase(); }
        }
        var changed = [];
        for (var si=0; si<selectors.length; si++){
          var els = Array.prototype.slice.call(document.querySelectorAll(selectors[si]));
          for (var ei=0; ei<els.length; ei++){
            var el = els[ei];
            if (!el || el.tagName !== 'SELECT') continue;
            var opts = Array.prototype.slice.call(el.options || []);
            var picked = null;
            for (var oi=0; oi<opts.length; oi++){
              var opt = opts[oi];
              var ov = String(opt.value || '');
              var ot = norm(opt.textContent || opt.innerText || '');
              if (values.indexOf(ov) >= 0 || textTokens.some(function(t){ return ot.indexOf(t) >= 0; })){
                picked = opt;
                break;
              }
            }
            if (picked){
              el.value = picked.value;
              el.dispatchEvent(new Event('change', {bubbles:true}));
              try { if (window.jQuery) window.jQuery(el).trigger('change'); } catch(e) {}
              changed.push(el.id || el.name || selectors[si]);
            }
          }
        }
        return changed;
    """
    try:
        return driver.execute_script(js, selectors, text_tokens, list(values)) or []
    except Exception:
        return []


def select2_select_by_text(driver, select_id, text_tokens=None, fallback_values=None):
    """Chọn option cho select2 bằng text hiển thị.

    EMR thường dùng select ẩn + Select2. Nếu chỉ đổi label hiển thị thì value thật
    không đổi; nếu chỉ đổi value DOM mà không trigger Select2/onchange thì vùng lọc
    ngày không mở. Hàm này đổi select gốc, trigger change/input/Select2 và trả về
    trạng thái sau khi đổi.
    """
    text_tokens = [normalize_for_match(x) for x in (text_tokens or [])]
    fallback_values = [str(x) for x in (fallback_values or [])]
    js = r"""
        var selectId = arguments[0];
        var textTokens = arguments[1] || [];
        var fallbackValues = arguments[2] || [];
        function norm(s){
          try { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().trim(); }
          catch(e){ return (s || '').toLowerCase().trim(); }
        }
        function visibleText(el){
          if (!el) return '';
          return (el.textContent || el.innerText || el.getAttribute('title') || '').trim();
        }
        var el = document.getElementById(selectId);
        if (!el) return {changed:false, reason:'missing-select'};
        var opts = Array.prototype.slice.call(el.options || []);
        var picked = null;
        for (var i=0; i<opts.length; i++){
          var opt = opts[i];
          var text = norm(opt.textContent || opt.innerText || '');
          var value = String(opt.value || '');
          if (textTokens.some(function(t){ return text.indexOf(t) >= 0; })) { picked = opt; break; }
          if (!picked && fallbackValues.indexOf(value) >= 0) picked = opt;
        }
        if (!picked) {
          return {
            changed:false,
            reason:'missing-option',
            currentValue: el.value || '',
            currentText: el.options[el.selectedIndex] ? visibleText(el.options[el.selectedIndex]) : '',
            options: opts.map(function(o){ return {value:String(o.value || ''), text:visibleText(o)}; })
          };
        }
        el.value = picked.value;
        picked.selected = true;
        try { el.dispatchEvent(new Event('input', {bubbles:true})); } catch(e) {}
        try { el.dispatchEvent(new Event('change', {bubbles:true})); } catch(e) {}
        try { if (typeof el.onchange === 'function') el.onchange(); } catch(e) {}
        try {
          if (window.jQuery) {
            var $el = window.jQuery(el);
            $el.val(picked.value);
            $el.trigger('input');
            $el.trigger('change');
            $el.trigger('change.select2');
          }
        } catch(e) {}
        var rendered = document.getElementById('select2-' + selectId + '-container');
        return {
          changed:true,
          value: el.value || '',
          text: el.options[el.selectedIndex] ? visibleText(el.options[el.selectedIndex]) : '',
          rendered: rendered ? visibleText(rendered) : '',
          renderedTitle: rendered ? (rendered.getAttribute('title') || '') : ''
        };
    """
    try:
        return driver.execute_script(js, select_id, text_tokens, fallback_values) or {"changed": False}
    except Exception as e:
        return {"changed": False, "reason": str(e)}


def select2_click_option_by_text(driver, select_id, text_tokens=None, timeout=5):
    """Fallback bằng click UI Select2 khi đổi select gốc chưa làm EMR mở vùng lọc."""
    text_tokens = [normalize_for_match(x) for x in (text_tokens or [])]
    try:
        rendered = driver.find_element(By.ID, f"select2-{select_id}-container")
        selection = rendered.find_element(By.XPATH, "./ancestor::span[contains(@class,'select2-selection')][1]")
        driver.execute_script("arguments[0].click();", selection)
        WebDriverWait(driver, timeout).until(
            EC.presence_of_all_elements_located((By.CSS_SELECTOR, ".select2-results__option"))
        )
        options = driver.find_elements(By.CSS_SELECTOR, ".select2-results__option")
        for opt in options:
            txt = normalize_for_match(opt.text or opt.get_attribute("textContent") or "")
            if any(tok in txt for tok in text_tokens):
                driver.execute_script("arguments[0].click();", opt)
                time.sleep(0.3)
                return True
    except Exception:
        return False
    return False


def current_inpatient_status_text(driver):
    """Đọc trạng thái nội trú thật đang hiển thị trên Select2.

    Không dùng giá trị vừa set làm nguồn sự thật, vì EMR/Select2 có lúc không đổi
    sang Hoàn tất dù JS đã set value. Ảnh thực tế của người dùng cho thấy log ghi
    Hoàn tất nhưng UI vẫn đang là Đang thực hiện; hàm này dùng để chặn lỗi đó.
    """
    try:
        data = driver.execute_script(r"""
            function normText(el){
              return (el ? (el.textContent || el.innerText || el.getAttribute('title') || '') : '')
                .replace(/ /g, ' ').replace(/\s+/g, ' ').trim();
            }
            var select = document.getElementById('drpSelectTrangThai');
            var rendered = document.getElementById('select2-drpSelectTrangThai-container');
            var text = normText(rendered);
            var title = rendered ? (rendered.getAttribute('title') || '') : '';
            var value = select ? String(select.value || '') : '';
            var optText = '';
            if (select && select.options && select.selectedIndex >= 0) {
              optText = normText(select.options[select.selectedIndex]);
            }
            return {text:text, title:title, value:value, optionText:optText};
        """) or {}
        return normalize_text(data.get("text") or data.get("title") or data.get("optionText") or data.get("value") or "")
    except Exception:
        return ""


def is_completed_status_text(value):
    s = normalize_for_match(value)
    return ("hoan tat" in s) or ("da hoan tat" in s)


def is_completed_status_active(driver):
    return is_completed_status_text(current_inpatient_status_text(driver))


def _click_completed_status_ui(driver, timeout=5):
    """Fallback chọn Hoàn tất bằng UI Select2, dùng khi đổi select gốc không ăn."""
    try:
        rendered = driver.find_element(By.ID, "select2-drpSelectTrangThai-container")
        selection = rendered.find_element(By.XPATH, "./ancestor::span[contains(@class,'select2-selection')][1]")
        driver.execute_script("arguments[0].scrollIntoView({block:'center'}); arguments[0].click();", selection)
        WebDriverWait(driver, timeout).until(
            EC.presence_of_all_elements_located((By.CSS_SELECTOR, ".select2-results__option"))
        )
        options = driver.find_elements(By.CSS_SELECTOR, ".select2-results__option")
        best = None
        for opt in options:
            txt = normalize_for_match(opt.text or opt.get_attribute("textContent") or "")
            if "hoan tat" in txt:
                best = opt
                break
        if best is None:
            return False
        driver.execute_script("arguments[0].scrollIntoView({block:'center'}); arguments[0].click();", best)
        time.sleep(0.5)
        return True
    except Exception:
        return False


def choose_completed_status(driver):
    """Chọn và xác nhận trạng thái Hoàn tất trên drpSelectTrangThai."""
    result = select2_select_by_text(
        driver,
        "drpSelectTrangThai",
        text_tokens=["hoan tat", "hoan tat kham", "da hoan tat"],
        fallback_values=[],
    )
    time.sleep(0.5)

    # Không tin tuyệt đối result trả về từ JS. Phải đọc lại label Select2 đang hiển thị.
    rendered = current_inpatient_status_text(driver)
    if not is_completed_status_text(rendered):
        log_warn(f"Trạng thái sau khi set chưa phải Hoàn tất: '{rendered or 'trống'}' — thử chọn bằng UI Select2")
        _click_completed_status_ui(driver, timeout=5 if FAST_UI else 8)
        time.sleep(0.5)
        rendered = current_inpatient_status_text(driver)

    # Fallback cuối: quét option thật có chữ Hoàn tất rồi set đúng value tìm được.
    if not is_completed_status_text(rendered):
        try:
            driver.execute_script(r"""
                var s=document.getElementById('drpSelectTrangThai');
                function fold(x){
                  try { return (x || '').normalize('NFD').replace(/[̀-ͯ]/g,'').toLowerCase(); }
                  catch(e){ return (x || '').toLowerCase(); }
                }
                if(s){
                  var opts = Array.prototype.slice.call(s.options || []);
                  var picked = null;
                  for(var i=0;i<opts.length;i++){
                    if(fold(opts[i].textContent || opts[i].innerText || '').indexOf('hoan tat') >= 0){
                      picked = opts[i]; break;
                    }
                  }
                  if(picked){
                    s.value = picked.value; picked.selected = true;
                    try { s.dispatchEvent(new Event('input',{bubbles:true})); } catch(e) {}
                    try { s.dispatchEvent(new Event('change',{bubbles:true})); } catch(e) {}
                    try { if(typeof OnSelectTrangThai==='function') OnSelectTrangThai(s); } catch(e) {}
                    try { if (window.jQuery) window.jQuery(s).val(picked.value).trigger('change').trigger('change.select2'); } catch(e) {}
                  }
                }
            """)
            time.sleep(0.5)
            rendered = current_inpatient_status_text(driver)
        except Exception as e:
            log_warn(f"Fallback set Hoàn tất theo option lỗi: {e}")

    print(f"    Trạng thái nội trú: {rendered or 'không đọc được'}")
    if not is_completed_status_text(rendered):
        log_warn("Chưa xác nhận được trạng thái Hoàn tất — không nên tìm BN vì dễ mở nhầm danh sách Đang thực hiện")
        return False
    return True


def choose_time_filter_range_mode(driver, wait=None):
    """Chọn combobox cbbLoai từ '3 tháng' sang 'Khoảng'.

    Sau khi chọn Hoàn tất, EMR mặc định hiển thị cbbLoai = '3 tháng'. Phải đổi sang
    'Khoảng' thì div #data_5 và 2 ô #dtTuNgay/#dtDenNgay mới dùng đúng khoảng ngày
    người dùng chọn trên web app.
    """
    result = select2_select_by_text(
        driver,
        "cbbLoai",
        text_tokens=["khoang", "tu ngay", "den ngay", "tuy chon"],
        fallback_values=[],
    )
    if not result.get("changed"):
        clicked = select2_click_option_by_text(driver, "cbbLoai", ["khoang", "tu ngay", "den ngay", "tuy chon"])
        if clicked:
            result = select2_select_by_text(driver, "cbbLoai", text_tokens=["khoang"], fallback_values=[])
            if not result.get("changed"):
                result = {"changed": True, "text": "Khoảng"}

    # Chờ vùng ngày hiện ra. Không fail cứng vì một số phiên EMR luôn render sẵn #data_5.
    try:
        w = wait or WebDriverWait(driver, 6)
        w.until(lambda d: d.execute_script("""
            var box = document.getElementById('data_5');
            var f = document.getElementById('dtTuNgay');
            var t = document.getElementById('dtDenNgay');
            function shown(el){
              if(!el) return false;
              var st = window.getComputedStyle(el);
              return st.display !== 'none' && st.visibility !== 'hidden';
            }
            return !!(f && t && (!box || shown(box)));
        """))
    except Exception:
        pass

    rendered = ""
    try:
        rendered = driver.execute_script("""
            var c = document.getElementById('select2-cbbLoai-container');
            return c ? ((c.getAttribute('title') || c.textContent || '').trim()) : '';
        """) or ""
    except Exception:
        rendered = ""
    label = rendered or result.get("renderedTitle") or result.get("rendered") or result.get("text") or ""
    if result.get("changed") or normalize_for_match(label).find("khoang") >= 0:
        print(f"    Kiểu lọc thời gian: {label or 'Khoảng'}")
        return True
    print("    ⚠ Chưa chuyển được kiểu lọc thời gian từ '3 tháng' sang 'Khoảng' (cbbLoai)")
    return False


def set_emr_date_range(driver, from_dt=None, to_dt=None):
    """Đặt bộ lọc ngày trên danh sách nội trú theo khoảng người dùng chọn.

    EMR dùng 2 ô datetimepicker cố định:
      - #dtTuNgay: ví dụ 00:00 01/01/2026
      - #dtDenNgay: ví dụ 23:59 29/05/2026

    Phải gán cả value DOM và trạng thái nội bộ của datetimepicker/moment. Nếu chỉ
    gán ngày không có giờ, widget có thể hiển thị 01/01/0000 và EMR báo lỗi
    "String was not recognized as a valid DateTime" khi bấm tìm kiếm/quay lại.
    """
    from_text = format_emr_datetime(from_dt, end_of_day=False)
    to_text = format_emr_datetime(to_dt, end_of_day=True)
    if not from_text and not to_text:
        return []

    # EMR hay tự reset cbbLoai về "3 tháng" sau khi đổi trạng thái/quay lại danh sách.
    # Phải ép lại sang "Khoảng" mỗi lần đặt ngày; nếu chỉ set dtTuNgay/dtDenNgay
    # nhưng cbbLoai vẫn là "3 tháng" thì kết quả tìm kiếm vẫn bị giới hạn 3 tháng.
    choose_time_filter_range_mode(driver)
    try:
        driver.execute_script("""
            var box = document.getElementById('data_5');
            if (box) { box.style.display = 'block'; box.style.visibility = 'visible'; }
        """)
    except Exception:
        pass

    js = r"""
        var fromText = arguments[0] || '';
        var toText = arguments[1] || '';
        function norm(s){
          try { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
          catch(e){ return (s || '').toLowerCase(); }
        }
        function nativeSet(el, val){
          try {
            var proto = Object.getPrototypeOf(el);
            var desc = proto && Object.getOwnPropertyDescriptor(proto, 'value');
            if (desc && desc.set) desc.set.call(el, val); else el.value = val;
          } catch(e) { el.value = val; }
          el.setAttribute('value', val);
        }
        function setPicker(el, val){
          if (!el || !val) return false;
          el.focus && el.focus();
          nativeSet(el, val);
          el.setAttribute('data-date', val);
          try {
            if (window.jQuery) {
              var $el = window.jQuery(el);
              $el.val(val);
              var picker = $el.data('DateTimePicker') || $el.data('datetimepicker') || $el.data('datepicker');
              if (picker) {
                try {
                  if (window.moment && picker.date) picker.date(window.moment(val, 'HH:mm DD/MM/YYYY'));
                  else if (picker.setDate) picker.setDate(val);
                } catch(e1) {}
              }
              try { $el.trigger('input'); } catch(e2) {}
              try { $el.trigger('change'); } catch(e3) {}
              try { $el.trigger('dp.change'); } catch(e4) {}
              try { $el.trigger('blur'); } catch(e5) {}
            }
          } catch(e) {}
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
          el.blur && el.blur();
          return true;
        }
        function hay(el){
          if(!el) return '';
          var attrs = ['id','name','placeholder','aria-label','title','data-original-title','class'];
          var parts = [];
          attrs.forEach(function(a){ parts.push(el.getAttribute(a) || ''); });
          var p = el.parentElement;
          for(var i=0; p && i<3; i++, p=p.parentElement){ parts.push(p.innerText || ''); }
          return norm(parts.join(' '));
        }
        var changed = [];
        var f = document.getElementById('dtTuNgay');
        var t = document.getElementById('dtDenNgay');
        if (f && setPicker(f, fromText)) changed.push(f.id || f.name || 'from-date');
        if (t && setPicker(t, toText)) changed.push(t.id || t.name || 'to-date');

        // Fallback nếu EMR đổi id.
        if (!f || !t) {
          var inputs = Array.prototype.slice.call(document.querySelectorAll('input'))
            .filter(function(el){
              var type = (el.getAttribute('type') || '').toLowerCase();
              return ['', 'text', 'date', 'search'].indexOf(type) >= 0 && el.offsetParent !== null;
            });
          var fromTokens = ['dt tungay','dt tu ngay','tungay','tu ngay','fromdate','from date','ngaytu','ngay tu','startdate','start date','bat dau','tudate'];
          var toTokens = ['dt denngay','dt den ngay','denngay','den ngay','todate','to date','ngayden','ngay den','enddate','end date','ket thuc','dendate'];
          function findByTokens(tokens){
            for(var i=0; i<inputs.length; i++){
              var h = hay(inputs[i]).replace(/[_\-\s]+/g,' ');
              var compact = h.replace(/\s+/g,'');
              for(var j=0; j<tokens.length; j++){
                var tt = norm(tokens[j]);
                if (h.indexOf(tt) >= 0 || compact.indexOf(tt.replace(/\s+/g,'')) >= 0) return inputs[i];
              }
            }
            return null;
          }
          if (!f) {
            f = findByTokens(fromTokens);
            if (f && setPicker(f, fromText)) changed.push(f.id || f.name || 'from-date');
          }
          if (!t) {
            t = findByTokens(toTokens);
            if (t && setPicker(t, toText)) changed.push(t.id || t.name || 'to-date');
          }
        }
        return changed;
    """
    try:
        changed = driver.execute_script(js, from_text, to_text) or []
    except Exception:
        changed = []
    if changed:
        print(f"    Đã đặt bộ lọc ngày giờ EMR: {from_text or '...'} → {to_text or '...'} ({', '.join(changed)})")
    else:
        print(f"    ⚠ Chưa tìm thấy ô ngày giờ trên EMR để đặt: {from_text or '...'} → {to_text or '...'}")
    return changed


def read_emr_date_range_values(driver):
    try:
        return driver.execute_script("""
            var f = document.getElementById('dtTuNgay');
            var t = document.getElementById('dtDenNgay');
            return {
              from: f ? (f.value || f.getAttribute('value') || '') : '',
              to: t ? (t.value || t.getAttribute('value') || '') : ''
            };
        """) or {}
    except Exception:
        return {}




def _current_wpid(driver):
    try:
        query = urlsplit(driver.current_url or "").query
        params = dict(parse_qsl(query, keep_blank_values=True))
        return (params.get("wpid") or "").strip().lower()
    except Exception:
        return ""


def is_noi_tru_detail_page(driver):
    """Nhận diện các màn chi tiết hồ sơ BN.

    Các màn này cũng có ô tìm kiếm trên thanh đầu trang, nên không được dùng riêng
    #txtTimKiem để kết luận đã quay lại danh sách nội trú.
    """
    try:
        wpid = _current_wpid(driver)
        if wpid and wpid != "danhsachdieutrinoitrudraw":
            if any(token in wpid for token in [
                "dieuduongdraw", "bacsidraw", "chamsoc", "phauthuatdraw",
                "danhsachphauthuatdraw", "bangke", "vienphi",
            ]):
                return True
    except Exception:
        pass
    try:
        return bool(driver.execute_script("""
            return !!(
              document.getElementById('buttonBackNT') ||
              document.getElementById('lblHoTen') ||
              document.getElementById('lblNgayVaoVien') ||
              document.querySelector('[onclick*="buttonBackNT"], .page-sidebar-menu [onclick*="onShow"]')
            );
        """))
    except Exception:
        return False


def is_noi_tru_list_ready(driver):
    """Chỉ trả True khi thực sự ở danh sách nội trú.

    Trước đây code chỉ kiểm tra có #txtTimKiem nên bị false-positive: màn
    dieuduongdraw vẫn có ô tìm kiếm ở header, làm script tưởng đã về danh sách và
    tiếp tục set ngày/tìm BN sai ngữ cảnh.
    """
    try:
        wpid = _current_wpid(driver)
        if wpid and wpid != "danhsachdieutrinoitrudraw":
            return False
        return bool(driver.execute_script("""
            function visible(el){
              if(!el) return false;
              var st = window.getComputedStyle(el);
              return st.display !== 'none' && st.visibility !== 'hidden' &&
                     el.offsetParent !== null;
            }
            var table = document.getElementById('tblNoiTru');
            var search = document.getElementById('txtTimKiem');
            var btn = document.getElementById('btnTimKiem');
            if (!visible(table) || !visible(search) || !visible(btn)) return false;
            // Chặn trường hợp còn đang ở hồ sơ điều dưỡng nhưng có bảng/ô ẩn sót lại.
            if (document.getElementById('buttonBackNT')) return false;
            return true;
        """))
    except Exception:
        return False


def wait_noi_tru_list_ready(driver, timeout=10):
    try:
        WebDriverWait(driver, timeout).until(lambda d: is_noi_tru_list_ready(d))
        return True
    except Exception:
        return False


def _noi_tru_list_url_from_current(driver):
    """Tạo URL danh sách nội trú từ URL hiện tại, giữ scope/lang/role/usid/st."""
    cur = driver.current_url or ""
    sp = urlsplit(cur)
    params = dict(parse_qsl(sp.query, keep_blank_values=True))
    # Giữ `kp` (khoa/phòng) nếu URL chi tiết đang có.
    # Trước đây xóa `kp` làm EMR mở danh sách nhưng báo "Chưa chọn khoa phòng",
    # khiến phục hồi rất chậm và dễ kẹt click.
    for key in [
        "noitruid", "keyword", "wpre", "nextlink", "id",
        "mabenhnhan", "mabn", "mavaovien",
    ]:
        params.pop(key, None)
    params["wpid"] = "danhsachdieutrinoitrudraw"
    path = sp.path or "/home.aspx"
    if not path.lower().endswith("home.aspx"):
        path = "/home.aspx"
    return urlunsplit((sp.scheme, sp.netloc, path, urlencode(params), sp.fragment))


def force_open_noi_tru_list(driver, wait, from_dt=None, to_dt=None, reason=""):
    """Ép quay về danh sách nội trú bằng URL trực tiếp.

    Dùng khi buttonBackNT/driver.back không đáng tin, đặc biệt khi EMR báo
    `String was not recognized as a valid DateTime` hoặc vẫn đứng ở dieuduongdraw.
    """
    try:
        if reason:
            log_warn(f"Ép mở lại danh sách nội trú bằng URL — {reason}")
        else:
            log_warn("Ép mở lại danh sách nội trú bằng URL")
        dismiss_sweet_alert(driver, timeout=0.5 if FAST_UI else 1)
        url = _noi_tru_list_url_from_current(driver)
        driver.get(url)
        wait_document_idle(driver, timeout=1.2 if FAST_UI else 2.0)
        WebDriverWait(driver, 6 if FAST_UI else 12).until(EC.presence_of_element_located((By.ID, "txtTimKiem")))
        _fast_sleep(0.5)
        dismiss_sweet_alert(driver, timeout=0.5 if FAST_UI else 1)
        try:
            if not choose_completed_status(driver):
                log_warn("Chọn trạng thái Hoàn tất sau khi mở URL chưa thành công — thử lại bằng UI")
                _click_completed_status_ui(driver, timeout=5 if FAST_UI else 8)
        except Exception as e:
            log_warn(f"Chọn trạng thái Hoàn tất sau khi mở URL lỗi nhẹ: {e}")
        if from_dt or to_dt:
            restore_noi_tru_date_filter(driver, wait, from_dt, to_dt, click_search=True)
            # Sau khi bấm tìm, Select2/EMR đôi lúc tự trả về Đang thực hiện. Kiểm tra lại.
            if not is_completed_status_active(driver):
                log_warn(f"Sau khi đặt ngày, trạng thái đang là '{current_inpatient_status_text(driver)}' — chọn Hoàn tất lại")
                choose_completed_status(driver)
                restore_noi_tru_date_filter(driver, wait, from_dt, to_dt, click_search=True)
        else:
            try:
                btn = WebDriverWait(driver, 3 if FAST_UI else 6).until(EC.element_to_be_clickable((By.ID, "btnTimKiem")))
                driver.execute_script("arguments[0].click();", btn)
                wait_document_idle(driver, timeout=0.8 if FAST_UI else 1.5)
            except Exception:
                pass
        if wait_noi_tru_list_ready(driver, timeout=5 if FAST_UI else 10):
            log_ok("Đã ép về danh sách nội trú bằng URL")
            return True
        log_warn("Mở URL danh sách nhưng chưa thấy tblNoiTru/txtTimKiem/btnTimKiem visible")
        return False
    except Exception as e:
        log_warn(f"Ép mở danh sách nội trú bằng URL thất bại: {e}")
        return False

def restore_noi_tru_date_filter(driver, wait=None, from_dt=None, to_dt=None,
                                click_search=False, alert_already_dismissed=False):
    """Phục hồi thanh thời gian của danh sách nội trú sau lỗi DateTime.

    alert_already_dismissed=True: bỏ qua dismiss đầu (đã làm trước đó), tiết kiệm 4s.
    """
    if not alert_already_dismissed:
        dismiss_sweet_alert(driver, timeout=1.2 if FAST_UI else 4)
        _fast_sleep(0.2)
    set_emr_date_range(driver, from_dt, to_dt)
    vals = read_emr_date_range_values(driver)
    if vals:
        print(f"    Bộ lọc hiện tại: {vals.get('from','')} → {vals.get('to','')}")
    if click_search:
        for attempt in range(2):
            try:
                # Chỉ dismiss nếu có alert thực sự (timeout ngắn để không chờ vô ích)
                dismiss_sweet_alert(driver, timeout=0.2 if FAST_UI else 1)
                _wait = WebDriverWait(driver, 3 if FAST_UI else 6)
                btn = _wait.until(EC.element_to_be_clickable((By.ID, "btnTimKiem")))
                driver.execute_script("arguments[0].click();", btn)
                wait_document_idle(driver, timeout=0.8 if FAST_UI else 1.5)
                # Dismiss DateTime alert có thể xuất hiện sau click Tìm kiếm
                dismiss_sweet_alert(driver, timeout=0.5 if FAST_UI else 1)
                WebDriverWait(driver, 5 if FAST_UI else 8).until(EC.presence_of_element_located((By.ID, "tblNoiTru")))
                return True
            except Exception as e:
                if attempt == 0:
                    log_warn(f"Tìm kiếm lại lần 1 lỗi: {e} — thử lại")
                    dismiss_sweet_alert(driver, timeout=0.8 if FAST_UI else 2)
                    set_emr_date_range(driver, from_dt, to_dt)
                    _fast_sleep(0.3)
                else:
                    print(f"    ⚠ Không bấm Tìm kiếm lại được sau khi phục hồi ngày giờ: {e}")
                    return False
    return True

def set_noi_tru_day_filter_and_search(driver, wait, day):
    """Đặt EMR lọc đúng 1 ngày và bấm Tìm kiếm.

    Hàm này dùng riêng cho quét dữ liệu gốc. Nó tránh phụ thuộc vào trang hiện tại:
    mỗi ngày bắt đầu lại từ trang 1, nên nếu bệnh nhân bị đẩy trang do người mới
    xuất viện thì lần quét sau vẫn không bị sót.
    """
    day = day_start(day)
    label = day.strftime("%d/%m/%Y")
    print(f"    Ngày {label}: đặt bộ lọc 00:00 → 23:59")
    ok = restore_noi_tru_date_filter(driver, wait, day, day, click_search=True)
    if not ok:
        return False
    vals = read_emr_date_range_values(driver)
    from_val = normalize_text(vals.get("from", ""))
    to_val = normalize_text(vals.get("to", ""))
    # Nếu widget vẫn bị 01/01/0000 thì thử set lại thêm một lần.
    if "0000" in from_val or "0000" in to_val:
        print("    ⚠ DateTimePicker vẫn lỗi 01/01/0000, đặt lại lần 2...")
        ok = restore_noi_tru_date_filter(driver, wait, day, day, click_search=True)
    try:
        WebDriverWait(driver, 8).until(EC.presence_of_element_located((By.ID, "tblNoiTru")))
    except Exception:
        return False
    return bool(ok)


def guess_group_cdha(service_name):
    s = (service_name or "").lower()
    if any(x in s for x in ["ct", "cắt lớp", "scanner"]):
        return "CT"
    if any(x in s for x in ["mri", "cộng hưởng từ"]):
        return "MRI"
    if any(x in s for x in ["siêu âm", "sieu am"]):
        return "Siêu âm"
    if any(x in s for x in ["x quang", "x-quang", "xray", "x-ray"]) or re.search(r"\bxq\b", s):
        return "X-quang"
    if any(x in s for x in ["mật độ xương", "dexa"]):
        return "DEXA"
    if any(x in s for x in ["điện tim", "ecg"]):
        return "Điện tim"
    return "Khác"


def patient_context(row, index):
    ma_bn = first_value(row, ["Mã BN", "Ma BN", "Mã bệnh nhân", "Ma benh nhan", "ma_bn"])
    ho_ten = first_value(row, ["Họ tên", "Ho ten", "Tên BN", "Ten BN", "ten_benh_nhan"])
    chan_doan = first_value(row, ["Chẩn đoán vào viện", "Chan doan vao vien", "Chẩn đoán", "Chan doan", "Chẩn đoán chính", "Chan doan chinh"])
    tg_vao = first_value(row, ["T/G vào", "TG vao", "Thời gian vào", "Thoi gian vao", "Ngày vào viện", "Ngay vao vien", "Ngày nhập viện", "Ngay nhap vien"])
    research_code = first_value(row, ["Mã NC", "Ma NC", "research_id", "research_code"])
    if not research_code:
        research_code = f"NC{index + 1:04d}"
    noitru_id = first_value(row, ["Mã nội trú", "Ma noi tru", "noitruid", "noi_tru_id", "emr_noitru_id"])
    treatment_id = first_value(row, ["Mã điều trị", "Ma dieu tri", "dieutriid", "emr_treatment_id"]) or noitru_id
    admission_id = first_value(row, ["Mã vào viện", "Ma vao vien", "vaovienid", "emr_admission_id"])
    return {
        "Mã NC": research_code,
        "T/G vào": tg_vao,
        "Mã BN": ma_bn,
        "Mã vào viện": admission_id,
        "Mã điều trị": treatment_id,
        "Mã nội trú": noitru_id,
        "URL bác sĩ": first_value(row, ["URL bác sĩ", "URL bac si", "record_doctor_url", "doctor_url"]),
        "URL điều dưỡng": first_value(row, ["URL điều dưỡng", "URL dieu duong", "record_nursing_url", "nursing_url"]),
        "Họ tên": ho_ten,
        "Giới": first_value(row, ["GT", "Giới", "Gioi", "Giới tính", "Gioi tinh", "Sex"]),
        "Ngày sinh": first_value(row, ["Ngày sinh", "Ngay sinh", "DOB", "birth_date"]),
        "Tuổi": first_value(row, ["Tuổi", "Tuoi", "Age"]),
        "Địa chỉ": first_value(row, ["Địa chỉ", "Dia chi", "address"]),
        "Điện thoại": first_value(row, ["Điện thoại", "Dien thoai", "SĐT", "SDT", "Số điện thoại", "So dien thoai", "phone", "phone_number"]),
        "Số CMND": first_value(row, ["Số CMND", "So CMND", "Số CMT", "So CMT", "CMND", "CMT", "CCCD", "citizen_id"]),
        "Đối tượng": first_value(row, ["Đối tượng", "Doi tuong", "insurance_subject"]),
        "Số thẻ": first_value(row, ["Số thẻ", "So the", "Số thẻ BHYT", "So the BHYT", "insurance_card"]),
        "Loại": first_value(row, ["Loại", "Loai", "Loại BHYT", "Loai BHYT", "insurance_type"]),
        "Giá trị từ": first_value(row, ["Giá trị từ", "Gia tri tu", "Từ ngày", "Tu ngay", "valid_from"]),
        "Giá trị đến": first_value(row, ["Giá trị đến", "Gia tri den", "Đến ngày", "Den ngay", "valid_to"]),
        "Ngày vào viện": first_value(row, ["Ngày vào viện", "Ngay vao vien", "Ngày nhập viện", "Ngay nhap vien"]) or tg_vao,
        "Ngày ra viện": first_value(row, ["Ngày ra viện", "Ngay ra vien", "Ngày xuất viện", "Ngay xuat vien"]),
        "Thời gian điều trị": first_value(row, ["Thời gian điều trị", "Thoi gian dieu tri", "duration"]),
        "Chẩn đoán vào viện": chan_doan,
    }


def filter_valid_input_contexts(contexts):
    """Loại dòng input không có Mã BN trước khi mở Chrome/deep loop.

    Refetch CSV có thể được dựng từ nhiều nguồn legacy. Nếu một dòng chỉ có
    Mã NC nhưng thiếu Mã BN thì Selenium không thể tìm bệnh nhân; giữ dòng đó
    trong vòng lặp còn làm sai bộ đếm và có thể kích hoạt restart Chrome vô ích.
    """
    valid = []
    invalid = []
    for ctx in contexts or []:
        if normalize_text(ctx.get("Mã BN", "")):
            valid.append(ctx)
        else:
            invalid.append(ctx)
    return valid, invalid


def mkdirp(p):
    Path(p).mkdir(parents=True, exist_ok=True)


def open_csv(path, cols):
    path = Path(path)
    mkdirp(path.parent)
    is_new = not path.exists() or path.stat().st_size == 0
    fh = open(path, "a", encoding="utf-8-sig", newline="")
    wr = csv.DictWriter(fh, fieldnames=cols, extrasaction="ignore")
    if is_new:
        wr.writeheader()
        fh.flush()
    return fh, wr


def ensure_csv(path, cols):
    path = Path(path)
    mkdirp(path.parent)
    if not path.exists() or path.stat().st_size == 0:
        with open(path, "w", encoding="utf-8-sig", newline="") as f:
            w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
            w.writeheader()


def read_csv_rows(path):
    path = Path(path)
    if not path.exists() or path.stat().st_size == 0:
        return []
    with open(path, encoding="utf-8-sig", newline="") as f:
        return list(csv.DictReader(f))


def write_csv_rows(path, cols, rows):
    # Ghi CSV theo kiểu atomic: ghi vào file tạm rồi os.replace sang file thật.
    # Nếu mất điện/tắt máy đúng lúc đang ghi, file cũ vẫn còn nguyên; lần sau quét tiếp được.
    path = Path(path)
    mkdirp(path.parent)
    tmp = path.with_name(path.name + ".tmp")
    with open(tmp, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writeheader()
        w.writerows(rows or [])
        f.flush()
        try:
            os.fsync(f.fileno())
        except OSError:
            pass
    _replace_with_retry(tmp, path)


def append_csv_rows(path, cols, rows):
    rows = list(rows or [])
    if not rows:
        ensure_csv(path, cols)
        return
    path = Path(path)
    ensure_csv(path, cols)
    with open(path, "a", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=cols, extrasaction="ignore")
        w.writerows(rows)


def normalize_for_match(value):
    text = normalize_text(value)
    text = unicodedata.normalize("NFD", text)
    text = "".join(ch for ch in text if unicodedata.category(ch) != "Mn")
    return text.lower()


def xpath_literal(value):
    s = str(value or "")
    if "'" not in s:
        return f"'{s}'"
    if '"' not in s:
        return f'"{s}"'
    return "concat(" + ', "\'", '.join(f"'{part}'" for part in s.split("'")) + ")"


def canonical_visit_time(value):
    text = normalize_text(value)
    if not text:
        return ""
    dt = parse_vn_datetime(text)
    if dt:
        return dt.strftime("%Y-%m-%d %H:%M")
    # Chuẩn hóa nhẹ để so sánh cùng một thời điểm dù khác dấu / hoặc khoảng trắng.
    text = text.replace("/", "-")
    text = re.sub(r"\s+", " ", text).strip()
    return text


def visit_key(ctx, fallback=""):
    """Khóa ổn định cho một lượt điều trị.

    Ưu tiên Mã điều trị/Mã nội trú/Mã vào viện của EMR; chỉ fallback về
    Mã BN + ngày vào/ra khi các khóa EMR không có.

    Xử lý 3 trường hợp:
      (a) Có cả vào + ra  →  khóa đầy đủ, phân biệt nhiều lần nhập viện.
      (b) Chỉ có vào, chưa có ra (BN đang nằm viện)
             →  dùng sentinel "inpatient" thay vì "" hoặc "unknown".
             Lý do: nếu dùng "" thì hai BN khác nhau đều chưa có ngày ra viện
             sẽ có cùng khóa "{maBN}||" nếu cùng ngày vào — gộp sai.
             Dùng "inpatient" giúp phân biệt trạng thái này với trường hợp
             đã ra viện nhưng ngày ra viện bị trống (lỗi dữ liệu).
      (c) Không có cả hai  →  dùng fallback truyền vào (thường là index/page/row),
             hoặc "no_date" nếu fallback cũng trống.
             Tuyệt đối không dùng "unknown" để tránh nhiều ca khác nhau bị gộp chung.
    """
    ma_bn = normalize_text(ctx.get("Mã BN", ""))
    treatment_id = normalize_text(ctx.get("Mã điều trị", "") or ctx.get("Mã nội trú", "") or ctx.get("noitruid", ""))
    admission_id = normalize_text(ctx.get("Mã vào viện", "") or ctx.get("vaovienid", ""))
    if treatment_id:
        return f"{ma_bn}|treatment:{treatment_id.lower()}"
    if admission_id:
        return f"{ma_bn}|admission:{admission_id.lower()}"
    vao = canonical_visit_time(ctx.get("Ngày vào viện", ""))
    ra = canonical_visit_time(ctx.get("Ngày ra viện", ""))
    if vao and ra:
        # Trường hợp (a): khóa đầy đủ.
        return f"{ma_bn}|{vao}|{ra}"
    if vao:
        # Trường hợp (b): đang nằm viện — ra viện chưa có.
        return f"{ma_bn}|{vao}|inpatient"
    if ra:
        # Hiếm: chỉ biết ngày ra mà không biết ngày vào (lỗi dữ liệu EMR).
        return f"{ma_bn}|unknown_admit|{ra}"
    # Trường hợp (c): không có ngày nào — dùng fallback để tránh gộp nhầm.
    return f"{ma_bn}|{fallback or 'no_date'}"


def input_admission_time(ctx):
    return canonical_visit_time(ctx.get("Ngày vào viện", "") or ctx.get("T/G vào", ""))


def has_visit_filter(ctx):
    return bool(input_admission_time(ctx) or canonical_visit_time(ctx.get("Ngày ra viện", "")))


def visit_matches_filter(base_ctx, ctx):
    base_dt = parse_vn_datetime(base_ctx.get("T/G vào", "") or base_ctx.get("Ngày vào viện", ""))
    base_ra = canonical_visit_time(base_ctx.get("Ngày ra viện", ""))
    if not base_dt and not base_ra:
        return True

    start, end = visit_interval_datetimes(ctx)
    if base_dt:
        if start and end:
            if not (start <= base_dt <= end):
                return False
        elif start:
            # Chưa có ngày ra viện: giữ cách so khớp chặt để không gom nhầm nhiều lượt.
            if canonical_visit_time(base_ctx.get("T/G vào", "") or base_ctx.get("Ngày vào viện", "")) != canonical_visit_time(ctx.get("Ngày vào viện", "")):
                return False
        else:
            return False

    if base_ra:
        cur_ra = canonical_visit_time(ctx.get("Ngày ra viện", ""))
        if cur_ra and cur_ra != base_ra:
            return False
    return True


def merge_non_empty(target, source):
    for key, value in (source or {}).items():
        value = normalize_text(value)
        if value:
            target[key] = value
    return target


def remove_rows_by_identity(path, cols, ctx):
    path = Path(path)
    if not path.exists():
        ensure_csv(path, cols)
        return 0
    research_code = normalize_text(ctx.get("Mã NC", ""))
    ma_bn = normalize_text(ctx.get("Mã BN", ""))
    rows = read_csv_rows(path)
    if research_code:
        kept = [r for r in rows if normalize_text(r.get("Mã NC", "")) != research_code]
    else:
        kept = [r for r in rows if normalize_text(r.get("Mã BN", "")) != ma_bn]
    removed = len(rows) - len(kept)
    if removed:
        write_csv_rows(path, cols, kept)
    return removed


def filter_rows_by_identity(rows, ctx):
    """Trả về các dòng không thuộc lượt điều trị `ctx`, không ghi file.

    Dùng trong commit để dữ liệu cũ chỉ bị thay thế sau khi XN và CĐHA của case
    đều đã lấy thành công. Điều này tránh retry lỗi làm mất snapshot tốt trước đó.
    """
    research_code = normalize_text((ctx or {}).get("Mã NC", ""))
    ma_bn = normalize_text((ctx or {}).get("Mã BN", ""))
    if research_code:
        return [r for r in (rows or []) if normalize_text(r.get("Mã NC", "")) != research_code]
    if ma_bn:
        return [r for r in (rows or []) if normalize_text(r.get("Mã BN", "")) != ma_bn]
    return list(rows or [])


def upsert_patient_master_file(path, ctx):
    """Upsert một lượt điều trị vào file CSV master.

    Xử lý thêm trường hợp BN vừa ra viện: trước đó khóa là "inpatient"
    (chưa có ngày ra viện), nay đã có ngày ra → cần gộp đúng dòng cũ thay vì
    tạo dòng trùng. So sánh theo Mã BN + Ngày vào viện, bỏ qua trạng thái ra viện
    của dòng cũ khi tìm để gộp.
    """
    path = Path(path)
    ensure_csv(path, COL_PATIENTS)
    rows = read_csv_rows(path)
    key = visit_key(ctx)
    research_code = normalize_text(ctx.get("Mã NC", ""))

    # Khóa rút gọn chỉ dùng Mã BN + Ngày vào viện (bỏ qua ngày ra)
    # để bắt được trường hợp inpatient → discharged.
    vao_ctx = canonical_visit_time(ctx.get("Ngày vào viện", ""))
    ma_bn_ctx = normalize_text(ctx.get("Mã BN", ""))

    kept = []
    for row in rows:
        same_code = research_code and normalize_text(row.get("Mã NC", "")) == research_code
        same_visit = visit_key(row) == key
        if same_code or same_visit:
            continue
        # Bắt trường hợp chuyển trạng thái inpatient → có ngày ra viện:
        # dòng cũ có cùng Mã BN + Ngày vào viện nhưng ngày ra là "" hoặc "inpatient".
        if vao_ctx and ma_bn_ctx:
            row_vao = canonical_visit_time(row.get("Ngày vào viện", ""))
            row_ra = canonical_visit_time(row.get("Ngày ra viện", ""))
            row_ma = normalize_text(row.get("Mã BN", ""))
            if row_ma == ma_bn_ctx and row_vao == vao_ctx and not row_ra:
                continue  # gộp vào ctx bên dưới
        kept.append(row)
    kept.append(ctx)
    write_csv_rows(path, COL_PATIENTS, kept)


def upsert_patient_master(run_dir, ctx):
    # mau_nghien_cuu.csv: tên cũ dùng cho các nghiên cứu riêng.
    # du_lieu_goc.csv: tên rõ nghĩa hơn cho kho gốc sau khi đã lấy sâu từ du_lieu_ban_dau.csv.
    upsert_patient_master_file(Path(run_dir) / "mau_nghien_cuu.csv", ctx)
    upsert_patient_master_file(Path(run_dir) / "du_lieu_goc.csv", ctx)


def build_visit_code_map(rows):
    """Xây dựng mapping visit_key → Mã NC từ danh sách dòng đã lưu.

    Đăng ký thêm khóa inpatient (chưa có ngày ra viện) bên cạnh khóa đầy đủ,
    để khi BN ra viện và có thêm ngày ra, assign_research_code_for_visit vẫn
    nhận ra đây là cùng một lượt điều trị và không cấp Mã NC mới.
    """
    mapping = {}
    assigned_codes = set()
    for row in rows or []:
        code = normalize_text(row.get("Mã NC", ""))
        if not code:
            continue
        key = visit_key(row)
        mapping[key] = code
        assigned_codes.add(code)
        # Nếu đã có ngày ra viện, đăng ký thêm khóa "inpatient" (chưa có ngày ra)
        # để bắt trường hợp BN vừa được thêm vào lúc chưa xuất viện.
        ra = canonical_visit_time(row.get("Ngày ra viện", ""))
        vao = canonical_visit_time(row.get("Ngày vào viện", ""))
        ma_bn = normalize_text(row.get("Mã BN", ""))
        if vao and ma_bn:
            date_key = f"{ma_bn}|{vao}|{ra or 'inpatient'}"
            mapping.setdefault(date_key, code)
            # Nếu đã có ngày ra viện, đăng ký thêm khóa inpatient để bắt trường hợp
            # dòng cũ được lưu trước lúc xuất viện.
            if ra:
                mapping.setdefault(f"{ma_bn}|{vao}|inpatient", code)
    return mapping, assigned_codes


class ResearchCodeAllocator:
    def __init__(self, rows):
        self.used = set()
        self.next_number = 1
        for row in rows or []:
            self.reserve(normalize_text(row.get("Mã NC", "")))

    def reserve(self, code):
        if not code:
            return
        self.used.add(code)
        m = re.fullmatch(r"NC(\d+)", code.strip(), re.I)
        if m:
            self.next_number = max(self.next_number, int(m.group(1)) + 1)

    def new_code(self):
        while True:
            code = f"NC{self.next_number:04d}"
            self.next_number += 1
            if code not in self.used:
                self.used.add(code)
                return code


def assign_research_code_for_visit(ctx, base_ctx, allocator, encounter_code_map, assigned_codes, fallback=""):
    key = visit_key(ctx, fallback=fallback)
    candidate_keys = [key]
    ma_bn = normalize_text(ctx.get("Mã BN", ""))
    vao = canonical_visit_time(ctx.get("Ngày vào viện", "") or ctx.get("T/G vào", ""))
    ra = canonical_visit_time(ctx.get("Ngày ra viện", ""))
    if ma_bn and vao:
        candidate_keys.append(f"{ma_bn}|{vao}|{ra or 'inpatient'}")
        if ra:
            candidate_keys.append(f"{ma_bn}|{vao}|inpatient")
    existing = next((encounter_code_map.get(k) for k in candidate_keys if encounter_code_map.get(k)), None)
    if existing:
        ctx["Mã NC"] = existing
        encounter_code_map[key] = existing
        return key, existing, True

    preferred = normalize_text(ctx.get("Mã NC") or base_ctx.get("Mã NC"))
    if preferred and preferred not in assigned_codes:
        code = preferred
        allocator.reserve(code)
    else:
        code = allocator.new_code()
    ctx["Mã NC"] = code
    encounter_code_map[key] = code
    assigned_codes.add(code)
    return key, code, False


def remove_patient_rows(path, cols, ma_bn):
    path = Path(path)
    if not path.exists():
        ensure_csv(path, cols)
        return 0
    rows = read_csv_rows(path)
    kept = [r for r in rows if normalize_text(r.get("Mã BN", "")) != normalize_text(ma_bn)]
    removed = len(rows) - len(kept)
    if removed:
        write_csv_rows(path, cols, kept)
    return removed


def prepare_patient_commit(run_dir, ctx):
    # Chỉ bảo đảm file tồn tại. TUYỆT ĐỐI không xóa dữ liệu cũ ở đây:
    # nếu Selenium lỗi giữa XN và CĐHA thì snapshot tốt trước đó phải còn nguyên.
    recover_interrupted_patient_commits(run_dir)
    for filename, cols in [
        ("lich_su_xn.csv", COL_XN),
        ("lich_su_cdha.csv", COL_CDHA),
    ]:
        ensure_csv(Path(run_dir) / filename, cols)


def recover_interrupted_patient_commits(run_dir):
    """Khôi phục transaction commit dở dang còn lại sau kill/crash.

    Trước mỗi os.replace, filename được ghi vào state.json. Nếu process chết sau
    đó nhưng trước khi phase=committed, lần chạy kế tiếp phục hồi backup cho tất
    cả target đã được đánh dấu. Nếu phase=committed thì chỉ dọn staging thừa.
    """
    run_dir = Path(run_dir)
    for staging_dir in sorted(run_dir.glob(".commit_*")):
        if not staging_dir.is_dir():
            continue
        state_path = staging_dir / "state.json"
        state = {}
        try:
            if state_path.exists():
                with open(state_path, encoding="utf-8") as f:
                    state = json.load(f) or {}
        except Exception as e:
            log_warn(f"Không đọc được commit journal {state_path}: {e}")

        phase = normalize_text(state.get("phase", ""))
        targets = [normalize_text(x) for x in (state.get("replace_targets") or []) if normalize_text(x)]
        recovered = True
        if phase != "committed":
            for filename in reversed(targets):
                backup_path = staging_dir / (filename + ".backup")
                target = run_dir / filename
                if not backup_path.exists():
                    continue
                try:
                    _replace_with_retry(backup_path, target)
                except Exception as e:
                    recovered = False
                    log_warn(f"Không phục hồi được commit dở {filename}: {e}")
        if phase == "committed" or recovered:
            try:
                shutil.rmtree(staging_dir, ignore_errors=True)
            except Exception:
                pass
        else:
            log_warn(f"Giữ lại staging để phục hồi thủ công: {staging_dir}")


def commit_patient_outputs(run_dir, rows_by_table, ctx=None):
    """Ghi 2 file kết quả của một lượt điều trị theo cơ chế staging + rollback.

    Bước 1 — Ghi vào thư mục staging tạm (.commit_<ts>/): file gốc chưa bị động.
    Bước 2 — Atomic rename từng file staging → file thật (os.replace); nếu file sau
    lỗi trong cùng process thì rollback file đã thay từ backup.
    Journal state.json cho phép lần chạy kế tiếp rollback nếu process bị kill/crash
    giữa hai lần replace.
    """
    run_dir = Path(run_dir)
    tables = [
        ("lich_su_xn.csv",   COL_XN,   rows_by_table.get("xn") or []),
        ("lich_su_cdha.csv", COL_CDHA, rows_by_table.get("cdha") or []),
    ]

    # Tạo thư mục staging tạm với tên dựa trên timestamp để không đụng nhau
    # nếu có nhiều tiến trình chạy song song (hiếm nhưng an toàn hơn).
    staging_dir = run_dir / f".commit_{now_iso().replace(':', '').replace('-', '')}"
    mkdirp(staging_dir)
    state_path = staging_dir / "state.json"
    state = {"phase": "staging", "replace_targets": [], "created_at": now_iso()}
    cleanup_staging = False

    try:
        # Bước 1: đọc snapshot hiện tại, loại lượt đang retry TRONG BỘ NHỚ rồi
        # gộp dữ liệu mới. File thật chưa bị thay đổi ở bước này.
        for filename, cols, new_rows in tables:
            target = run_dir / filename
            ensure_csv(target, cols)
            existing = read_csv_rows(target)
            replacement_base = filter_rows_by_identity(existing, ctx) if ctx else existing
            staging_path = staging_dir / filename
            backup_path = staging_dir / (filename + ".backup")
            write_csv_rows(backup_path, cols, existing)
            write_csv_rows(staging_path, cols, replacement_base + list(new_rows))

        state["phase"] = "staged"
        if not _write_json_atomic(state_path, state):
            raise RuntimeError("Không ghi được commit journal trước khi replace.")

        # Bước 2: atomic rename từng file staging → file thật.
        for filename, cols, _ in tables:
            staging_path = staging_dir / filename
            target = run_dir / filename
            state["phase"] = "replacing"
            state["replace_targets"].append(filename)
            # Ghi journal TRƯỚC replace: nếu crash ngay sau đó, restore backup của
            # target này vẫn an toàn kể cả replace thực tế chưa xảy ra.
            if not _write_json_atomic(state_path, state):
                raise RuntimeError(f"Không cập nhật được commit journal trước {filename}.")
            _replace_with_retry(staging_path, target)  # atomic trên cùng filesystem

        state["phase"] = "committed"
        state["committed_at"] = now_iso()
        if not _write_json_atomic(state_path, state):
            raise RuntimeError("Đã replace dữ liệu nhưng không ghi được trạng thái committed.")
        cleanup_staging = True

    except Exception:
        rollback_ok = True
        # Nếu lỗi trong cùng process, rollback ngay. Journal vẫn là lớp bảo vệ cho
        # trường hợp kill/crash khi except/finally không có cơ hội chạy.
        if normalize_text(state.get("phase", "")) != "committed":
            for filename in reversed(state.get("replace_targets") or []):
                backup_path = staging_dir / (filename + ".backup")
                target = run_dir / filename
                if not backup_path.exists():
                    continue
                try:
                    _replace_with_retry(backup_path, target)
                except Exception as rollback_err:
                    rollback_ok = False
                    log_warn(f"Rollback {filename} thất bại: {rollback_err}")
        cleanup_staging = rollback_ok
        log_warn(f"commit_patient_outputs thất bại; staging={'dọn được' if rollback_ok else 'được giữ lại'}: {staging_dir}")
        raise

    finally:
        # Chỉ dọn khi commit thành công hoặc rollback đã hoàn tất. Nếu rollback lỗi,
        # giữ backup+journal để lần chạy sau/điều tra thủ công còn dữ liệu phục hồi.
        try:
            if cleanup_staging and staging_dir.exists():
                shutil.rmtree(staging_dir, ignore_errors=True)
        except Exception:
            pass


def write_manifest(run_dir, args, patients_count):
    manifest_path = Path(run_dir) / "manifest.json"
    existing = {}
    if manifest_path.exists():
        try:
            with open(manifest_path, encoding="utf-8") as f:
                existing = json.load(f) or {}
        except Exception:
            existing = {}
    manifest = {
        "project_id": args.project_id,
        "run_id": args.run_id,
        "created_at": existing.get("created_at") or now_iso(),
        "updated_at": now_iso(),
        "input_csv": str(Path(args.input).resolve()),
        "archive_initial_list": str(Path(args.archive_initial_list).resolve()) if getattr(args, "archive_initial_list", "") else "",
        "patients_count": patients_count,
        "from_date": args.from_date or "",
        "to_date": args.to_date or "",
        "headless": bool(args.headless),
        "outputs": {
            "initial_list": "du_lieu_ban_dau.csv",
            "patients": "mau_nghien_cuu.csv",
            "patient_extra": "thong_tin_benh_nhan_bo_sung.csv",
            "xn": "lich_su_xn.csv",
            "cdha": "lich_su_cdha.csv",
            "progress": PROGRESS_FILE,
            "errors": ERRORS_FILE,
        },
    }
    with open(manifest_path, "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=2)

# ── Config & Driver ──────────────────────────────────────────────────────────
def _set_webdriver_command_timeout(driver, seconds):
    """Giới hạn thời gian chờ của kênh Selenium ↔ ChromeDriver.

    Một số lúc Chrome/EMR đứng nhưng Selenium không trả lỗi ngay, khiến console dừng
    ở đúng tên bệnh nhân hiện tại. Hàm này cố đặt timeout cho nhiều phiên bản
    Selenium khác nhau; nếu phiên bản không hỗ trợ thì bỏ qua an toàn.
    """
    try:
        seconds = int(seconds or 0)
    except Exception:
        seconds = 0
    if seconds <= 0:
        return
    try:
        ce = getattr(driver, "command_executor", None)
        if not ce:
            return
        configured = False
        # Selenium mới yêu cầu đặt timeout qua client_config. Ưu tiên đường này
        # để không phát sinh DeprecationWarning từ RemoteConnection.set_timeout().
        try:
            cfg = getattr(ce, "_client_config", None)
            if cfg is not None and hasattr(cfg, "timeout"):
                cfg.timeout = seconds
                configured = True
        except Exception:
            pass
        # Tương thích Selenium cũ không có client_config. Cảnh báo deprecation
        # không phải lỗi quét nên không để nó làm nhiễu thông báo lỗi phía giao diện.
        if not configured:
            try:
                if hasattr(ce, "set_timeout"):
                    with warnings.catch_warnings():
                        warnings.simplefilter("ignore", DeprecationWarning)
                        ce.set_timeout(seconds)
            except Exception:
                pass
        try:
            conn = getattr(ce, "_conn", None)
            if conn is not None and hasattr(conn, "timeout"):
                conn.timeout = seconds
        except Exception:
            pass
    except Exception:
        pass

def load_config(script_dir):
    # Ưu tiên config.json cùng thư mục script, sau đó config/config.json ở project.
    candidates = [
        Path(script_dir) / "config.json",
        Path(script_dir) / "config" / "config.json",
        Path.cwd() / "config.json",
        Path.cwd() / "config" / "config.json",
    ]
    for p in candidates:
        if p.exists():
            with open(p, encoding="utf-8") as f:
                return json.load(f)
    raise FileNotFoundError("Không tìm thấy config.json")


def init_driver(headless=False):
    opts = webdriver.ChromeOptions()
    opts.add_argument("--start-maximized")
    opts.add_argument("--log-level=3")
    opts.add_experimental_option("excludeSwitches", ["enable-automation"])
    opts.add_experimental_option("useAutomationExtension", False)
    if headless:
        opts.add_argument("--headless=new")
        opts.add_argument("--window-size=1920,1080")
    driver = webdriver.Chrome(options=opts)
    _set_webdriver_command_timeout(driver, RESEARCH_SELENIUM_HTTP_TIMEOUT_SEC)
    try:
        driver.set_page_load_timeout(RESEARCH_PAGE_LOAD_TIMEOUT_SEC)
    except Exception:
        pass
    try:
        driver.set_script_timeout(RESEARCH_SCRIPT_TIMEOUT_SEC)
    except Exception:
        pass
    return driver, WebDriverWait(driver, 20)


def login(driver, wait, cfg):
    log_step("[1] Đăng nhập...")
    log_click(f"Mở URL đăng nhập: {cfg.get('url_login','')}")
    driver.get(cfg["url_login"])
    log_find("txtLoginName — nhập username")
    wait.until(EC.visibility_of_element_located((By.ID, "txtLoginName"))).send_keys(cfg["username"])
    log_click("btnLogin — bấm Đăng nhập")
    driver.find_element(By.ID, "txtPassword").send_keys(cfg["password"])
    driver.find_element(By.ID, "btnLogin").click()
    log_ok("Đăng nhập xong")


def vao_noi_tru(driver, wait):
    log_step("[2] Vào Nội trú...")
    log_click("Click menu 'Điều trị Nội trú'")
    wait.until(EC.element_to_be_clickable(
        (By.XPATH, "//span[contains(text(),'Điều trị Nội trú') or contains(text(),'Điều trị nội trú')]")
    )).click()
    time.sleep(0.4)
    log_click("Click link 'D/s Điều trị nội trú'")
    wait.until(EC.element_to_be_clickable((By.PARTIAL_LINK_TEXT, "D/s Điều trị nội trú"))).click()
    log_find("Chờ txtTimKiem hiện")
    wait.until(EC.visibility_of_element_located((By.ID, "txtTimKiem")))
    log_ok("Đã vào danh sách nội trú")



def _force_open_patient_list(driver, wait, reason=""):
    """Mở trực tiếp Quản lý Bệnh nhân → D/s Bệnh nhân bằng URL hiện tại.

    Giữ các tham số đăng nhập của EMR như scope/lang/role/usid/st, chỉ đổi wpid
    sang benhnhandanhsachdraw. Cách này nhanh và ổn định hơn khi menu bên trái
    đang thu gọn hoặc Selenium click menu bị treo.
    """
    from urllib.parse import urlparse, parse_qsl, urlencode, urlunparse
    try:
        cur = driver.current_url or ""
        if reason:
            log_warn(f"Ép mở D/s Bệnh nhân bằng URL — {reason}")
        else:
            log_info("Ép mở D/s Bệnh nhân bằng URL")
        pr = urlparse(cur)
        qs = dict(parse_qsl(pr.query, keep_blank_values=True))
        qs["wpid"] = "benhnhandanhsachdraw"
        # Không giữ tham số của màn nội trú nếu có.
        for k in ["kp", "phongid", "benhnhanid", "noitruid", "dieutriid", "vaovienid"]:
            qs.pop(k, None)
        if not pr.path or not pr.netloc:
            return False
        url = urlunparse((pr.scheme, pr.netloc, pr.path, pr.params, urlencode(qs), pr.fragment))
        driver.get(url)
        if wait_patient_list_ready(driver, timeout=10):
            log_ok("Đã vào D/s Bệnh nhân")
            return True
        log_warn("Mở URL D/s Bệnh nhân nhưng chưa thấy txtTimKiem/btnTimKiem")
    except Exception as e:
        log_warn(f"Ép mở D/s Bệnh nhân lỗi: {e}")
    return False


def wait_patient_list_ready(driver, timeout=8):
    end = time.time() + max(0.5, float(timeout or 0))
    while time.time() < end:
        try:
            wpid = _current_wpid(driver)
            ready = driver.execute_script(r"""
                function visible(el){
                  if(!el) return false;
                  var st = window.getComputedStyle(el);
                  return st.display !== 'none' && st.visibility !== 'hidden' && el.offsetParent !== null;
                }
                var txt = document.getElementById('txtTimKiem');
                var btn = document.getElementById('btnTimKiem');
                var content = document.getElementById('divBenhNhanDanhSachContent');
                return !!(visible(txt) && visible(btn) && (content || document.body.innerText.indexOf('Tổng số bản ghi') >= 0));
            """)
            if ready and (not wpid or wpid == "benhnhandanhsachdraw"):
                return True
        except Exception:
            pass
        time.sleep(0.15)
    return False


def vao_danh_sach_benh_nhan(driver, wait):
    log_step("[2] Vào Quản lý Bệnh nhân → D/s Bệnh nhân...")
    dismiss_sweet_alert(driver, timeout=0.5 if FAST_UI else 1)
    if wait_patient_list_ready(driver, timeout=1):
        log_ok("Đã ở D/s Bệnh nhân")
        return True
    # Ưu tiên click menu để đúng flow EMR.
    try:
        log_click("Click menu 'Quản lý Bệnh nhân'")
        menu = WebDriverWait(driver, 4 if FAST_UI else 8).until(
            EC.presence_of_element_located((By.XPATH, "//span[contains(normalize-space(.),'Quản lý Bệnh nhân') or contains(normalize-space(.),'Quản lý bệnh nhân')]") )
        )
        _safe_click(driver, menu)
        time.sleep(0.25)
        log_click("Click link 'D/s Bệnh nhân'")
        link = WebDriverWait(driver, 4 if FAST_UI else 8).until(
            EC.presence_of_element_located((By.XPATH, "//a[contains(normalize-space(.),'D/s Bệnh nhân') or contains(@href,'wpid=benhnhandanhsachdraw')]") )
        )
        _safe_click(driver, link)
        if wait_patient_list_ready(driver, timeout=8):
            log_ok("Đã vào D/s Bệnh nhân")
            return True
    except Exception as e:
        log_warn(f"Click menu D/s Bệnh nhân không chắc chắn: {e}")
    return _force_open_patient_list(driver, wait, reason="menu không vào được")


def parse_patient_list_result_row(driver, ma_bn):
    """Đọc dòng trong D/s Bệnh nhân sau khi tìm theo Mã BN."""
    ma_bn = normalize_text(ma_bn)
    js = r"""
        var code = String(arguments[0] || '').trim();
        function text(el){ return (el ? (el.innerText || el.textContent || '') : '').replace(/\s+/g,' ').trim(); }
        var root = document.getElementById('divBenhNhanDanhSachContent') || document;
        var rows = Array.prototype.slice.call(root.querySelectorAll('table tbody tr, table tr'));
        for (var i=0; i<rows.length; i++) {
          var cells = Array.prototype.slice.call(rows[i].querySelectorAll('td'));
          if (cells.length < 7) continue;
          var got = text(cells[0]);
          if (got === code || got.indexOf(code) >= 0) {
            return {
              ma_bn: got,
              ho_ten: text(cells[1]),
              nam_sinh: text(cells[2]),
              dia_chi: text(cells[3]),
              bhyt: text(cells[4]),
              dien_thoai: text(cells[5]),
              cmnd: text(cells[6])
            };
          }
        }
        return null;
    """
    row = driver.execute_script(js, ma_bn) or None
    if not row:
        return None
    return {
        "Mã BN": normalize_text(row.get("ma_bn")),
        "Họ tên": normalize_text(row.get("ho_ten")),
        "Năm sinh": normalize_text(row.get("nam_sinh")),
        "Địa chỉ": normalize_text(row.get("dia_chi")),
        "Số thẻ BHYT": normalize_text(row.get("bhyt")),
        "Điện thoại": normalize_text(row.get("dien_thoai")),
        "Số CMND": normalize_text(row.get("cmnd")),
        "Lấy lúc": now_iso(),
        "Trạng thái": "done",
        "Ghi chú": "",
    }


def tim_thong_tin_benh_nhan(driver, wait, ma_bn):
    """Tìm mã BN ở Quản lý Bệnh nhân → D/s Bệnh nhân và lấy SĐT/CMND."""
    ma_bn = normalize_text(ma_bn)
    if not ma_bn:
        return None
    if not wait_patient_list_ready(driver, timeout=1):
        vao_danh_sach_benh_nhan(driver, wait)
    if not wait_patient_list_ready(driver, timeout=8):
        raise RuntimeError("Chưa ở D/s Bệnh nhân nên không thể lấy thông tin khác")

    log_find(f"D/s Bệnh nhân — tìm Mã BN: {ma_bn}")
    driver.execute_script(r"""
        function setVal(id, value){
          var el = document.getElementById(id);
          if (!el) return;
          el.value = value || '';
          el.dispatchEvent(new Event('input', {bubbles:true}));
          el.dispatchEvent(new Event('change', {bubbles:true}));
        }
        setVal('txtTimKiem', arguments[0]);
        setVal('txtMaLienKet', '');
        setVal('txtNamSinh', '');
        setVal('txtBHYT', '');
        setVal('txtCMT', '');
    """, ma_bn)
    log_click("D/s Bệnh nhân — bấm Tìm kiếm")
    clicked = driver.execute_script(r"""
        try { if (typeof window.FilterChange === 'function') { window.FilterChange(); return 'FilterChange'; } } catch(e) {}
        var btn = document.getElementById('btnTimKiem');
        if (btn) { try { btn.click(); return 'btnTimKiem'; } catch(e2) {} }
        return '';
    """)
    if not clicked:
        btn = wait.until(EC.presence_of_element_located((By.ID, "btnTimKiem")))
        _safe_click(driver, btn)
    wait_document_idle(driver, timeout=0.8 if FAST_UI else 1.5)
    dismiss_sweet_alert(driver, timeout=0.5 if FAST_UI else 1)

    end = time.time() + (6 if FAST_UI else 10)
    info = None
    while time.time() < end:
        info = parse_patient_list_result_row(driver, ma_bn)
        if info:
            break
        time.sleep(0.2)
    if info:
        log_ok(f"D/s Bệnh nhân: {ma_bn} | SĐT={info.get('Điện thoại','')} | CMND={info.get('Số CMND','')}")
        return info
    log_warn(f"D/s Bệnh nhân: không tìm thấy Mã BN {ma_bn}")
    return {
        "Mã BN": ma_bn,
        "Họ tên": "",
        "Năm sinh": "",
        "Địa chỉ": "",
        "Số thẻ BHYT": "",
        "Điện thoại": "",
        "Số CMND": "",
        "Lấy lúc": now_iso(),
        "Trạng thái": "not_found",
        "Ghi chú": "Không tìm thấy trên D/s Bệnh nhân",
    }


def upsert_patient_extra_file(path, info):
    path = Path(path)
    ensure_csv(path, COL_PATIENT_EXTRA)
    rows = read_csv_rows(path)
    ma_bn = normalize_text(info.get("Mã BN", ""))
    kept = [r for r in rows if normalize_text(r.get("Mã BN", "")) != ma_bn]
    kept.append({k: info.get(k, "") for k in COL_PATIENT_EXTRA})
    write_csv_rows(path, COL_PATIENT_EXTRA, kept)


def merge_patient_extra_into_existing_master(run_dir, info):
    """Bổ sung SĐT/CMND vào các file master đã có, không tạo file deep giả."""
    ma_bn = normalize_text(info.get("Mã BN", ""))
    if not ma_bn:
        return
    patch = {
        "Điện thoại": info.get("Điện thoại", ""),
        "Số CMND": info.get("Số CMND", ""),
        "Địa chỉ": info.get("Địa chỉ", ""),
        "Số thẻ": info.get("Số thẻ BHYT", ""),
    }
    for fname in ("mau_nghien_cuu.csv", "du_lieu_goc.csv"):
        fpath = Path(run_dir) / fname
        if not fpath.exists() or fpath.stat().st_size == 0:
            continue
        rows = read_csv_rows(fpath)
        changed = False
        for row in rows:
            if normalize_text(row.get("Mã BN", "")) != ma_bn:
                continue
            for k, v in patch.items():
                if v and not normalize_text(row.get(k, "")):
                    row[k] = v
                    changed = True
        if changed:
            write_csv_rows(fpath, COL_PATIENTS, rows)


def run_patient_extra_mode(driver, wait, run_dir, contexts, progress, w_err, f_err):
    """Mode riêng: lấy SĐT/CMND từ Quản lý Bệnh nhân → D/s Bệnh nhân."""
    extra_path = Path(run_dir) / "thong_tin_benh_nhan_bo_sung.csv"
    ensure_csv(extra_path, COL_PATIENT_EXTRA)
    existing = {normalize_text(r.get("Mã BN", "")): r for r in read_csv_rows(extra_path)}
    seen = set()
    unique_contexts = []
    for ctx in contexts:
        ma_bn = normalize_text(ctx.get("Mã BN", ""))
        if ma_bn and ma_bn not in seen:
            seen.add(ma_bn)
            unique_contexts.append(ctx)

    vao_danh_sach_benh_nhan(driver, wait)
    ok = skip = err = 0
    for i, ctx in enumerate(unique_contexts, 1):
        ma_bn = normalize_text(ctx.get("Mã BN", ""))
        if not ma_bn:
            skip += 1
            continue
        touch_watchdog(f"Thông tin khác {i}/{len(unique_contexts)} {ma_bn}")
        print(f"[{i}/{len(unique_contexts)}] Thông tin khác: {ma_bn} - {ctx.get('Họ tên','')}", flush=True)
        old = existing.get(ma_bn)
        if old and normalize_text(old.get("Trạng thái")) == "done" and (normalize_text(old.get("Điện thoại")) or normalize_text(old.get("Số CMND"))):
            print("      ↪ Đã có SĐT/CMND — bỏ qua", flush=True)
            skip += 1
            continue
        try:
            info = tim_thong_tin_benh_nhan(driver, wait, ma_bn)
            if not info:
                raise RuntimeError("Không đọc được kết quả D/s Bệnh nhân")
            # Nếu danh sách trả thiếu họ tên, giữ họ tên từ input để dễ đối chiếu.
            if not info.get("Họ tên") and ctx.get("Họ tên"):
                info["Họ tên"] = ctx.get("Họ tên")
            upsert_patient_extra_file(extra_path, info)
            merge_patient_extra_into_existing_master(run_dir, info)
            existing[ma_bn] = info
            if info.get("Trạng thái") == "done":
                ok += 1
            else:
                skip += 1
            print(f"      OK: SĐT={info.get('Điện thoại','')} | CMND={info.get('Số CMND','')}", flush=True)
        except Exception as e:
            err += 1
            log_error(w_err, f_err, ctx, "Thông tin khác", "D/s Bệnh nhân", e)
            info = {
                "Mã BN": ma_bn,
                "Họ tên": ctx.get("Họ tên", ""),
                "Năm sinh": "",
                "Địa chỉ": ctx.get("Địa chỉ", ""),
                "Số thẻ BHYT": ctx.get("Số thẻ", ""),
                "Điện thoại": "",
                "Số CMND": "",
                "Lấy lúc": now_iso(),
                "Trạng thái": "error",
                "Ghi chú": str(e)[:300],
            }
            upsert_patient_extra_file(extra_path, info)
            try:
                if not wait_patient_list_ready(driver, timeout=2):
                    vao_danh_sach_benh_nhan(driver, wait)
            except Exception:
                pass
    print(f"\n✅ Xong thông tin khác! Lấy được: {ok} | Bỏ qua/chưa có: {skip} | Lỗi: {err}")
    print(f"   File: {extra_path}")
    return {"ok": ok, "skip": skip, "error": err}

def chon_hoan_tat(driver, wait, from_dt=None, to_dt=None):
    print("[3] Chọn Hoàn tất...")
    dismiss_sweet_alert(driver, timeout=1)
    if not choose_completed_status(driver):
        raise RuntimeError(f"Không chọn được trạng thái Hoàn tất; hiện tại: {current_inpatient_status_text(driver)}")
    # Khi đổi sang Hoàn tất, EMR thường reset cbbLoai về "3 tháng". Đổi ngay sang
    # "Khoảng" rồi set khoảng ngày từ web app: 00:00 ngày bắt đầu → 23:59 ngày kết thúc.
    set_emr_date_range(driver, from_dt, to_dt)
    dismiss_sweet_alert(driver, timeout=1)
    wait.until(EC.element_to_be_clickable((By.ID, "btnTimKiem"))).click()
    time.sleep(2)
    msg = dismiss_sweet_alert(driver, timeout=2)
    if msg:
        # Nếu EMR báo DateTime ngay sau khi bấm tìm kiếm, đặt lại chính xác
        # 00:00/23:59 rồi bấm tìm kiếm lại một lần.
        restore_noi_tru_date_filter(driver, wait, from_dt, to_dt, click_search=True)
    # Kiểm tra lại lần cuối sau khi bấm tìm kiếm; nếu EMR tự reset về Đang thực hiện thì chọn lại.
    if not is_completed_status_active(driver):
        log_warn(f"Sau tìm kiếm trạng thái bị đổi thành '{current_inpatient_status_text(driver)}' — chọn Hoàn tất lại")
        if not choose_completed_status(driver):
            raise RuntimeError(f"Sau tìm kiếm không giữ được trạng thái Hoàn tất; hiện tại: {current_inpatient_status_text(driver)}")
        restore_noi_tru_date_filter(driver, wait, from_dt, to_dt, click_search=True)
    wait.until(EC.presence_of_element_located((By.ID, "tblNoiTru")))


def _append_jsonl(path, payload):
    try:
        path = Path(path)
        mkdirp(path.parent)
        with open(path, "a", encoding="utf-8", buffering=1) as f:
            f.write(json.dumps(payload, ensure_ascii=False) + "\n")
        return True
    except Exception:
        return False


def _quit_driver_nonblocking(driver, timeout=None):
    """Đóng Chrome/Selenium nhưng không để driver.quit() treo vĩnh viễn."""
    if not driver:
        return True
    timeout = RESEARCH_BROWSER_QUIT_TIMEOUT_SEC if timeout is None else max(1, int(timeout))
    service_proc = None
    try:
        service_proc = getattr(getattr(driver, "service", None), "process", None)
    except Exception:
        service_proc = None

    done = {"ok": False, "error": ""}

    def _do_quit():
        try:
            driver.quit()
            done["ok"] = True
        except Exception as e:
            done["error"] = str(e)[:300]

    t = threading.Thread(target=_do_quit, name="research-driver-quit", daemon=True)
    t.start()
    t.join(timeout)
    if t.is_alive():
        try:
            log_warn(f"driver.quit() quá {timeout}s — terminate chromedriver để tránh đứng im")
        except Exception:
            pass
        try:
            if service_proc and service_proc.poll() is None:
                service_proc.terminate()
        except Exception:
            pass
        time.sleep(1)
        try:
            if service_proc and service_proc.poll() is None:
                service_proc.kill()
        except Exception:
            pass
        return False
    if done.get("error"):
        try:
            log_warn(f"driver.quit() lỗi nhẹ: {done.get('error')}")
        except Exception:
            pass
    return bool(done.get("ok"))



def _sleep_with_watchdog(seconds, stage="chờ"):
    """Ngủ nhưng vẫn cập nhật watchdog để không bị coi là treo."""
    try:
        seconds = float(seconds or 0)
    except Exception:
        seconds = 0
    if seconds <= 0:
        return
    end = time.time() + seconds
    while time.time() < end:
        touch_watchdog(stage)
        time.sleep(min(1.0, max(0.0, end - time.time())))


def _is_transient_browser_start_error(exc):
    """Nhận diện lỗi hạ tầng tạm thời khi mở/login Chrome."""
    text = str(exc or "")
    low = text.lower()
    transient_markers = [
        "err_connection_timed_out",
        "err_timed_out",
        "timeout",
        "timed out",
        "chrome not reachable",
        "disconnected",
        "cannot determine loading status",
        "target window already closed",
        "invalid session id",
        "session deleted",
        "connection refused",
        "connection reset",
    ]
    return any(m in low for m in transient_markers)


def _kill_process_tree(pid, reason=""):
    """Dọn process tree của chromedriver/chrome do Selenium mở, nếu còn sót."""
    try:
        pid = int(pid or 0)
    except Exception:
        pid = 0
    if pid <= 0:
        return False
    try:
        if os.name == "nt":
            subprocess.run(
                ["taskkill", "/PID", str(pid), "/T", "/F"],
                stdout=subprocess.DEVNULL,
                stderr=subprocess.DEVNULL,
                timeout=8,
                check=False,
            )
        else:
            try:
                os.kill(pid, signal.SIGTERM)
            except Exception:
                pass
        if reason:
            log_warn(f"[BROWSER] Đã dọn process tree PID={pid} — {reason}")
        return True
    except Exception as e:
        try:
            log_warn(f"[BROWSER] Không dọn được process tree PID={pid}: {e}")
        except Exception:
            pass
        return False


def _cleanup_driver_process_tree(driver, reason=""):
    if not driver or not RESEARCH_CLEAN_OWNED_CHROME_ON_RESTART_FAIL:
        return False
    try:
        proc = getattr(getattr(driver, "service", None), "process", None)
        pid = getattr(proc, "pid", None)
    except Exception:
        pid = None
    return _kill_process_tree(pid, reason=reason)

def _owned_browser_ram_mb(driver):
    """RAM của Chrome/Edge do chính Chromedriver hiện tại tạo.

    Không dùng tổng RAM mọi chrome.exe trên máy: người dùng có thể đang mở
    dashboard bằng Chrome và làm ngưỡng restart bị kích hoạt sai.
    """
    if not driver:
        return 0.0
    try:
        proc = getattr(getattr(driver, "service", None), "process", None)
        root_pid = int(getattr(proc, "pid", 0) or 0)
        if root_pid <= 0:
            return 0.0
        import psutil  # type: ignore
        root = psutil.Process(root_pid)
        total = 0
        for child in root.children(recursive=True):
            try:
                name = (child.name() or "").lower()
                if "chrome" not in name and "msedge" not in name:
                    continue
                total += int(child.memory_info().rss or 0)
            except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess):
                continue
        return round(total / (1024 * 1024), 1)
    except Exception:
        # psutil không có/không đọc được process tree: bỏ kiểm tra RAM-based.
        # Restart định kỳ RESEARCH_CHROME_RESTART_EVERY vẫn còn hoạt động.
        return 0.0


def _browser_restart_reason(run_dir, items_since_restart, driver=None, reason_prefix=""):
    """Trả về lý do cần restart Chrome giữa các BN, hoặc chuỗi rỗng."""
    if not RESEARCH_AUTO_RESTART_BROWSER:
        return ""
    try:
        items_since_restart = int(items_since_restart or 0)
    except Exception:
        items_since_restart = 0

    if RESEARCH_CHROME_RESTART_EVERY > 0 and items_since_restart >= RESEARCH_CHROME_RESTART_EVERY:
        return f"đã xử lý {items_since_restart} dòng từ lần mở Chrome gần nhất"

    # Kiểm tra RAM theo chu kỳ để tránh tasklist/ps chạy quá thường xuyên.
    check_every = max(1, int(RESEARCH_RESTART_CHECK_EVERY or 1))
    if (
        RESEARCH_CHROME_MAX_MB > 0
        and items_since_restart >= max(1, int(RESEARCH_CHROME_RAM_RESTART_MIN_ITEMS or 1))
        and items_since_restart % check_every == 0
    ):
        # Resource snapshot vẫn ghi tổng Chrome để chẩn đoán, nhưng quyết định
        # restart chỉ dựa trên browser process tree thuộc worker hiện tại.
        write_resource_snapshot(run_dir, reason=reason_prefix or "restart_check")
        chrome_mb = _owned_browser_ram_mb(driver)
        if chrome_mb >= RESEARCH_CHROME_MAX_MB:
            return f"Chrome Selenium RAM {chrome_mb}MB ≥ ngưỡng {RESEARCH_CHROME_MAX_MB}MB"
    return ""


def restart_browser_session(old_driver, args, cfg, run_dir, from_dt=None, to_dt=None, mode="deep", reason=""):
    """Recycle Chrome an toàn: đóng Chrome cũ, mở Chrome mới, đăng nhập lại và về đúng màn.

    Lỗi net::ERR_CONNECTION_TIMED_OUT khi mở login.aspx thường là nghẽn mạng/EMR
    tạm thời hoặc Chrome/Chromedriver vừa restart chưa sạch. Không coi đây là lỗi
    dữ liệu nghiên cứu; thử lại vài lần rồi chỉ báo FATAL khi thật sự hết lượt thử.
    """
    run_dir = Path(run_dir)
    reason = reason or "restart định kỳ"
    touch_watchdog(f"Restart Chrome: {reason}")
    log_warn(f"[BROWSER] Restart Chrome — {reason}")
    payload = {
        "time": now_iso(),
        "reason": reason,
        "mode": mode,
        "status": "starting",
        "max_attempts": max(1, int(RESEARCH_BROWSER_RESTART_MAX_ATTEMPTS or 1)),
        "resource_before": get_last_resource_snapshot(),
    }
    _write_json_atomic(run_dir / "browser_restart_status.json", payload)
    _append_jsonl(run_dir / "browser_restarts.jsonl", payload)

    _quit_driver_nonblocking(old_driver)
    _sleep_with_watchdog(1.0, "chờ sau khi đóng Chrome cũ")

    max_attempts = max(1, int(RESEARCH_BROWSER_RESTART_MAX_ATTEMPTS or 1))
    base_delay = max(0.0, float(RESEARCH_BROWSER_RESTART_RETRY_DELAY_SEC or 0))
    backoff = max(0.0, float(RESEARCH_BROWSER_RESTART_RETRY_BACKOFF_SEC or 0))
    last_error = ""
    last_transient = False

    for attempt in range(1, max_attempts + 1):
        new_driver = new_wait = None
        attempt_payload = dict(payload)
        attempt_payload.update({
            "time_attempt": now_iso(),
            "status": "attempting",
            "attempt": attempt,
        })
        _write_json_atomic(run_dir / "browser_restart_status.json", attempt_payload)
        _append_jsonl(run_dir / "browser_restarts.jsonl", attempt_payload)
        try:
            touch_watchdog(f"Mở Chrome mới lần {attempt}/{max_attempts}")
            if attempt > 1:
                log_warn(f"[BROWSER] Thử mở lại Chrome lần {attempt}/{max_attempts}")
            new_driver, new_wait = init_driver(headless=getattr(args, "headless", False))
            login(new_driver, new_wait, cfg)
            if mode == "patient_info":
                vao_danh_sach_benh_nhan(new_driver, new_wait)
            else:
                vao_noi_tru(new_driver, new_wait)
                chon_hoan_tat(new_driver, new_wait, from_dt, to_dt)
            touch_watchdog("Restart Chrome xong")
            snap_after = write_resource_snapshot(run_dir, reason="after_browser_restart", force_log=True)
            done_payload = dict(payload)
            done_payload.update({
                "time_done": now_iso(),
                "status": "done",
                "attempt": attempt,
                "resource_after": snap_after,
            })
            _write_json_atomic(run_dir / "browser_restart_status.json", done_payload)
            _append_jsonl(run_dir / "browser_restarts.jsonl", done_payload)
            log_ok("[BROWSER] Đã mở Chrome mới và phục hồi màn làm việc")
            return new_driver, new_wait
        except Exception as e:
            last_error = str(e)[:1200]
            last_transient = _is_transient_browser_start_error(e)
            err_payload = dict(payload)
            err_payload.update({
                "time_done": now_iso(),
                "status": "retrying" if attempt < max_attempts else "error",
                "attempt": attempt,
                "error": last_error,
                "transient": bool(last_transient),
            })
            _write_json_atomic(run_dir / "browser_restart_status.json", err_payload)
            _append_jsonl(run_dir / "browser_restarts.jsonl", err_payload)
            try:
                log_warn(f"[BROWSER] Mở/login Chrome lỗi lần {attempt}/{max_attempts}: {last_error[:300]}")
            except Exception:
                pass
            try:
                _quit_driver_nonblocking(new_driver, timeout=5)
            except Exception:
                pass
            try:
                _cleanup_driver_process_tree(new_driver, reason="restart/login lỗi")
            except Exception:
                pass

            if attempt < max_attempts:
                delay = base_delay + (attempt - 1) * backoff
                if last_transient:
                    log_warn(f"[BROWSER] Lỗi có vẻ tạm thời; chờ {delay:.0f}s rồi thử lại, không dừng phiên nghiên cứu")
                else:
                    log_warn(f"[BROWSER] Chờ {delay:.0f}s rồi thử lại để tránh dừng giữa phiên nghiên cứu")
                _sleep_with_watchdog(delay, f"chờ retry restart Chrome {attempt}/{max_attempts}")
                continue

    final_payload = dict(payload)
    final_payload.update({
        "time_done": now_iso(),
        "status": "error",
        "error": last_error,
        "transient": bool(last_transient),
        "attempts": max_attempts,
        "hint": "Không khởi động lại được Chrome sau nhiều lần thử. Chạy lại tác vụ để resume từ progress.json.",
    })
    _write_json_atomic(run_dir / "browser_restart_status.json", final_payload)
    _write_json_atomic(run_dir / "fatal_alert.json", {
        "level": "FATAL",
        "time": now_iso(),
        "kind": "browser_restart_error",
        "message": last_error,
        "attempts": max_attempts,
        "hint": "Không mở được EMR sau nhiều lần thử. Kiểm tra mạng/HIS, đóng Chrome/Chromedriver treo nếu có, rồi chạy lại để resume.",
    })
    _append_jsonl(run_dir / "browser_restarts.jsonl", final_payload)
    raise RuntimeError(f"Không khởi động lại được Chrome sau {max_attempts} lần thử: {last_error}")

# ── Progress/Error ───────────────────────────────────────────────────────────
def load_progress(run_dir):
    p = Path(run_dir) / PROGRESS_FILE
    if not p.exists():
        return {}
    try:
        with open(p, encoding="utf-8") as f:
            data = json.load(f)
        # Hỗ trợ progress kiểu cũ: list mã BN đã xong.
        if isinstance(data, list):
            return {str(ma): {"popup": "done", "xn": "done", "cdha": "done"} for ma in data}
        if isinstance(data, dict):
            return data
    except Exception:
        pass
    return {}


def save_progress(run_dir, progress):
    p = Path(run_dir) / PROGRESS_FILE
    tmp = p.with_suffix(".tmp")
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(progress, f, ensure_ascii=False, indent=2)
    _replace_with_retry(tmp, p)


def ensure_patient_progress(progress, ma_bn):
    return progress.setdefault(ma_bn, {
        "popup": "pending",
        "xn": "pending",
        "cdha": "pending",
        "committed": False,
        "status": "pending",
        "updated_at": now_iso(),
        "last_error": "",
    })


def mark_progress(progress, ma_bn, tab, status, error=""):
    item = ensure_patient_progress(progress, ma_bn)
    item[tab] = status
    item["updated_at"] = now_iso()
    if tab in {"popup", "xn", "cdha"} and status not in {"done"}:
        item["status"] = "incomplete"
        item["committed"] = False
    if error:
        item["last_error"] = error[:1000]


def mark_patient_committed(progress, ma_bn, counts=None):
    item = ensure_patient_progress(progress, ma_bn)
    item.update({
        "popup": "done",
        "xn": "done",
        "cdha": "done",
        "committed": True,
        "status": "done",
        "updated_at": now_iso(),
        "last_error": "",
    })
    if counts:
        item["counts"] = counts


def is_patient_done(progress, ma_bn):
    item = progress.get(ma_bn) or {}
    if item.get("committed") is True or item.get("status") == "done":
        return True
    # Tương thích progress cũ: nếu tất cả tab đã done thì xem là đã hoàn tất.
    return item.get("popup") == "done" and all(item.get(k) == "done" for k in ["xn", "cdha"])


def log_error(w_err, fh_err, ctx, tab, step, error, severity=None):
    """Ghi một dòng lỗi vào errors.csv.

    severity: ERR_WARN / ERR_ERROR / ERR_FATAL
    Mặc định: ERR_ERROR (để không phá các lời gọi cũ).
    """
    if severity is None:
        severity = ERR_ERROR
    msg = str(error)
    prefix = {"WARN": "⚠", "ERROR": "❌", "FATAL": "🔴"}.get(severity, "❌")
    print(f"      {prefix} [{tab}] {step}: {msg}")
    w_err.writerow({
        "Thời gian": now_iso(),
        "Mức độ": severity,
        "Mã NC": ctx.get("Mã NC", ""),
        "Mã BN": ctx.get("Mã BN", ""),
        "Họ tên": ctx.get("Họ tên", ""),
        "Tab": tab,
        "Bước": step,
        "Lỗi": msg[:2000],
    })
    fh_err.flush()


def log_warn(*args):
    """Ghi cảnh báo.

    Hàm này cố ý hỗ trợ 2 kiểu gọi vì file có 2 luồng log:
    - log_warn("nội dung") để ghi action_log khi thao tác Selenium.
    - log_warn(w_err, fh_err, ctx, tab, step, msg) để ghi vào errors.csv.

    Trước đây hàm log_warn CSV ghi đè hàm log_warn action_log ở đầu file,
    làm các lời gọi 1 tham số trong luồng phục hồi danh sách bị lỗi:
    log_warn() missing 5 required positional arguments...
    Khi lỗi này xảy ra, script không phục hồi được trang danh sách nội trú và
    bị kẹt ở cùng một Mã BN.
    """
    if len(args) == 1:
        try:
            _LOG.warn(str(args[0]))
        except Exception:
            print(f"WARN  {args[0]}")
        return
    if len(args) >= 6:
        w_err, fh_err, ctx, tab, step, msg = args[:6]
        log_error(w_err, fh_err, ctx, tab, step, msg, severity=ERR_WARN)
        return
    # Fallback an toàn để cảnh báo không bao giờ làm dừng worker.
    try:
        _LOG.warn(" ".join(str(x) for x in args))
    except Exception:
        print("WARN ", " ".join(str(x) for x in args))


def log_fatal(w_err, fh_err, ctx, tab, step, error):
    """Ghi lỗi nghiêm trọng đã dừng script."""
    log_error(w_err, fh_err, ctx, tab, step, error, severity=ERR_FATAL)

# ── Tìm BN & popup ───────────────────────────────────────────────────────────
def _bn_has_existing_data(run_dir, ma_bn):
    """Kiểm tra BN đã có ít nhất 1 dòng XN hoặc CĐHA trong run hiện tại.

    Dùng để phân biệt:
      - BN thực sự không có dữ liệu → ERROR
      - BN đã có dữ liệu nhưng EMR không tìm được (filter reset, đã xuất viện...) → WARN
    """
    ma_bn = (ma_bn or "").strip()
    if not ma_bn:
        return False
    for fname in ("lich_su_xn.csv", "lich_su_cdha.csv"):
        fpath = Path(run_dir) / fname
        if not fpath.exists():
            continue
        try:
            rows = read_csv_rows(fpath)
            if any((r.get("Mã BN") or "").strip() == ma_bn for r in rows):
                return True
        except Exception:
            pass
    return False


def _js_set_value_by_id(driver, element_id, value):
    """Set giá trị input bằng JS và phát event input/change.

    EMR thỉnh thoảng để lại modal/backdrop hoặc dùng control bị che, làm Selenium
    báo `element not interactable` khi clear()/send_keys(). Với ô tìm kiếm mã BN,
    thao tác JS ổn định hơn vì chỉ cần set value rồi bấm nút tìm kiếm.
    """
    return bool(driver.execute_script(
        """
        var el = document.getElementById(arguments[0]);
        if (!el) return false;
        try { el.scrollIntoView({block:'center', inline:'nearest'}); } catch(e) {}
        el.focus();
        el.value = arguments[1] || '';
        el.dispatchEvent(new Event('input', {bubbles:true}));
        el.dispatchEvent(new Event('change', {bubbles:true}));
        return true;
        """,
        element_id, value
    ))


def _safe_click(driver, el):
    """Click an toàn và nhanh. Trả True nếu đã phát lệnh click."""
    try:
        driver.execute_script(
            """
            var el = arguments[0];
            if (!el) return false;
            try { el.scrollIntoView({block:'center', inline:'nearest'}); } catch(e) {}
            try { el.focus && el.focus(); } catch(e) {}
            try {
              ['mouseover','mousedown','mouseup','click'].forEach(function(type){
                el.dispatchEvent(new MouseEvent(type, {view:window, bubbles:true, cancelable:true}));
              });
              return true;
            } catch(e1) {
              try { el.click(); return true; } catch(e2) { return false; }
            }
            """,
            el
        )
        wait_document_idle(driver, timeout=0.8 if FAST_UI else 1.5)
        return True
    except Exception:
        try:
            el.click()
            wait_document_idle(driver, timeout=0.8 if FAST_UI else 1.5)
            return True
        except Exception:
            return False


def _wait_history_popup_ready(driver, timeout=10):
    """Đợi popup/trang Lịch sử chung sẵn sàng sau khi bấm Xem KQ.

    Một số phiên EMR mở popup, một số phiên mở nội dung trong cùng tab. Chấp nhận
    nhiều dấu hiệu thay vì chỉ đợi riêng #litabLichSuXN để giảm lỗi giả
    "Không mở được popup Xem KQ/Lịch sử chung".
    """
    end = time.time() + timeout
    last_error = None
    selectors = [
        "#litabLichSuXN",
        "#litabLichSuCDHA",
        "#divLichSuXNContent",
        "#divLichSuCDHAContent",
        "a[href='#tabLichSuXN']",
        "a[href='#tabLichSuCDHA']",
        ".modal.show #litabLichSuXN",
        ".modal.in #litabLichSuXN",
    ]
    while time.time() < end:
        try:
            dismiss_sweet_alert(driver, timeout=0.3)
        except Exception:
            pass
        for css in selectors:
            try:
                els = driver.find_elements(By.CSS_SELECTOR, css)
                if any(el.is_displayed() for el in els):
                    return True
            except Exception as e:
                last_error = e
        time.sleep(0.25)
    if last_error:
        log_warn(f"Đợi popup lịch sử hết thời gian: {last_error}")
    return False


def tim_kiem_benh_nhan(driver, wait, ma_bn, from_dt=None, to_dt=None):
    touch_watchdog(f"tim_kiem_benh_nhan: {ma_bn}")
    log_step(f"Chuẩn bị tìm Mã BN {ma_bn}")
    dismiss_sweet_alert(driver, timeout=1)
    if not is_noi_tru_list_ready(driver):
        ensure_noi_tru_list(driver, wait, from_dt, to_dt)
        if not is_noi_tru_list_ready(driver):
            raise RuntimeError("Chưa ở danh sách nội trú nên không thể tìm Mã BN")
    # Kho nghiên cứu lấy từ danh sách Hoàn tất. Nếu UI vẫn là Đang thực hiện thì
    # tìm mã BN có thể ra dòng hiện tại và nút Xem KQ không mở đúng popup lịch sử.
    if not is_completed_status_active(driver):
        log_warn(f"Trạng thái trước khi tìm BN {ma_bn} đang là '{current_inpatient_status_text(driver)}' — chuyển lại Hoàn tất")
        choose_completed_status(driver)
        if from_dt or to_dt:
            restore_noi_tru_date_filter(driver, wait, from_dt, to_dt, click_search=True)
        if not is_completed_status_active(driver):
            raise RuntimeError(f"Không chuyển được trạng thái Hoàn tất trước khi tìm BN {ma_bn}; hiện tại: {current_inpatient_status_text(driver)}")
    log_find(f"txtTimKiem — tìm Mã BN: {ma_bn}")

    # Đợi control có trong DOM. Không dùng visibility + send_keys cứng vì EMR hay
    # còn overlay/modal ẩn sau khi đóng popup, gây element not interactable.
    wait.until(EC.presence_of_element_located((By.ID, "txtTimKiem")))
    ok_set = _js_set_value_by_id(driver, "txtTimKiem", ma_bn)
    if not ok_set:
        # Fallback kiểu Selenium nếu JS không tìm thấy input.
        txt = wait.until(EC.visibility_of_element_located((By.ID, "txtTimKiem")))
        try:
            txt.clear()
            txt.send_keys(ma_bn)
        except Exception:
            driver.execute_script("arguments[0].value=arguments[1];", txt, ma_bn)

    log_click("btnTimKiem — bấm Tìm kiếm")
    btn = wait.until(EC.presence_of_element_located((By.ID, "btnTimKiem")))
    _safe_click(driver, btn)
    wait_document_idle(driver, timeout=0.8 if FAST_UI else 1.5)
    msg = dismiss_sweet_alert(driver, timeout=0.5 if FAST_UI else 1)
    if msg and (from_dt or to_dt) and "datetime" in normalize_for_match(str(msg)):
        restore_noi_tru_date_filter(driver, wait, from_dt, to_dt, click_search=True)
    if not wait_noi_tru_list_ready(driver, timeout=4 if FAST_UI else 8):
        ensure_noi_tru_list(driver, wait, from_dt, to_dt)
    rows = get_patient_rows(driver, ma_bn)
    log_ok(f"Tìm thấy {len(rows)} lượt cho Mã BN {ma_bn}")
    return rows


def get_patient_rows(driver, ma_bn):
    literal = xpath_literal(ma_bn)
    rows = driver.find_elements(By.XPATH, f"//table[@id='tblNoiTru']//tr[.//td[normalize-space(.)={literal}]]")
    if not rows:
        rows = driver.find_elements(By.XPATH, f"//tr[.//td[normalize-space(.)={literal}]]")
    return rows


def dem_luot_benh_nhan(driver, wait, ma_bn, from_dt=None, to_dt=None):
    try:
        ensure_noi_tru_list(driver, wait, from_dt, to_dt)
        return len(tim_kiem_benh_nhan(driver, wait, ma_bn, from_dt, to_dt))
    except Exception as e:
        # Không để một lỗi UI tạm thời biến thành hàng loạt "không tìm thấy".
        # Ghi log ngắn, dọn popup/overlay rồi trả 0 để vòng ngoài quyết định bỏ qua.
        try:
            log_warn(f"Đếm lượt BN {ma_bn} lỗi: {e}")
            dong_popup(driver)
        except Exception:
            pass
        return 0


def visible_noi_tru_rows(driver):
    rows = driver.find_elements(By.XPATH, "//table[@id='tblNoiTru']//tbody/tr[not(contains(@style,'display: none'))]")
    if not rows:
        rows = driver.find_elements(By.XPATH, "//table[@id='tblNoiTru']//tr[td]")
    out = []
    for row in rows:
        try:
            if row.is_displayed() and row.find_elements(By.XPATH, ".//td"):
                out.append(row)
        except Exception:
            continue
    return out


def _row_cells(row):
    try:
        return [normalize_text(td.text) for td in row.find_elements(By.XPATH, ".//td")]
    except Exception:
        return []


def _table_headers(driver):
    headers = []
    selectors = [
        "//table[@id='tblNoiTru']//thead//th",
        "//table[@id='tblNoiTru']//tr[1]//th",
        "//table[@id='tblNoiTru']//tr[1]//td",
    ]
    for xp in selectors:
        headers = [normalize_text(el.text) for el in driver.find_elements(By.XPATH, xp)]
        headers = [h for h in headers if h]
        if headers:
            return headers
    return []


def _header_index(headers, names):
    normalized = [normalize_for_match(h) for h in headers]
    for idx, h in enumerate(normalized):
        if any(token in h for token in names):
            return idx
    return -1


def extract_patient_code_from_row(driver, row):
    cells = _row_cells(row)
    headers = _table_headers(driver)
    idx = _header_index(headers, ["ma bn", "ma benh nhan", "mabn", "ma nguoi benh", "ma nb"])
    if 0 <= idx < len(cells) and cells[idx]:
        return cells[idx]

    # Fallback: ưu tiên ô có dạng mã người bệnh, tránh chọn năm sinh/tuổi/ngày.
    for cell in cells:
        text = normalize_text(cell)
        if not text or re.search(r"\d{1,2}[-/]\d{1,2}[-/]\d{4}", text):
            continue
        if re.fullmatch(r"[A-Z]{0,4}\d{5,12}", text.replace(" ", ""), re.I):
            return text.replace(" ", "")
    return ""


def page_signature(driver):
    """Chữ ký trang hiện tại của tblNoiTru.

    Dùng JavaScript đọc trực tiếp DOM để tránh vòng lặp Selenium qua từng ô,
    vì hàm này được gọi nhiều lần khi chờ phân trang.
    """
    js = r"""
        const tbl = document.querySelector('#tblNoiTru');
        if (!tbl) return '';
        const visible = (tr) => {
          const st = window.getComputedStyle(tr);
          return st && st.display !== 'none' && st.visibility !== 'hidden';
        };
        const norm = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
        return Array.from(tbl.querySelectorAll('tbody tr'))
          .filter(tr => tr.cells && tr.cells.length && visible(tr))
          .slice(0, 10)
          .map(tr => Array.from(tr.cells).slice(0, 6).map(td => norm(td.innerText || td.textContent || '')).join('|'))
          .join('\n');
    """
    try:
        return driver.execute_script(js) or ""
    except Exception:
        try:
            rows = visible_noi_tru_rows(driver)
            bits = []
            for row in rows[:10]:
                bits.append("|".join(_row_cells(row)[:6]))
            return "\n".join(bits)
        except Exception:
            return ""


def click_next_noi_tru_page(driver, wait=None, from_dt=None, to_dt=None, timeout=8):
    msg = dismiss_sweet_alert(driver, timeout=1)
    if msg:
        restore_noi_tru_date_filter(driver, wait, from_dt, to_dt, click_search=True)
    old_sig = page_signature(driver)
    candidates = [
        (By.CSS_SELECTOR, "#tblNoiTru_next:not(.disabled) a"),
        (By.CSS_SELECTOR, ".dataTables_paginate .next:not(.disabled) a"),
        (By.CSS_SELECTOR, ".paginate_button.next:not(.disabled)"),
        (By.XPATH, "//a[not(contains(@class,'disabled')) and (normalize-space()='Tiếp' or normalize-space()='Sau' or normalize-space()='Next' or contains(normalize-space(),'›') or contains(normalize-space(),'»'))]"),
        (By.XPATH, "//*[self::button or self::a][not(@disabled) and not(contains(@class,'disabled')) and (contains(normalize-space(),'Tiếp') or contains(normalize-space(),'Next') or contains(normalize-space(),'›') or contains(normalize-space(),'»'))]"),
    ]
    for by, value in candidates:
        try:
            els = driver.find_elements(by, value)
            for el in els:
                try:
                    if not el.is_displayed() or not el.is_enabled():
                        continue
                except Exception:
                    continue
                driver.execute_script("arguments[0].scrollIntoView({block:'center'});", el)
                time.sleep(0.15)
                driver.execute_script("arguments[0].click();", el)
                try:
                    WebDriverWait(driver, timeout).until(lambda d: page_signature(d) != old_sig)
                except Exception:
                    msg = dismiss_sweet_alert(driver, timeout=1)
                    if msg:
                        restore_noi_tru_date_filter(driver, wait, from_dt, to_dt, click_search=True)
                    WebDriverWait(driver, max(3, timeout // 2)).until(lambda d: page_signature(d) != old_sig)
                time.sleep(0.5)
                return True
        except Exception:
            continue
    return False




def _cell_by_header(driver, row, header_tokens):
    cells = _row_cells(row)
    headers = _table_headers(driver)
    idx = _header_index(headers, header_tokens)
    if 0 <= idx < len(cells):
        return cells[idx]
    return ""


def _looks_like_sex(value):
    s = normalize_for_match(value)
    return s in {"nam", "nu", "nữ", "m", "f"} or s.startswith("nam ") or s.startswith("nu ")


def clean_initial_patient_name(value):
    """Làm sạch tên người bệnh trong bảng danh sách.

    Ô Họ tên của EMR có thể chứa thêm dòng vị trí như:
    "- PM: PHÒNG PHẪU THUẬT". Dòng này không phải họ tên nên cần bỏ
    trước khi ghi du_lieu_ban_dau.csv.
    """
    lines = []
    for part in re.split(r"[\r\n]+", str(value or "")):
        text = normalize_text(part)
        if text:
            lines.append(text)
    if not lines:
        return ""
    skip_tokens = {
        "buong giuong", "keo don thuoc", "tra thuoc", "chi dinh dvkt",
        "dich vu khac", "them thuoc", "vtyt", "tong ket ra khoa",
        "xem chi phi", "xem kq", "hoan tat",
    }
    cleaned = []
    for line in lines:
        norm = normalize_for_match(line)
        if re.match(r"^[-–—]?\s*pm\s*:", norm):
            continue
        if re.match(r"^[-–—]?\s*phong\s*mo\s*:", norm):
            continue
        if any(tok in norm for tok in skip_tokens):
            continue
        cleaned.append(line)
    return cleaned[0] if cleaned else ""


def read_initial_list_rows_fast(driver):
    """Đọc toàn bộ dòng đang hiển thị trong tblNoiTru bằng JavaScript một lần.

    Nhanh hơn nhiều so với Selenium đọc từng <td>. Bảng EMR theo HTML mẫu có
    các cột: T/G vào, ĐD, KQ, B-G, Mã BN, Họ tên, Tuổi, GT. Nếu header đổi vị
    trí, script vẫn ưu tiên dò theo tên cột rồi mới fallback về index cố định.
    """
    js = r"""
        const tbl = document.querySelector('#tblNoiTru');
        if (!tbl) return [];
        const norm = (s) => (s || '').replace(/\u00a0/g, ' ').replace(/\s+/g, ' ').trim();
        const fold = (s) => norm(s).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/đ/g, 'd').replace(/Đ/g, 'D').toLowerCase();
        const headers = Array.from(tbl.querySelectorAll('thead th')).map(th => fold(th.innerText || th.textContent || ''));
        const findIdx = (tokens, fallback) => {
          for (let i = 0; i < headers.length; i++) {
            if (tokens.some(t => headers[i].includes(t))) return i;
          }
          return fallback;
        };
        const idx = {
          tgVao: findIdx(['t/g vao', 'tg vao', 'thoi gian vao', 'ngay vao', 'vao vien'], 1),
          maBn: findIdx(['ma bn', 'ma benh nhan', 'ma nguoi benh', 'ma nb'], 5),
          hoTen: findIdx(['ho ten', 'ten bn', 'ten nguoi benh', 'benh nhan', 'nguoi benh'], 6),
          tuoi: findIdx(['tuoi', 'age'], 7),
          gt: findIdx(['gt', 'gioi', 'gioi tinh', 'phai', 'sex'], 8),
          trangThai: findIdx(['trang thai', 'status'], 13),
          khoaChuyenDen: findIdx(['khoa chuyen den', 'khoa dieu tri', 'department'], 16),
          xuTri: findIdx(['xu tri', 'huong xu tri'], 17),
        };
        const visible = (tr) => {
          const st = window.getComputedStyle(tr);
          return st && st.display !== 'none' && st.visibility !== 'hidden';
        };
        const cellText = (td) => norm(td ? (td.innerText || td.textContent || '') : '');
        const cleanNameCell = (td) => {
          if (!td) return '';
          const named = td.querySelector("a[id^='btna']");
          if (named) {
            const clone = named.cloneNode(true);
            clone.querySelectorAll('i, small, .text-muted').forEach(el => el.remove());
            const first = norm((clone.innerText || clone.textContent || '').split(/\n+/)[0] || '');
            if (first) return first;
          }
          const lines = (td.innerText || td.textContent || '').split(/\n+/).map(norm).filter(Boolean);
          const ignore = /^(?:[-–—]?\s*pm\s*:|buồng giường|buong giuong|kéo đơn thuốc|keo don thuoc|trả thuốc|tra thuoc|chỉ định|chi dinh|dịch vụ|dich vu|thêm thuốc|them thuoc|tổng kết|tong ket|xem chi phí|xem chi phi)/i;
          for (const line of lines) {
            if (!ignore.test(line)) return line;
          }
          return '';
        };
        return Array.from(tbl.querySelectorAll('tbody tr'))
          .filter(tr => tr.cells && tr.cells.length && visible(tr))
          .map(tr => {
            const cells = Array.from(tr.cells);
            let hoTen = cleanNameCell(cells[idx.hoTen]);
            const doctorLink = tr.querySelector("a[id^='btna'],a[href*='wpid=bacsidraw']");
            const nursingLink = tr.querySelector("a[href*='wpid=dieuduongdraw']");
            const doctorUrl = doctorLink ? (doctorLink.href || doctorLink.getAttribute('href') || '') : '';
            const nursingUrl = nursingLink ? (nursingLink.href || nursingLink.getAttribute('href') || '') : '';
            let noitruId = '';
            for (const rawUrl of [doctorUrl, nursingUrl]) {
              if (!rawUrl) continue;
              try {
                const parsed = new URL(rawUrl, window.location.href);
                noitruId = parsed.searchParams.get('noitruid') || parsed.searchParams.get('dieutriid') || noitruId;
              } catch (_) {}
            }
            return {
              'T/G vào': cellText(cells[idx.tgVao]),
              'Mã BN': cellText(cells[idx.maBn]).replace(/\s+/g, ''),
              'Mã nội trú': noitruId,
              'URL bác sĩ': doctorUrl,
              'URL điều dưỡng': nursingUrl,
              'Họ tên': hoTen,
              'Tuổi': cellText(cells[idx.tuoi]),
              'GT': cellText(cells[idx.gt]),
              'Trạng thái': cellText(cells[idx.trangThai]),
              'Khoa chuyển đến': cellText(cells[idx.khoaChuyenDen]),
              'Xử trí': cellText(cells[idx.xuTri]),
            };
          });
    """
    try:
        rows = driver.execute_script(js) or []
    except Exception:
        return []
    out = []
    for row in rows:
        if not isinstance(row, dict):
            continue
        item = {
            "T/G vào": normalize_text(row.get("T/G vào", "")),
            "Mã BN": normalize_text(row.get("Mã BN", "")).replace(" ", ""),
            "Mã nội trú": normalize_text(row.get("Mã nội trú", "")),
            "URL bác sĩ": normalize_text(row.get("URL bác sĩ", "")),
            "URL điều dưỡng": normalize_text(row.get("URL điều dưỡng", "")),
            "Họ tên": clean_initial_patient_name(row.get("Họ tên", "")),
            "Tuổi": normalize_text(row.get("Tuổi", "")),
            "GT": normalize_text(row.get("GT", "")),
            "Trạng thái": normalize_text(row.get("Trạng thái", "")),
            "Khoa chuyển đến": normalize_text(row.get("Khoa chuyển đến", "")),
            "Xử trí": normalize_text(row.get("Xử trí", "")),
        }
        if any(item.values()):
            out.append(item)
    return out


def extract_initial_list_info_from_row(driver, row):
    """Đọc nhanh một dòng trong tblNoiTru, không mở con mắt Điều dưỡng.

    Mục tiêu của bảng du_lieu_ban_dau.csv là tạo danh sách thô thật nhanh và ít lỗi:
    T/G vào, Mã BN, Họ tên, Tuổi, GT. Các thông tin sâu sẽ lấy sau bằng bước
    tìm từng Mã BN trong nghiên cứu riêng.
    """
    cells = _row_cells(row)
    ma_bn = extract_patient_code_from_row(driver, row)
    tg_vao = _cell_by_header(driver, row, [
        "t/g vao", "tg vao", "thoi gian vao", "thoi gian nhap", "ngay vao", "vao vien", "nhap vien"
    ])
    ho_ten = _cell_by_header(driver, row, ["ho ten", "ten bn", "ten nguoi benh", "benh nhan", "nguoi benh"])
    tuoi = _cell_by_header(driver, row, ["tuoi", "age"])
    gt = _cell_by_header(driver, row, ["gt", "gioi", "gioi tinh", "phai", "sex"])
    trang_thai = _cell_by_header(driver, row, ["trang thai", "status"])
    khoa_chuyen_den = _cell_by_header(driver, row, ["khoa chuyen den", "khoa dieu tri", "department"])
    xu_tri = _cell_by_header(driver, row, ["xu tri", "huong xu tri"])
    doctor_url = ""
    nursing_url = ""
    noitru_id = ""
    try:
        for link in row.find_elements(By.XPATH, ".//a[@href]"):
            href = normalize_text(link.get_attribute("href") or "")
            href_norm = href.lower()
            if "wpid=bacsidraw" in href_norm and not doctor_url:
                doctor_url = href
            if "wpid=dieuduongdraw" in href_norm and not nursing_url:
                nursing_url = href
            if href and not noitru_id:
                try:
                    query = dict(parse_qsl(urlsplit(href).query, keep_blank_values=True))
                    noitru_id = normalize_text(query.get("noitruid") or query.get("dieutriid") or "")
                except Exception:
                    pass
    except Exception:
        pass

    # Fallback khi header DataTable không đọc được.
    if not tg_vao:
        for cell in cells:
            if parse_vn_datetime(cell):
                tg_vao = cell
                break
    if not tuoi:
        for cell in cells:
            t = normalize_text(cell)
            if re.fullmatch(r"\d{1,3}", t):
                tuoi = t
                break
            m = re.fullmatch(r"(\d{1,3})\s*tu[oổ]i", normalize_for_match(t))
            if m:
                tuoi = m.group(1)
                break
    if not gt:
        for cell in cells:
            if _looks_like_sex(cell):
                gt = normalize_text(cell)
                break
    if not ho_ten:
        code_idx = -1
        for idx, cell in enumerate(cells):
            if ma_bn and normalize_text(cell).replace(" ", "") == ma_bn:
                code_idx = idx
                break
        candidates = []
        if code_idx >= 0:
            candidates.extend(cells[code_idx + 1:code_idx + 4])
        candidates.extend(cells)
        for cell in candidates:
            t = normalize_text(cell)
            if not t or t == ma_bn or t == tuoi or t == gt or parse_vn_datetime(t):
                continue
            if re.search(r"[A-Za-zÀ-ỹ]", t) and not re.search(r"(xem|sua|xoa|chi tiet|lich su)", normalize_for_match(t)):
                ho_ten = t
                break

    tg_vao = normalize_text(tg_vao)
    return {
        "T/G vào": tg_vao,
        "Ngày vào viện": tg_vao,
        "Mã BN": normalize_text(ma_bn),
        "Mã nội trú": noitru_id,
        "Mã điều trị": noitru_id,
        "URL bác sĩ": doctor_url,
        "URL điều dưỡng": nursing_url,
        "Họ tên": clean_initial_patient_name(ho_ten),
        "Tuổi": normalize_text(tuoi),
        "GT": normalize_text(gt),
        "Trạng thái": normalize_text(trang_thai),
        "Khoa chuyển đến": normalize_text(khoa_chuyen_den),
        "Xử trí": normalize_text(xu_tri),
    }


def initial_list_key(row):
    ma_bn = normalize_text(row.get("Mã BN", ""))
    noitru_id = normalize_text(row.get("Mã nội trú", "") or row.get("Mã điều trị", "") or row.get("noitruid", ""))
    if noitru_id:
        return f"{ma_bn}|treatment:{noitru_id.lower()}"
    tg_vao = canonical_visit_time(row.get("T/G vào", ""))
    ho_ten = normalize_for_match(row.get("Họ tên", ""))
    # Fallback khi EMR chưa trả khóa lượt: Mã BN + T/G vào.
    return f"{ma_bn}|{tg_vao or ho_ten}"


def upsert_initial_rows(existing_rows, row):
    key = initial_list_key(row)
    if not normalize_text(row.get("Mã BN", "")):
        return False
    for idx, old in enumerate(existing_rows):
        if initial_list_key(old) == key:
            merged = dict(old)
            merge_non_empty(merged, row)
            existing_rows[idx] = {col: merged.get(col, "") for col in COL_INITIAL_LIST}
            return False
    existing_rows.append({col: row.get(col, "") for col in COL_INITIAL_LIST})
    return True


def initial_context_key(ctx):
    """Khóa của một dòng dữ liệu ban đầu/cohort: Mã BN + T/G vào.

    Khóa này khác với visit_key vì ở dữ liệu ban đầu chưa biết ngày ra viện.
    """
    return initial_list_key({
        "Mã BN": ctx.get("Mã BN", ""),
        "Mã nội trú": ctx.get("Mã nội trú", "") or ctx.get("Mã điều trị", ""),
        "T/G vào": ctx.get("T/G vào", "") or ctx.get("Ngày vào viện", ""),
        "Họ tên": ctx.get("Họ tên", ""),
    })


def initial_row_datetime(row):
    return parse_vn_datetime(row.get("T/G vào", "") or row.get("Ngày vào viện", ""))


def visit_interval_datetimes(ctx):
    start = parse_vn_datetime(ctx.get("Ngày vào viện", "") or ctx.get("T/G vào", ""))
    end = parse_vn_datetime(ctx.get("Ngày ra viện", ""))
    return start, end


def initial_row_covered_by_visit(row, ctx):
    """Dòng ban đầu thuộc cùng lượt điều trị đã lấy sâu hay không.

    Khi tìm một Mã BN, EMR có thể trả nhiều dòng do chuyển khoa. Sau khi mở đúng
    một dòng và biết được Ngày vào viện/Ngày ra viện thật, các dòng ban đầu có
    T/G vào nằm trong khoảng này là cùng một lượt điều trị và không cần tìm lại.
    """
    ma_bn = normalize_text(ctx.get("Mã BN", ""))
    if not ma_bn or normalize_text(row.get("Mã BN", "")) != ma_bn:
        return False
    row_noitru = normalize_text(row.get("Mã nội trú", "") or row.get("Mã điều trị", ""))
    ctx_noitru = normalize_text(ctx.get("Mã nội trú", "") or ctx.get("Mã điều trị", ""))
    if row_noitru and ctx_noitru:
        return row_noitru.lower() == ctx_noitru.lower()
    row_dt = initial_row_datetime(row)
    start, end = visit_interval_datetimes(ctx)
    if not row_dt or not start:
        return False
    if end:
        return start <= row_dt <= end
    # Nếu EMR chưa có ngày ra viện, chỉ gộp dòng khớp đúng thời điểm vào viện để tránh xóa nhầm.
    return canonical_visit_time(row.get("T/G vào", "")) == canonical_visit_time(ctx.get("Ngày vào viện", ""))


def initial_rows_covered_by_visit(rows, ctx):
    return [row for row in (rows or []) if initial_row_covered_by_visit(row, ctx)]


def prune_initial_rows_file(path, ctx):
    path = Path(path)
    if not path.exists() or path.stat().st_size == 0:
        return []
    rows = read_csv_rows(path)
    if not rows:
        return []
    covered = initial_rows_covered_by_visit(rows, ctx)
    if not covered:
        return []
    covered_keys = {initial_list_key(row) for row in covered}
    kept = [row for row in rows if initial_list_key(row) not in covered_keys]
    cols = list(rows[0].keys()) if rows else COL_INITIAL_LIST
    for col in COL_INITIAL_LIST:
        if col not in cols:
            cols.append(col)
    write_csv_rows(path, cols, kept)
    return covered


def append_pruned_initial_audit(run_dir, rows, ctx, source_path):
    rows = list(rows or [])
    if not rows:
        return
    audit_path = Path(run_dir) / "du_lieu_ban_dau_da_gop.csv"
    cols = COL_INITIAL_LIST + [
        "Mã NC gộp vào", "Ngày vào viện gộp", "Ngày ra viện gộp",
        "Nguồn đã xóa", "Thời điểm gộp", "Lý do",
    ]
    ensure_csv(audit_path, cols)
    out = []
    for row in rows:
        next_row = {col: row.get(col, "") for col in COL_INITIAL_LIST}
        next_row.update({
            "Mã NC gộp vào": ctx.get("Mã NC", ""),
            "Ngày vào viện gộp": ctx.get("Ngày vào viện", ""),
            "Ngày ra viện gộp": ctx.get("Ngày ra viện", ""),
            "Nguồn đã xóa": str(source_path),
            "Thời điểm gộp": now_iso(),
            "Lý do": "T/G vào nằm trong khoảng Ngày vào viện - Ngày ra viện của lượt đã lấy sâu",
        })
        out.append(next_row)
    append_csv_rows(audit_path, cols, out)


def prune_redundant_initial_sources(run_dir, ctx, source_paths):
    """Xóa/gộp các dòng đầu vào đã được cùng một lượt điều trị bao phủ.

    Trả về (số dòng xóa trên các file, tập khóa Mã BN+T/G vào để vòng chạy hiện tại bỏ qua ngay).
    """
    unique_paths = []
    seen_paths = set()
    for path in source_paths or []:
        if not path:
            continue
        p = Path(path)
        try:
            key = str(p.resolve())
        except Exception:
            key = str(p)
        if key in seen_paths:
            continue
        seen_paths.add(key)
        unique_paths.append(p)

    removed_total = 0
    covered_keys = set()
    for path in unique_paths:
        try:
            removed = prune_initial_rows_file(path, ctx)
        except Exception as exc:
            print(f"      ⚠ Không cập nhật được {path}: {exc}")
            continue
        if not removed:
            continue
        removed_total += len(removed)
        for row in removed:
            k = initial_list_key(row)
            if k:
                covered_keys.add(k)
        append_pruned_initial_audit(run_dir, removed, ctx, path)
    return removed_total, covered_keys


def scan_initial_list_pages(
    driver, wait, run_dir, progress, w_err, fh_err,
    from_dt=None, to_dt=None, max_pages=10000, stop_at_existing=True,
):
    """Quét bảng danh sách Hoàn tất để tạo du_lieu_ban_dau.csv.

    Không click con mắt Điều dưỡng ở bước này để tránh lỗi DateTime/Back của EMR.
    Lần sau quét lại từ trang 1 vẫn không trùng vì upsert theo Mã BN + T/G vào.
    """
    initial_path = Path(run_dir) / "du_lieu_ban_dau.csv"
    ensure_csv(initial_path, COL_INITIAL_LIST)
    rows_out = read_csv_rows(initial_path)
    existing_keys_at_start = {initial_list_key(row) for row in rows_out if initial_list_key(row)}
    # Luôn quét hết các trang trong khoảng ngày rồi upsert theo Mã BN + T/G vào.
    # Không được dừng ở dòng đã có: danh sách EMR sắp theo T/G vào, trong khi một ca
    # mới chuyển sang Hoàn tất có thể có T/G vào cũ và nằm sau nhiều dòng đã lưu.
    # Dừng sớm ở dòng cũ vì vậy có thể làm thiếu ca dù lần quét trước đã hoàn chỉnh.
    previous_meta = progress.get("__initial_scan") if isinstance(progress, dict) else {}
    previous_scan_finished = bool(isinstance(previous_meta, dict) and previous_meta.get("finished_at"))
    incremental_stop_enabled = False
    total_seen = 0
    saved = 0
    updated_or_skipped = 0
    errors = 0
    seen_pages = set()
    stopped_at_existing = False
    meta = progress.setdefault("__initial_scan", {})
    # Đánh dấu run hiện tại đang chạy; finished_at chỉ được ghi lại khi vòng quét
    # kết thúc bình thường. Nhờ vậy lần chạy sau biết phải quét tiếp toàn khoảng.
    meta.pop("finished_at", None)
    meta["mode"] = "table_only"
    meta["stop_at_existing"] = incremental_stop_enabled
    meta["resuming_interrupted_scan"] = bool(existing_keys_at_start and not previous_scan_finished)
    meta["updated_at"] = now_iso()
    save_progress(run_dir, progress)
    if existing_keys_at_start:
        reason = "lần trước bị gián đoạn" if not previous_scan_finished else "đã có dữ liệu cũ"
        print(
            f"    Quét đầy đủ toàn khoảng ({reason}): đọc hết các trang và tự loại trùng "
            "theo Mã BN + T/G vào; không dừng ở dòng đã lưu.",
            flush=True,
        )

    for page_no in range(1, max_pages + 1):
        touch_watchdog(f"Quét danh sách: chuẩn bị trang {page_no}")
        dismiss_sweet_alert(driver, timeout=1)
        sig = page_signature(driver)
        if sig and sig in seen_pages:
            print(f"    Trang {page_no} lặp lại chữ ký cũ, thử chuyển sang trang tiếp...")
            if click_next_noi_tru_page(driver, wait, from_dt, to_dt):
                continue
            print("    Hết trang hoặc không sang trang tiếp được.")
            break
        if sig:
            seen_pages.add(sig)

        fast_rows = read_initial_list_rows_fast(driver)
        row_objects = []
        if fast_rows:
            rows = fast_rows
        else:
            row_objects = visible_noi_tru_rows(driver)
            rows = row_objects
        touch_watchdog(f"Quét danh sách: trang {page_no} có {len(rows)} dòng")
        print(f"    Trang {page_no}: {len(rows)} dòng", flush=True)
        if not rows:
            break

        for idx, row in enumerate(rows, start=1):
            total_seen += 1
            # Các dòng console thường không đi qua ActionLogger. Nếu không chạm
            # heartbeat tại đây, một trang đang đọc bình thường hơn 180 giây vẫn
            # bị watchdog hiểu nhầm là treo và kết thúc process.
            touch_watchdog(f"Quét danh sách: trang {page_no}, dòng {idx}/{len(rows)}")
            try:
                if isinstance(row, dict):
                    info = {col: normalize_text(row.get(col, "")) for col in COL_INITIAL_LIST}
                    info["Họ tên"] = clean_initial_patient_name(info.get("Họ tên", ""))
                else:
                    info = extract_initial_list_info_from_row(driver, row)
                if not info.get("Mã BN"):
                    errors += 1
                    log_error(w_err, fh_err, info, "Danh sách", f"trang {page_no} dòng {idx}", "Không đọc được Mã BN")
                    continue

                key = initial_list_key(info)
                was_saved_before_this_run = bool(key and key in existing_keys_at_start)
                is_new = upsert_initial_rows(rows_out, info)
                saved += 1 if is_new else 0
                updated_or_skipped += 0 if is_new else 1
                print(
                    f"      {info.get('T/G vào','')} | {info.get('Mã BN','')} | "
                    f"{info.get('Họ tên','')} | {info.get('Tuổi','')} | {info.get('GT','')}",
                    flush=True,
                )

                if incremental_stop_enabled and was_saved_before_this_run:
                    stopped_at_existing = True
                    print(
                        "      [STOP] Gặp dòng đã lưu trước đó → dừng quét tiếp: "
                        f"{info.get('T/G vào','')} | {info.get('Mã BN','')} | {info.get('Họ tên','')}"
                    )
                    break
            except Exception as e:
                errors += 1
                log_error(w_err, fh_err, {}, "Danh sách", f"trang {page_no} dòng {idx}", e)

        # Ghi sau mỗi trang để tắt máy giữa chừng vẫn giữ được dữ liệu trang đã đọc.
        touch_watchdog(f"Quét danh sách: đang lưu xong trang {page_no}")
        write_csv_rows(initial_path, COL_INITIAL_LIST, rows_out)
        meta.update({"last_page": page_no, "rows_total": len(rows_out), "updated_at": now_iso()})
        if stopped_at_existing:
            meta.update({"stopped_at_existing": True, "stopped_page": page_no, "updated_at": now_iso()})
        save_progress(run_dir, progress)

        if stopped_at_existing:
            break

        touch_watchdog(f"Quét danh sách: chuyển sau trang {page_no}")
        if not click_next_noi_tru_page(driver, wait, from_dt, to_dt):
            break
        touch_watchdog(f"Quét danh sách: đã sang trang {page_no + 1}")

    write_csv_rows(initial_path, COL_INITIAL_LIST, rows_out)
    meta.update({"finished_at": now_iso(), "rows_total": len(rows_out), "updated_at": now_iso()})
    save_progress(run_dir, progress)
    return {"seen": total_seen, "saved": saved, "updated_or_skipped": updated_or_skipped, "errors": errors, "total_rows": len(rows_out)}

def _scan_current_patient_master_pages(driver, wait, run_dir, progress, w_err, fh_err, from_dt=None, to_dt=None, max_pages=10000, day_key_value=""):
    """Quét các trang đang hiển thị sau khi EMR đã được lọc đúng một ngày/khoảng.

    Không lưu/resume theo trang. Dữ liệu được chống trùng bằng visit_key:
    Mã BN + Ngày vào viện + Ngày ra viện.
    """
    master_path = Path(run_dir) / "mau_nghien_cuu.csv"
    ensure_csv(master_path, COL_PATIENTS)
    existing_master = read_csv_rows(master_path)
    encounter_code_map, assigned_codes = build_visit_code_map(existing_master)
    allocator = ResearchCodeAllocator(existing_master)

    total_seen = 0
    added_or_updated = 0
    skipped = 0
    seen_pages = set()

    for page_no in range(1, max_pages + 1):
        dismiss_sweet_alert(driver, timeout=1)
        sig = page_signature(driver)
        if sig and sig in seen_pages:
            # Trong cùng một ngày, chữ ký lặp nghĩa là chưa sang được trang mới.
            # Thử bấm tiếp một lần nữa; nếu vẫn không đi được thì kết thúc ngày.
            print(f"      Trang {page_no} lặp lại chữ ký cũ, thử chuyển sang trang tiếp...")
            if click_next_noi_tru_page(driver, wait, from_dt, to_dt):
                continue
            print(f"      Hết trang hoặc không sang trang tiếp được.")
            break
        if sig:
            seen_pages.add(sig)

        rows_count = len(visible_noi_tru_rows(driver))
        print(f"      Trang {page_no}: {rows_count} dòng")
        if rows_count <= 0:
            break

        row_index = 0
        while row_index < rows_count:
            # Sau khi mở/đóng popup, DOM có thể stale; lấy lại row theo chỉ số.
            rows = visible_noi_tru_rows(driver)
            rows_count = len(rows)
            if row_index >= rows_count:
                break
            row = rows[row_index]
            ma_bn = extract_patient_code_from_row(driver, row)
            ctx = patient_context({"Mã BN": ma_bn}, total_seen)
            total_seen += 1
            progress_key = f"day:{day_key_value or 'range'}|page:{page_no}|row:{row_index + 1}"
            try:
                dismiss_sweet_alert(driver, timeout=1)
                info = mo_dieu_duong_va_doc_thong_tin(driver, wait, row, from_dt, to_dt)
                merge_non_empty(ctx, info)
                if not ctx.get("Mã BN"):
                    ctx["Mã BN"] = ma_bn
                if not ctx.get("Mã BN"):
                    log_error(w_err, fh_err, ctx, "Danh sách", "đọc Mã BN", "Không xác định được Mã BN trên dòng danh sách")
                    skipped += 1
                    row_index += 1
                    continue

                visit, research_code, seen_before = assign_research_code_for_visit(
                    ctx, ctx, allocator, encounter_code_map, assigned_codes,
                    fallback=f"day:{day_key_value or 'range'}|page:{page_no}|row:{row_index + 1}",
                )

                # Nếu đã có cùng Mã BN + Ngày vào viện + Ngày ra viện thì không mở sâu lại.
                # Vẫn cho upsert để cập nhật thông tin hành chính nếu EMR bổ sung sau.
                if is_patient_done(progress, visit):
                    upsert_patient_master(run_dir, ctx)
                    skipped += 1
                    row_index += 1
                    continue

                upsert_patient_master(run_dir, ctx)
                item = ensure_patient_progress(progress, visit)
                item.update({
                    "Mã NC": ctx.get("Mã NC", ""),
                    "Mã BN": ctx.get("Mã BN", ""),
                    "Ngày vào viện": ctx.get("Ngày vào viện", ""),
                    "Ngày ra viện": ctx.get("Ngày ra viện", ""),
                    "popup": "done",
                    "xn": "skipped",
                    "cdha": "skipped",
                    "committed": True,
                    "status": "done",
                    "scan_mode": "patient_master_only",
                    "scan_day": day_key_value or "",
                    "page": page_no,
                    "row": row_index + 1,
                    "updated_at": now_iso(),
                    "last_error": "",
                })
                save_progress(run_dir, progress)
                added_or_updated += 1
                print(f"        {ctx.get('Mã NC','')} | {ctx.get('Mã BN','')} | {ctx.get('Ngày vào viện','')} → {ctx.get('Ngày ra viện','')}")
            except KeyboardInterrupt:
                save_progress(run_dir, progress)
                raise
            except Exception as e:
                mark_progress(progress, progress_key, "popup", "error", str(e))
                log_error(w_err, fh_err, ctx, "Danh sách", "đọc Điều dưỡng", e)
                save_progress(run_dir, progress)
                skipped += 1
                try:
                    # Sau lỗi, phục hồi đúng ngày đang quét để không bị kẹt DateTimePicker.
                    restore_noi_tru_date_filter(driver, wait, from_dt, to_dt, click_search=True)
                except Exception:
                    pass
            finally:
                try:
                    dong_popup(driver)
                except Exception:
                    pass
            row_index += 1

        if not click_next_noi_tru_page(driver, wait, from_dt, to_dt):
            break

    return {"seen": total_seen, "saved": added_or_updated, "skipped": skipped}


def scan_patient_master_days(driver, wait, run_dir, progress, w_err, fh_err, from_dt=None, to_dt=None, rescan_recent_days=7):
    """Quét dữ liệu gốc theo từng ngày thay vì resume theo trang.

    Lý do: danh sách Hoàn tất thay đổi hằng ngày; người mới xuất viện nằm đầu danh
    sách và đẩy lượt cũ sang trang sau. Vì vậy lần sau luôn bắt đầu lại từ trang 1
    của từng ngày, còn việc trùng/lượt đã có được xử lý bằng khóa lượt điều trị.
    """
    meta = progress.setdefault("__archive_scan", {})
    completed_days = set(meta.get("completed_days") or [])
    days = list(iter_days(from_dt, to_dt))
    total = {"seen": 0, "saved": 0, "skipped": 0, "days_done": 0, "days_skipped": 0}
    if not days:
        return total

    print(
        f"    Quét dữ liệu gốc theo từng ngày: {date_key(days[0])} → {date_key(days[-1])}; "
        f"quét chồng {int(rescan_recent_days or 0)} ngày cuối"
    )

    for day in days:
        dk = date_key(day)
        force_rescan = should_rescan_day(day, to_dt or days[-1], rescan_recent_days)
        if dk in completed_days and not force_rescan:
            print(f"    Ngày {day.strftime('%d/%m/%Y')}: đã hoàn tất trước đó, bỏ qua")
            total["days_skipped"] += 1
            continue

        meta["active_day"] = dk
        meta["active_day_started_at"] = meta.get("active_day_started_at") or now_iso()
        meta["updated_at"] = now_iso()
        save_progress(run_dir, progress)

        if dk in completed_days and force_rescan:
            print(f"    Ngày {day.strftime('%d/%m/%Y')}: quét chồng để bắt hồ sơ cập nhật muộn")

        if not set_noi_tru_day_filter_and_search(driver, wait, day):
            log_error(w_err, fh_err, {"Mã NC": "", "Mã BN": ""}, "Danh sách", f"lọc ngày {dk}", "Không đặt/tìm kiếm được bộ lọc ngày")
            total["skipped"] += 1
            save_progress(run_dir, progress)
            continue

        result = _scan_current_patient_master_pages(
            driver, wait, run_dir, progress, w_err, fh_err,
            from_dt=day, to_dt=day, day_key_value=dk,
        )
        total["seen"] += result.get("seen", 0)
        total["saved"] += result.get("saved", 0)
        total["skipped"] += result.get("skipped", 0)

        completed_days.add(dk)
        meta["completed_days"] = sorted(completed_days)
        meta["active_day"] = ""
        meta["active_day_started_at"] = ""
        meta["last_completed_day"] = dk
        meta["updated_at"] = now_iso()
        save_progress(run_dir, progress)
        total["days_done"] += 1
        print(
            f"    Xong ngày {day.strftime('%d/%m/%Y')}: "
            f"đọc {result.get('seen', 0)} | lưu mới/cập nhật {result.get('saved', 0)} | bỏ qua/lỗi {result.get('skipped', 0)}"
        )

    return total


# Tên cũ giữ lại để tránh đứt các chỗ gọi cũ.
def scan_patient_master_pages(driver, wait, run_dir, progress, w_err, fh_err, from_dt=None, to_dt=None, max_pages=10000):
    return scan_patient_master_days(driver, wait, run_dir, progress, w_err, fh_err, from_dt, to_dt)


def label_text(driver, element_id):
    try:
        return normalize_text(driver.execute_script("""
            var e = document.getElementById(arguments[0]);
            if (!e) return '';
            return (e.textContent || e.value || e.getAttribute('title') || '').trim();
        """, element_id))
    except Exception:
        return ""


def first_label_text(driver, element_ids):
    for element_id in element_ids:
        value = label_text(driver, element_id)
        if value:
            return value
    return ""


def doc_thong_tin_dieu_duong(driver):
    info = {
        "Họ tên": first_label_text(driver, ["lblHoTen", "lblTenBenhNhan", "lblTenBN"]),
        "Giới": first_label_text(driver, ["lblGioiTinh", "lblGioi", "lblGT", "lblPhai", "lblGioiTinhBN"]),
        "Ngày sinh": first_label_text(driver, ["lblNgaySinh", "lblNamSinh", "lblDOB"]),
        "Tuổi": first_label_text(driver, ["lblTuoi"]),
        "Địa chỉ": first_label_text(driver, ["lblDiaChi"]),
        "Đối tượng": first_label_text(driver, ["lblDoiTuong"]),
        "Số thẻ": first_label_text(driver, ["lblSoThe", "lblSoTheBHYT"]),
        "Loại": first_label_text(driver, ["lblLoai", "lblLoaiBHYT"]),
        "Giá trị từ": first_label_text(driver, ["lblTuNgay"]),
        "Giá trị đến": first_label_text(driver, ["lblDenNgay"]),
        "Ngày vào viện": first_label_text(driver, ["lblNgayVaoVien", "lblNgayNhapVien"]),
        "Ngày ra viện": first_label_text(driver, ["lblNgayRaVien", "lblNgayXuatVien"]),
        "Thời gian điều trị": first_label_text(driver, ["lblSoNgayDieuTri"]),
        "Chẩn đoán vào viện": first_label_text(driver, ["lblChanDoanVaoVien"]),
    }
    return {k: v for k, v in info.items() if normalize_text(v)}


def wait_thong_tin_dieu_duong(driver, timeout=8):
    try:
        WebDriverWait(driver, timeout).until(
            lambda d: bool(label_text(d, "lblHoTen") or label_text(d, "lblNgayVaoVien"))
        )
        return True
    except Exception:
        return False


def button_haystack(el):
    parts = []
    for attr in ["title", "data-original-title", "aria-label", "onclick", "href", "class", "id"]:
        try:
            parts.append(el.get_attribute(attr) or "")
        except Exception:
            pass
    try:
        parts.append(el.text or "")
        parts.append(el.get_attribute("outerHTML") or "")
    except Exception:
        pass
    return normalize_for_match(" ".join(parts))


def find_nursing_button(row):
    candidates = row.find_elements(By.XPATH, ".//a|.//button")
    for el in candidates:
        hay = button_haystack(el)
        if any(token in hay for token in ["dieu duong", "dieuduong", "dieu_duong", "nurse"]):
            return el
    eye_candidates = []
    for el in candidates:
        hay = button_haystack(el)
        if "fa-eye" in hay or "glyphicon-eye" in hay or "icon-eye" in hay:
            eye_candidates.append(el)
    if len(eye_candidates) == 1:
        return eye_candidates[0]
    return None


def mo_dieu_duong_va_doc_thong_tin(driver, wait, row, from_dt=None, to_dt=None):
    btn = find_nursing_button(row)
    if btn is None:
        return {}

    old_handles = set(driver.window_handles)
    old_handle = driver.current_window_handle
    old_url = driver.current_url
    driver.execute_script("arguments[0].click();", btn)
    time.sleep(0.8)

    new_handles = [h for h in driver.window_handles if h not in old_handles]
    if new_handles:
        driver.switch_to.window(new_handles[-1])

    wait_thong_tin_dieu_duong(driver, timeout=8)
    info = doc_thong_tin_dieu_duong(driver)

    try:
        if new_handles:
            driver.close()
            driver.switch_to.window(old_handle)
        else:
            dong_popup(driver)
            time.sleep(0.3)
            # Một số màn hình mở cùng tab thay vì modal. Nếu còn đang ở trang chi tiết, quay lại danh sách.
            if driver.current_url != old_url and (label_text(driver, "lblHoTen") or label_text(driver, "lblNgayVaoVien")):
                log_warn("Điều dưỡng mở cùng tab — dùng buttonBackNT để quay lại danh sách")
                # Ưu tiên click #buttonBackNT: giữ nguyên trạng thái Hoàn tất + bộ lọc ngày
                if not click_back_noi_tru(driver, wait, from_dt, to_dt):
                    # Fallback: driver.back() rồi restore bộ lọc thủ công
                    log_warn("buttonBackNT thất bại — fallback driver.back()")
                    driver.back()
                    time.sleep(0.8)
                    dismiss_sweet_alert(driver, timeout=2)
                    try:
                        restore_noi_tru_date_filter(driver, wait, from_dt, to_dt, click_search=True)
                        WebDriverWait(driver, 8).until(EC.presence_of_element_located((By.ID, "tblNoiTru")))
                        log_ok("Đã phục hồi bộ lọc ngày sau driver.back()")
                    except Exception as e:
                        log_warn(f"driver.back() cũng lỗi: {e} — vào lại từ menu")
                        try:
                            vao_noi_tru(driver, wait)
                            chon_hoan_tat(driver, wait, from_dt, to_dt)
                            log_ok("Đã vào lại danh sách từ menu")
                        except Exception as e2:
                            log_error_raw(f"Không phục hồi được danh sách: {e2}")
    except Exception:
        try:
            driver.switch_to.window(old_handle)
        except Exception:
            pass
    return info


def _find_history_button(row):
    """Tìm nút/link mở Lịch sử chung trong một dòng người bệnh.

    Không click nút con mắt Điều dưỡng. Dòng Hoàn tất thường có nhiều icon mắt;
    nếu chọn nhầm icon Điều dưỡng, EMR mở dieuduongdraw cùng tab và script bị kẹt
    ở màn hồ sơ chăm sóc thay vì mở popup XN/CĐHA.
    """
    positive_tokens = [
        "onshowlichsuchung", "lich su chung", "xem kq", "xem ket qua",
        "ket qua cls", "ketqua", "xet nghiem", "xetnghiem", "cdha",
        "chan doan hinh anh", "can lam sang", "cls",
    ]
    negative_tokens = [
        "dieuduong", "dieu duong", "dieu_duong", "wpid=dieuduongdraw",
        "cham soc", "chamsoc", "buong giuong", "buonggiuong",
        "theo doi", "nhan dinh", "y lenh", "lich su y lenh",
        "bacsidraw", "wpid=bacsidraw",
    ]
    try:
        candidates = row.find_elements(By.XPATH, ".//a|.//button")
    except Exception:
        candidates = []
    best = None
    best_score = 0
    for el in candidates:
        try:
            hay = button_haystack(el)
        except Exception:
            hay = ""
        if not hay:
            continue
        if any(tok in hay for tok in negative_tokens):
            continue
        score = 0
        if "onshowlichsuchung" in hay:
            score += 100
        if "lich su chung" in hay:
            score += 45
        if "xem kq" in hay or "xem ket qua" in hay:
            score += 40
        if "xet nghiem" in hay or "xetnghiem" in hay:
            score += 25
        if "cdha" in hay or "chan doan hinh anh" in hay:
            score += 25
        if "can lam sang" in hay or "cls" in hay:
            score += 15
        # Không dùng riêng chữ "lịch sử" để chọn, vì dễ bấm nhầm Lịch sử y lệnh.
        if score > best_score:
            best = el
            best_score = score
    return best if best_score > 0 else None

def _open_history_popup_from_row(driver, row, wait=None, from_dt=None, to_dt=None):
    """Click nút Lịch sử chung và chuyển tab mới nếu EMR mở tab/window.

    Nếu click nhầm sang màn Điều dưỡng/chi tiết cùng tab, thoát ngay về danh sách
    thay vì đứng chờ popup không bao giờ xuất hiện.
    """
    btn = _find_history_button(row)
    if btn is None:
        return False
    old_handles = set(driver.window_handles)
    old_handle = driver.current_window_handle
    old_wpid = _current_wpid(driver)
    _safe_click(driver, btn)
    wait_document_idle(driver, timeout=0.5 if FAST_UI else 1.0)
    try:
        new_handles = [h for h in driver.window_handles if h not in old_handles]
        if new_handles:
            driver.switch_to.window(new_handles[-1])
            log_info("Lịch sử chung mở tab mới — đã chuyển tab")
    except Exception:
        try:
            driver.switch_to.window(old_handle)
        except Exception:
            pass

    # Nếu sau click đang ở dieuduongdraw/bacsidraw thì chắc chắn bấm nhầm nút.
    # Thoát nhanh để không kẹt ở hồ sơ chăm sóc như ảnh người dùng gửi.
    new_wpid = _current_wpid(driver)
    if new_wpid and new_wpid != old_wpid and new_wpid != "danhsachdieutrinoitrudraw":
        _fast_recover_from_wrong_detail(driver, wait, from_dt, to_dt, reason=f"click Lịch sử mở nhầm wpid={new_wpid}")
        return False
    if is_noi_tru_detail_page(driver):
        _fast_recover_from_wrong_detail(driver, wait, from_dt, to_dt, reason="click Lịch sử mở màn chi tiết BN")
        return False

    ok = _wait_history_popup_ready(driver, timeout=4 if FAST_UI else 8)
    if not ok and is_noi_tru_detail_page(driver):
        _fast_recover_from_wrong_detail(driver, wait, from_dt, to_dt, reason="không thấy popup sau khi đã vào chi tiết")
    return ok


def tim_bn_va_mo_popup(driver, wait, ma_bn, row_index=0, from_dt=None, to_dt=None, base_ctx=None, preloaded_rows=None):
    """Mở popup lịch sử cho một lượt điều trị.

    preloaded_rows cho phép dùng lại kết quả tìm kiếm BN đã có ở vòng ngoài.
    Trước đây mỗi lượt điều trị lại gọi tim_kiem_benh_nhan(), nên một BN có 2-5 lượt
    bị bấm Tìm kiếm lặp nhiều lần. Dùng rows đã có giúp nhanh hơn; nếu DOM bị stale
    sau khi đóng popup thì hàm tự fallback tìm lại.
    """
    ensure_noi_tru_list(driver, wait, from_dt, to_dt)
    rows = preloaded_rows if preloaded_rows is not None else tim_kiem_benh_nhan(driver, wait, ma_bn, from_dt, to_dt)
    if row_index >= len(rows):
        return None

    row = rows[row_index]
    info = {}
    try:
        info = extract_initial_list_info_from_row(driver, row) or {}
    except Exception as e:
        # Nếu row lấy từ preloaded_rows đã stale, tìm lại đúng một lần.
        if preloaded_rows is not None:
            try:
                rows = tim_kiem_benh_nhan(driver, wait, ma_bn, from_dt, to_dt)
                if row_index >= len(rows):
                    return None
                row = rows[row_index]
                info = extract_initial_list_info_from_row(driver, row) or {}
            except Exception:
                info = {}
        else:
            info = {}

    # Nếu dòng này không khớp T/G vào của input, bỏ qua ngay, không mở Điều dưỡng
    # hoặc popup lịch sử. Đây là điểm tăng tốc lớn khi một Mã BN có nhiều lượt.
    if base_ctx and has_visit_filter(base_ctx):
        probe = dict(base_ctx)
        merge_non_empty(probe, info)
        if not visit_matches_filter(base_ctx, probe):
            info["__skip_visit"] = "1"
            return info

    # Mặc định không mở màn Điều dưỡng trước vì màn này hay mở cùng tab, gây lỗi
    # DateTime/Back và làm quét chậm. Có thể bật lại bằng env RESEARCH_SKIP_NURSING_FIRST=0.
    if not RESEARCH_SKIP_NURSING_FIRST:
        try:
            deep_info = mo_dieu_duong_va_doc_thong_tin(driver, wait, row, from_dt, to_dt)
            merge_non_empty(info, deep_info)
            ensure_noi_tru_list(driver, wait, from_dt, to_dt)
            rows = tim_kiem_benh_nhan(driver, wait, ma_bn, from_dt, to_dt)
            if row_index >= len(rows):
                return None
            row = rows[row_index]
        except Exception as e:
            log_warn(f"Mở thông tin Điều dưỡng lỗi, tiếp tục mở lịch sử chung: {e}")
    else:
        log_info("Bỏ qua mở Điều dưỡng trước — mở trực tiếp Lịch sử XN/CĐHA để tránh kẹt click")

    try:
        if not _open_history_popup_from_row(driver, row, wait, from_dt, to_dt):
            # Dọn overlay rồi thử tìm/click lại một lần. EMR đôi khi còn modal-backdrop
            # sau khi đóng Điều dưỡng làm click lần đầu không mở popup.
            dong_popup(driver)
            ensure_noi_tru_list(driver, wait, from_dt, to_dt)
            rows = tim_kiem_benh_nhan(driver, wait, ma_bn, from_dt, to_dt)
            if row_index >= len(rows):
                return None
            if not _open_history_popup_from_row(driver, rows[row_index], wait, from_dt, to_dt):
                return None
        # Nếu popup lịch sử cũng có các label thông tin bệnh nhân thì dùng làm nguồn bổ sung.
        merge_non_empty(info, doc_thong_tin_dieu_duong(driver))
        return info or {}
    except Exception as e:
        log_warn(f"Mở popup Lịch sử chung lỗi: {e}")
        return None


def dong_popup(driver):
    log_click("Đóng popup [data-dismiss=modal]")
    try:
        driver.execute_script("""
            // Đóng SweetAlert nếu đang hiện.
            var swalBtns = document.querySelectorAll('.swal2-confirm,.confirm,button.confirm');
            for (var i=0; i<swalBtns.length; i++) {
                try { if (swalBtns[i].offsetParent !== null) swalBtns[i].click(); } catch(e) {}
            }
            // Đóng tất cả modal Bootstrap còn sót lại.
            var btns = document.querySelectorAll('[data-dismiss="modal"],.modal .close,.modal button.close');
            for (var j=0; j<btns.length; j++) {
                try { btns[j].click(); } catch(e) {}
            }
            if (window.jQuery) {
                try { window.jQuery('.modal').modal('hide'); } catch(e) {}
            }
            var modals = document.querySelectorAll('.modal');
            for (var k=0; k<modals.length; k++) {
                try {
                    modals[k].classList.remove('show','in');
                    modals[k].style.display = 'none';
                    modals[k].setAttribute('aria-hidden','true');
                } catch(e) {}
            }
            var backs = document.querySelectorAll('.modal-backdrop,.swal2-container');
            for (var m=0; m<backs.length; m++) { try { backs[m].remove(); } catch(e) {} }
            document.body.classList.remove('modal-open');
            document.body.style.overflow = '';
            document.body.style.paddingRight = '';
        """)
        _fast_sleep(0.2)
        log_ok("Đóng popup xong")
    except Exception as e:
        log_warn(f"Đóng popup lỗi (bỏ qua): {e}")



def _click_button_back_nt(driver):
    """Gọi nút quay lại nội trú theo đúng JS của EMR.

    HTML thực tế: <a id="buttonBackNT" onclick="backFormNoiTru();">...</a>.
    Click Selenium đơn thuần đôi khi không chạy được khi trang đang bị overlay/chậm,
    nên ưu tiên gọi trực tiếp `backFormNoiTru()` rồi mới fallback sang click nút.
    """
    try:
        return driver.execute_script("""
            try {
              if (typeof window.backFormNoiTru === 'function') {
                window.backFormNoiTru();
                return 'backFormNoiTru';
              }
            } catch(e1) {}
            var btn = document.getElementById('buttonBackNT');
            if (!btn) return '';
            try { btn.scrollIntoView({block:'center', inline:'nearest'}); } catch(e2) {}
            try {
              ['mouseover','mousedown','mouseup','click'].forEach(function(type){
                btn.dispatchEvent(new MouseEvent(type, {view:window, bubbles:true, cancelable:true}));
              });
              return 'dispatch';
            } catch(e3) {
              try { btn.click(); return 'click'; } catch(e4) { return ''; }
            }
        """) or ""
    except Exception:
        return ""


def _fast_recover_from_wrong_detail(driver, wait=None, from_dt=None, to_dt=None, reason=""):
    """Thoát nhanh khỏi màn chi tiết BN khi script bấm nhầm sang dieuduongdraw.

    Không chờ lâu: thử backFormNoiTru/buttonBackNT ngắn, nếu chưa về danh sách thì
    ép URL danh sách có giữ `kp` để tránh cảnh báo "Chưa chọn khoa phòng".
    """
    try:
        if reason:
            log_warn(f"Đang ở màn chi tiết, phục hồi nhanh về danh sách — {reason}")
        else:
            log_warn("Đang ở màn chi tiết, phục hồi nhanh về danh sách")
        dismiss_sweet_alert(driver, timeout=0.2 if FAST_UI else 1)
        method = _click_button_back_nt(driver)
        if method:
            log_click(f"buttonBackNT/backFormNoiTru — {method}")
            wait_document_idle(driver, timeout=0.6 if FAST_UI else 1.2)
            dismiss_sweet_alert(driver, timeout=0.5 if FAST_UI else 2)
            if wait is not None and wait_noi_tru_list_ready(driver, timeout=3 if FAST_UI else 6):
                try:
                    restore_noi_tru_date_filter(driver, wait, from_dt, to_dt,
                                                click_search=True, alert_already_dismissed=True)
                except Exception as e:
                    log_warn(f"Phục hồi ngày sau back nhanh lỗi nhẹ: {e}")
                return True
        if wait is not None:
            return force_open_noi_tru_list(driver, wait, from_dt, to_dt, reason="không thoát được màn chi tiết bằng buttonBackNT")
        return False
    except Exception as e:
        log_warn(f"Phục hồi nhanh khỏi màn chi tiết lỗi: {e}")
        return False

def click_back_noi_tru(driver, wait, from_dt=None, to_dt=None, timeout=12):
    """Click nút #buttonBackNT (← Quay lại) để về danh sách nội trú.

    Flow:
      1. Dismiss SweetAlert nếu đang chặn (DateTime lỗi)
      2. Click buttonBackNT
      3. EMR có thể raise DateTime ngay sau khi back → dismiss lại
      4. Set dtTuNgay/dtDenNgay (vì sau back các ô này thường còn visible)
      5. Bấm Tìm kiếm → đợi tblNoiTru

    KHÔNG tìm lại buttonBackNT sau bước 2 — nút đó chỉ có ở trang chi tiết.
    """
    # ── Phase 1: dismiss alert đang chặn rồi click nút back ──────────────────
    dismiss_sweet_alert(driver, timeout=0.8 if FAST_UI else 3)
    _fast_sleep(0.2)

    btn = None
    try:
        btn = WebDriverWait(driver, 2 if FAST_UI else 5).until(
            EC.presence_of_element_located((By.ID, "buttonBackNT"))
        )
    except Exception:
        log_warn("Không tìm thấy buttonBackNT — trang có thể đã là danh sách")

    if btn is not None:
        method = _click_button_back_nt(driver)
        log_click(f"buttonBackNT — quay lại danh sách nội trú ({method or 'fallback'})")
        wait_document_idle(driver, timeout=0.6 if FAST_UI else 1.2)

    # ── Phase 2: sau khi back, dismiss DateTime alert → set date → tìm kiếm ──
    # EMR thường raise "String was not recognized as a valid DateTime" ngay sau back.
    # Lúc này trang ĐÃ là danh sách (có dtTuNgay visible) nhưng bị alert chặn.
    # Chỉ cần: dismiss → set date → bấm Tìm kiếm. KHÔNG click back lần nữa.
    dismiss_sweet_alert(driver, timeout=1.0 if FAST_UI else 4)
    _fast_sleep(0.3)

    # Kiểm tra thật sự đã về danh sách chưa. Không được dùng riêng #txtTimKiem
    # vì màn dieuduongdraw cũng có ô tìm kiếm trên header.
    if wait_noi_tru_list_ready(driver, timeout=timeout):
        log_info("Đã về danh sách thật — set date và bấm Tìm kiếm")
        try:
            restore_noi_tru_date_filter(driver, wait, from_dt, to_dt,
                                        click_search=True, alert_already_dismissed=True)
            if wait_noi_tru_list_ready(driver, timeout=6):
                log_ok("Quay lại danh sách nội trú xong (buttonBackNT + restore date)")
                return True
            log_warn("Sau restore date vẫn chưa xác nhận được danh sách nội trú")
        except Exception as e:
            log_warn(f"restore_noi_tru_date_filter sau back lỗi: {e}")

    # Vẫn còn ở chi tiết hoặc không xác định — ép mở URL danh sách.
    wpid = _current_wpid(driver)
    if wpid and wpid != "danhsachdieutrinoitrudraw":
        return force_open_noi_tru_list(driver, wait, from_dt, to_dt, reason=f"vẫn ở wpid={wpid}")
    return force_open_noi_tru_list(driver, wait, from_dt, to_dt, reason="buttonBackNT không xác nhận được danh sách")


def ensure_noi_tru_list(driver, wait, from_dt=None, to_dt=None):
    """Đảm bảo browser đang thật sự ở trang danh sách nội trú.

    Điều kiện hợp lệ: URL/trang không phải dieuduongdraw/bacsidraw và bảng
    #tblNoiTru + #txtTimKiem + #btnTimKiem đều visible.
    """
    try:
        dismiss_sweet_alert(driver, timeout=0.5)
    except Exception:
        pass

    if is_noi_tru_list_ready(driver):
        return True

    try:
        wpid = _current_wpid(driver)
        if wpid:
            log_warn(f"Phục hồi về danh sách nội trú — hiện tại wpid={wpid or 'unknown'}")
        else:
            log_warn("Phục hồi về danh sách nội trú — chưa xác nhận được bảng danh sách")

        # Nếu đang ở chi tiết BN, thử nút Quay lại trước.
        if is_noi_tru_detail_page(driver) and click_back_noi_tru(driver, wait, from_dt, to_dt):
            return True

        # Nếu click back không chắc chắn, ép URL trực tiếp.
        if force_open_noi_tru_list(driver, wait, from_dt, to_dt, reason="ensure_noi_tru_list fallback"):
            return True

        # Fallback cuối: vào lại từ menu rồi chọn Hoàn tất.
        try:
            vao_noi_tru(driver, wait)
            chon_hoan_tat(driver, wait, from_dt, to_dt)
            return wait_noi_tru_list_ready(driver, timeout=10)
        except Exception as e2:
            log_warn(f"Vào lại từ menu thất bại: {e2}")
            return False
    except Exception as e:
        log_error_raw(f"Không phục hồi được danh sách nội trú: {e}")
        return False


def click_tab(driver, tab_id):
    """Click tab trong popup Lịch sử KCB.

    EMR thay đổi nhẹ id/onclick theo phiên. Hàm này ưu tiên id cũ, sau đó dò
    theo href/onclick/text để không bị đứng ở tab mặc định.
    """
    is_xn = "XN" in tab_id.upper() or "XET" in normalize_for_match(tab_id)
    is_cdha = "CDHA" in tab_id.upper() or "cdha" in normalize_for_match(tab_id)
    text_tokens = ["xet nghiem", "xn"] if is_xn else ["cdha", "chan doan hinh anh", "hinh anh"]
    js = r"""
        var tabId = arguments[0];
        var tokens = arguments[1] || [];
        function visible(el){
          if(!el) return false;
          var st = window.getComputedStyle(el);
          return st.display !== 'none' && st.visibility !== 'hidden' &&
                 (el.offsetParent !== null || st.position === 'fixed');
        }
        function norm(s){
          try { return (s || '').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase(); }
          catch(e){ return String(s || '').toLowerCase(); }
        }
        function fire(el){
          try { el.scrollIntoView({block:'center', inline:'nearest'}); } catch(e) {}
          try { el.click(); return true; } catch(e) {}
          try {
            ['mouseover','mousedown','mouseup','click'].forEach(function(n){
              el.dispatchEvent(new MouseEvent(n,{bubbles:true,cancelable:true,view:window}));
            });
            return true;
          } catch(e) { return false; }
        }
        var el = document.getElementById(tabId);
        if (el && fire(el)) return {ok:true, how:'id'};
        var selectors = [
          'a[href*="LichSuXN"]','a[href*="LichSuCDHA"]',
          'a[href*="tabLichSuXN"]','a[href*="tabLichSuCDHA"]',
          '[onclick*="LichSuXN"]','[onclick*="LichSuCDHA"]',
          '[onclick*="XetNghiem"]','[onclick*="CDHA"]',
          'li[id*="LichSu"]','a[id*="LichSu"]','button[id*="LichSu"]',
          '.modal.show a,.modal.show li,.modal.show button,.modal.in a,.modal.in li,.modal.in button',
          'a,li,button,span'
        ];
        var seen = [];
        for (var s=0; s<selectors.length; s++) {
          var els = Array.prototype.slice.call(document.querySelectorAll(selectors[s])).filter(visible);
          for (var i=0; i<els.length; i++) {
            var e = els[i];
            if (seen.indexOf(e) >= 0) continue;
            seen.push(e);
            var hay = norm([e.id, e.getAttribute('href'), e.getAttribute('onclick'), e.innerText, e.textContent, e.title].join(' '));
            var ok = false;
            for (var t=0; t<tokens.length; t++) {
              if (hay.indexOf(tokens[t]) >= 0) { ok = true; break; }
            }
            if (!ok) continue;
            if (fire(e)) return {ok:true, how:'fallback', text:(e.innerText || e.id || '').trim()};
          }
        }
        return {ok:false, how:'not_found'};
    """
    try:
        res = driver.execute_script(js, tab_id, text_tokens) or {}
        if res.get("ok"):
            _fast_sleep(0.35 if FAST_UI else 0.8)
            return True
    except Exception:
        pass
    try:
        t = driver.find_element(By.ID, tab_id)
        _safe_click(driver, t)
        _fast_sleep(0.35 if FAST_UI else 0.8)
        return True
    except Exception:
        return False


def wait_content(driver, div_id, timeout=8):
    """Đợi vùng tab có dữ liệu hoặc thông báo rỗng.

    Không chỉ dựa vào .text vì nhiều bảng EMR render bằng HTML table/input nên
    .text có thể rỗng trong vài giây dù DOM đã có nội dung.
    """
    end = time.time() + timeout
    last_html_len = 0
    while time.time() < end:
        try:
            state = driver.execute_script(r"""
                var id = arguments[0];
                var el = document.getElementById(id);
                if (!el) return {exists:false, text:'', html:0, rows:0, loading:false};
                var txt = (el.innerText || el.textContent || '').trim();
                var html = (el.innerHTML || '').length;
                var rows = el.querySelectorAll('tr, .ylenh-a, a, table, textarea, input').length;
                var low = txt.toLowerCase();
                var loading = low.indexOf('dang tai') >= 0 || low.indexOf('loading') >= 0 || low.indexOf('vui long doi') >= 0;
                return {exists:true, text:txt, html:html, rows:rows, loading:loading};
            """, div_id) or {}
            if state.get("exists"):
                txt = normalize_text(state.get("text") or "")
                html_len = int(state.get("html") or 0)
                rows = int(state.get("rows") or 0)
                last_html_len = max(last_html_len, html_len)
                if (txt or rows > 0 or html_len > 80) and not state.get("loading"):
                    return True
        except Exception:
            pass
        _fast_sleep(0.18)
    return False

# ── Parse XN ─────────────────────────────────────────────────────────────────
def _bat_thuong(td):
    style = td.get("style", "").lower()
    css_class = " ".join(td.get("class") or []).lower()
    text = td.get_text(" ", strip=True).lower()
    combined = f"{style} {css_class} {text}"
    if "red" in combined or "danger" in combined or "cao" in combined:
        return "cao/thấp"
    if "blue" in combined or "low" in combined or "thấp" in combined:
        return "thấp"
    return ""


def parse_chi_tiet_xn(driver, ctx, item):
    rows = []
    div = driver.find_element(By.ID, "divLSCT")
    soup = BeautifulSoup(div.get_attribute("innerHTML"), "html.parser")

    table = soup.find("div", id="divDsChiSoContent")
    if not table:
        return rows

    ngay, gio = split_vn_datetime(item.get("tg_chi_dinh", ""))
    for tr in table.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) < 5:
            continue
        chi_so = normalize_text(tds[1].get_text(strip=True))
        ket_qua = normalize_text(tds[2].get_text(strip=True))
        tham_chieu = normalize_text(tds[3].get_text(strip=True))
        don_vi = normalize_text(tds[4].get_text(strip=True))
        if not chi_so and not ket_qua:
            continue
        rows.append({
            "Mã NC": ctx.get("Mã NC", ""),
            "Mã BN": ctx.get("Mã BN", ""),
            "Mã vào viện": ctx.get("Mã vào viện", ""),
            "Mã điều trị": ctx.get("Mã điều trị", ""),
            "TG chỉ định": item.get("tg_chi_dinh", ""),
            "Ngày chỉ định": ngay,
            "Giờ chỉ định": gio,
            "Người chỉ định": item.get("nguoi_chi_dinh", ""),
            "Khoa/Phòng": item.get("phong", ""),
            "Loại XN": item.get("loai_xn", ""),
            "Mã phiếu": item.get("ma_phieu", ""),
            "Trạng thái": item.get("trang_thai", ""),
            "Chỉ số": chi_so,
            "Kết quả": ket_qua,
            "Khoảng tham chiếu": tham_chieu,
            "Đơn vị": don_vi,
            "Bất thường": _bat_thuong(tds[2]),
        })
    return rows


def xu_ly_tab_xn(driver, ctx, w_xn=None, fh_xn=None, from_dt=None, to_dt=None):
    click_tab(driver, "litabLichSuXN")
    if not wait_content(driver, "divLichSuXNContent"):
        print("      XN: không load được")
        return []

    div = driver.find_element(By.ID, "divLichSuXNContent")
    soup = BeautifulSoup(div.get_attribute("innerHTML"), "html.parser")
    table = soup.find("table")
    if not table:
        return []

    phong = ""
    items = []
    for tr in table.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) == 1 and tds[0].get("colspan"):
            phong = normalize_text(tds[0].get_text(strip=True))
            continue
        if len(tds) < 5:
            continue
        trang_thai = normalize_text(tds[5].get_text(strip=True)) if len(tds) > 5 else ""
        if "Hoàn tất" not in trang_thai:
            continue
        tg = normalize_text(tds[2].get_text(strip=True))
        # Không loại theo ngày vào/ra khoa. Popup lịch sử được mở từ đúng lượt
        # điều trị; giữ toàn bộ sự kiện để tầng chuẩn hóa tính days_from_* và
        # is_within_encounter thay vì làm mất dữ liệu ngay lúc thu thập.
        items.append({
            "tr_id": tr.get("id", ""),
            "tg_chi_dinh": tg,
            "nguoi_chi_dinh": normalize_text(tds[3].get_text(strip=True)),
            "loai_xn": normalize_text(tds[4].get_text(strip=True)),
            "trang_thai": trang_thai,
            "phong": phong,
            "ma_phieu": tr.get("id", ""),
        })

    total_rows = []
    for item in items:
        tr_id = item.get("tr_id", "")
        try:
            if not tr_id:
                continue
            span = driver.find_element(By.XPATH, f"//tr[@id='{tr_id}']//span[contains(@class,'ylenh-a')]")
            driver.execute_script("arguments[0].click();", span)
            WebDriverWait(driver, 8).until(lambda d: d.find_element(By.ID, "divLSCT").text.strip() != "")
            time.sleep(0.4)
            total_rows.extend(parse_chi_tiet_xn(driver, ctx, item))
        except Exception as e:
            print(f"      [XN] Lỗi click {tr_id}: {e}")
    if w_xn:
        w_xn.writerows(total_rows)
        if fh_xn:
            fh_xn.flush()
    print(f"      XN: {len(total_rows)} chỉ số từ {len(items)} phiếu Hoàn tất")
    return total_rows

# ── Parse CĐHA ───────────────────────────────────────────────────────────────
def _html_to_text(html_str):
    if not html_str:
        return ""
    soup = BeautifulSoup(html_str, "html.parser")
    for br in soup.find_all("br"):
        br.replace_with("\n")
    return soup.get_text(separator="\n").strip()


def _get_textarea_value(driver, soup, css_selector, textarea_id):
    try:
        el = driver.find_element(By.CSS_SELECTOR, css_selector)
        val = driver.execute_script("return arguments[0].value || arguments[0].innerText || arguments[0].textContent;", el)
        return normalize_text(val)
    except Exception:
        pass
    ta = soup.find("textarea", id=textarea_id)
    if ta:
        return normalize_text(unescape(ta.get_text()))
    return ""


def parse_chi_tiet_cdha(driver, ctx, item):
    row = {
        "Mã NC": ctx.get("Mã NC", ""),
        "Mã BN": ctx.get("Mã BN", ""),
        "Mã vào viện": ctx.get("Mã vào viện", ""),
        "Mã điều trị": ctx.get("Mã điều trị", ""),
        "TG chỉ định": item.get("tg_chi_dinh", ""),
        "Ngày chỉ định": item.get("ngay_chi_dinh", ""),
        "Giờ chỉ định": item.get("gio_chi_dinh", ""),
        "Người chỉ định": item.get("nguoi_chi_dinh", ""),
        "Khoa/Phòng": item.get("phong", ""),
        "Tên dịch vụ": item.get("ten_dv", ""),
        "Nhóm dịch vụ": guess_group_cdha(item.get("ten_dv", "")),
        "Mô tả/Kết quả": "",
        "Kết luận": "",
        "Trạng thái": item.get("trang_thai", ""),
    }
    div = driver.find_element(By.ID, "divLichSuCDHAContent")
    soup = BeautifulSoup(div.get_attribute("innerHTML"), "html.parser")

    # Lấy mô tả/kết quả cho tất cả loại CĐHA nếu có.
    try:
        ne_el = driver.find_element(By.CSS_SELECTOR, "#divLichSuCDHAContent div.note-editable")
        row["Mô tả/Kết quả"] = normalize_text(driver.execute_script("return arguments[0].innerText;", ne_el))
    except Exception:
        pass
    if not row["Mô tả/Kết quả"]:
        row["Mô tả/Kết quả"] = _get_textarea_value(
            driver, soup, "#divLichSuCDHAContent textarea#kq_txtMoTa", "kq_txtMoTa"
        )

    row["Kết luận"] = _get_textarea_value(
        driver, soup, "#divLichSuCDHAContent textarea#kq_txtKetLuan", "kq_txtKetLuan"
    )
    return row


def xu_ly_tab_cdha(driver, ctx, w_cdha=None, fh_cd=None, from_dt=None, to_dt=None):
    click_tab(driver, "litabLichSuCDHA")
    if not wait_content(driver, "divLichSuCDHAContent"):
        print("      CĐHA: không load được")
        return []

    div = driver.find_element(By.ID, "divLichSuCDHAContent")
    soup = BeautifulSoup(div.get_attribute("innerHTML"), "html.parser")
    table = soup.find("table", id="tbDichVu") or soup.find("table")
    if not table:
        return []

    phong = ""
    items = []
    for tr in table.find_all("tr"):
        tds = tr.find_all("td")
        if len(tds) == 1 and tds[0].get("colspan"):
            phong = normalize_text(tds[0].get_text(strip=True))
            continue
        if len(tds) < 6:
            continue
        trang_thai = normalize_text(tds[5].get_text(strip=True))
        if "Hoàn tất" not in trang_thai:
            continue
        tg = normalize_text(tds[1].get_text(strip=True))
        # CĐHA có thể được thực hiện trước khi chuyển vào khoa hiện tại. Giữ toàn
        # bộ lịch sử của popup đúng lượt, không lọc bằng cửa sổ ngày của cohort.
        a_xem = tds[6].find("a") if len(tds) > 6 else None
        if not a_xem:
            continue
        ngay, gio = split_vn_datetime(tg)
        items.append({
            "onclick": a_xem.get("onclick", ""),
            "tg_chi_dinh": tg,
            "ngay_chi_dinh": ngay,
            "gio_chi_dinh": gio,
            "ten_dv": normalize_text(tds[2].get_text(strip=True)),
            "nguoi_chi_dinh": normalize_text(tds[4].get_text(strip=True)),
            "trang_thai": trang_thai,
            "phong": phong,
        })

    total_rows = []
    for item in items:
        try:
            onclick = item.get("onclick", "")
            if not onclick:
                continue
            driver.execute_script(onclick.replace("return false;", "").strip())
            WebDriverWait(driver, 8).until(
                lambda d: d.find_element(By.ID, "divLichSuCDHAContent").find_elements(
                    By.CSS_SELECTOR, "input#kq_txtNoiThucHien, textarea#kq_txtKetLuan, div.note-editable"
                )
            )
            time.sleep(0.4)
            total_rows.append(parse_chi_tiet_cdha(driver, ctx, item))
            try:
                ql = driver.find_element(By.XPATH, "//button[contains(text(),'Quay lại') or contains(.,'Quay lại')]")
                driver.execute_script("arguments[0].click();", ql)
                WebDriverWait(driver, 6).until(
                    lambda d: d.find_element(By.ID, "divLichSuCDHAContent").find_elements(By.CSS_SELECTOR, "table#tbDichVu,table")
                )
                time.sleep(0.3)
            except Exception:
                pass
        except Exception as e:
            print(f"      [CĐHA] Lỗi {item.get('ten_dv','')}: {e}")
    if w_cdha:
        w_cdha.writerows(total_rows)
        if fh_cd:
            fh_cd.flush()
    print(f"      CĐHA: {len(total_rows)} dịch vụ Hoàn tất")
    return total_rows

# ── Main ─────────────────────────────────────────────────────────────────────

# ── Main ─────────────────────────────────────────────────────────────────────
def parse_args():
    parser = argparse.ArgumentParser(description="Lấy lịch sử XN và CĐHA từ EMR cho nghiên cứu lâm sàng")
    parser.add_argument("--input", default=DEFAULT_INPUT_CSV, help="CSV danh sách bệnh nhân")
    parser.add_argument("--project-id", default=DEFAULT_PROJECT_ID, help="Mã đề tài/thư mục nghiên cứu")
    parser.add_argument("--run-id", default=datetime.now().strftime("%Y%m%d_%H%M%S"), help="Mã lần chạy")
    parser.add_argument("--out-root", default="", help="Thư mục gốc lưu nghiên cứu. Mặc định: research_store")
    parser.add_argument("--from-date", default="", help="Lọc từ ngày dd/mm/yyyy hoặc yyyy-mm-dd")
    parser.add_argument("--to-date", default="", help="Lọc đến ngày dd/mm/yyyy hoặc yyyy-mm-dd")
    parser.add_argument("--headless", action="store_true", help="Chạy Chrome headless")
    parser.add_argument("--list-only", action="store_true", help="Chỉ quét bảng danh sách hoàn tất và ghi du_lieu_ban_dau.csv, không mở con mắt Điều dưỡng")
    parser.add_argument("--patient-info-only", action="store_true", help="Chỉ vào Quản lý Bệnh nhân → D/s Bệnh nhân để lấy Điện thoại/Số CMND theo Mã BN")
    parser.add_argument(
        "--no-stop-at-existing-initial",
        action="store_true",
        help="Bước 1: quét hết khoảng ngày, không dừng khi gặp dòng đã có trong du_lieu_ban_dau.csv",
    )
    parser.add_argument("--archive-initial-list", default="", help="Đường dẫn du_lieu_ban_dau.csv của kho gốc để gộp/xóa dòng đã được lượt điều trị bao phủ")
    parser.add_argument("--rescan-recent-days", type=int, default=7, help="Khi quét tiếp dữ liệu gốc, quét chồng lại N ngày cuối khoảng lọc để bắt hồ sơ mới hoàn tất muộn")
    return parser.parse_args()


def _same_file_path(src, dst):
    """Trả True khi src/dst thực sự trỏ tới cùng một file.

    Trường hợp refetch: Node tạo CSV ngay trong ``run/input`` rồi truyền chính
    đường dẫn đó cho worker. ``prepare_run`` cũng chọn ``run/input`` làm nơi
    lưu input, vì vậy src và dst có thể là cùng một file. Trên Windows, gọi
    CopyFile2 lên chính file đó có thể trả WinError 32 thay vì SameFileError.
    """
    src = Path(src)
    dst = Path(dst)
    try:
        if src.exists() and dst.exists() and os.path.samefile(src, dst):
            return True
    except OSError:
        pass
    try:
        src_norm = os.path.normcase(os.path.abspath(os.fspath(src)))
        dst_norm = os.path.normcase(os.path.abspath(os.fspath(dst)))
        return src_norm == dst_norm
    except (OSError, TypeError, ValueError):
        return False


def _copy2_with_retry(src, dst, attempts=6, delay=0.35):
    """Copy file có retry cho lỗi khóa tạm thời trên Windows.

    Nếu src và dst là cùng một file thì không copy. Đây là trường hợp hợp lệ
    khi file refetch đã được backend tạo trực tiếp trong thư mục input của run.
    """
    if _same_file_path(src, dst):
        return

    last_err = None
    for i in range(attempts):
        try:
            shutil.copy2(src, dst)
            return
        except shutil.SameFileError:
            return
        except PermissionError as e:
            last_err = e
            if i < attempts - 1:
                time.sleep(delay * (i + 1))  # backoff tăng dần
    raise last_err


def prepare_run(args, script_dir, patients_count):
    project_id = safe_filename(args.project_id)
    args.project_id = project_id
    if not args.out_root:
        out_root = Path(script_dir).resolve().parents[1] / "research_store"
    else:
        out_root = Path(args.out_root)
    run_dir = out_root / project_id / "runs" / safe_filename(args.run_id)
    input_dir = run_dir / "input"
    mkdirp(input_dir)
    input_path = Path(args.input)
    if input_path.exists():
        _copy2_with_retry(input_path, input_dir / input_path.name)
    write_manifest(run_dir, args, patients_count)
    return run_dir


def write_patient_master(run_dir, contexts):
    # File mô tả mẫu chỉ phụ thuộc input. Khi chạy tiếp cùng run_id, ghi đè file này
    # để không nhân đôi bệnh nhân; các file kết quả chi tiết vẫn append theo progress.
    path = Path(run_dir) / "mau_nghien_cuu.csv"
    mkdirp(path.parent)
    with open(path, "w", encoding="utf-8-sig", newline="") as f:
        w = csv.DictWriter(f, fieldnames=COL_PATIENTS, extrasaction="ignore")
        w.writeheader()
        w.writerows(contexts)


def main():
    args = parse_args()
    script_dir = Path(__file__).resolve().parent
    input_path = Path(args.input)
    if not input_path.is_absolute():
        input_path = script_dir / input_path
    args.input = str(input_path)

    if not input_path.exists() and not args.list_only:
        print(f"❌ Không tìm thấy {input_path}")
        return 1

    from_dt = parse_date_arg(args.from_date) if args.from_date else None
    to_dt = parse_date_arg(args.to_date) if args.to_date else None
    if args.list_only and not to_dt:
        # Bước 1 luôn mặc định quét đến ngày hôm nay để bắt ca Hoàn tất mới.
        to_dt = datetime.now().replace(hour=0, minute=0, second=0, microsecond=0)
        args.to_date = to_dt.strftime("%Y-%m-%d")

    if input_path.exists():
        with open(input_path, encoding="utf-8-sig", newline="") as f:
            patients = list(csv.DictReader(f))
    else:
        patients = []
    contexts = [patient_context(row, i) for i, row in enumerate(patients)]
    invalid_input_contexts = []
    if not args.list_only:
        contexts, invalid_input_contexts = filter_valid_input_contexts(contexts)
        if invalid_input_contexts:
            print(
                f"[0] Bỏ qua {len(invalid_input_contexts)} dòng input không có Mã BN; "
                f"còn {len(contexts)} dòng hợp lệ",
                flush=True,
            )
    if args.list_only:
        print(f"[0] Quét dữ liệu ban đầu từ bảng Hoàn tất; không mở con mắt Điều dưỡng; input {len(contexts)} dòng")
    elif args.patient_info_only:
        print(f"[0] Lấy thông tin khác từ D/s Bệnh nhân; {len(contexts)} dòng đầu vào")
    else:
        if args.project_id == "du_lieu_goc" and input_path.name == "du_lieu_ban_dau.csv":
            print(f"[0] Cập nhật dữ liệu gốc: lấy sâu từ {input_path.name}; {len(contexts)} dòng đang chờ")
        else:
            print(f"[0] {len(contexts)} bệnh nhân/lượt từ {input_path.name}")
        if not from_dt and not to_dt:
            input_dates = [parse_vn_datetime(c.get("T/G vào") or c.get("Ngày vào viện")) for c in contexts]
            input_dates = [d for d in input_dates if d]
            if input_dates:
                from_dt = min(input_dates)
                to_dt = max(input_dates)
                args.from_date = from_dt.strftime("%Y-%m-%d")
                args.to_date = to_dt.strftime("%Y-%m-%d")
                print(f"    Tự đặt khoảng tìm EMR theo T/G vào trong cohort: {args.from_date} → {args.to_date}")

    run_dir = prepare_run(args, script_dir, len(contexts))
    _LOG.open(run_dir)  # Khởi động logger vào action_log.txt trong run_dir
    # Watchdog chống treo im lặng do Chrome/EMR/Selenium đứng.
    # driver chưa có tại thời điểm này nên dùng lambda lấy biến driver về sau.
    log_info(f"Project: {args.project_id}")
    log_info(f"Run dir: {run_dir}")
    log_info(f"Input: {args.input} ({len(contexts)} dòng)")
    mode_label = 'patient_info (Thông tin khác)' if args.patient_info_only else ('list_only (Bước 1)' if args.list_only else 'deep (Bước 3)')
    log_info(f"Chế độ: {mode_label}")
    print(f"    Project: {args.project_id}")
    print(f"    Run dir: {run_dir}")
    if from_dt or to_dt:
        print(f"    Lọc ngày: {args.from_date or '...'} → {args.to_date or '...'}")

    progress = load_progress(run_dir)
    if args.list_only:
        # Dữ liệu gốc giờ chỉ là bảng ban đầu đọc trực tiếp từ danh sách Hoàn tất.
        # Không mở con mắt Điều dưỡng, không lấy XN/CĐHA/thuốc ở bước này.
        ensure_csv(Path(run_dir) / "du_lieu_ban_dau.csv", COL_INITIAL_LIST)
        print(f"    Đã có sẵn: {len(read_csv_rows(Path(run_dir) / 'du_lieu_ban_dau.csv'))} dòng trong du_lieu_ban_dau.csv")
        encounter_code_map, assigned_codes = {}, set()
        allocator = ResearchCodeAllocator([])
    else:
        # mau_nghien_cuu.csv và du_lieu_goc.csv được cập nhật sau khi tìm từng người bệnh
        # và mở màn hình Điều dưỡng.
        ensure_csv(Path(run_dir) / "mau_nghien_cuu.csv", COL_PATIENTS)
        ensure_csv(Path(run_dir) / "du_lieu_goc.csv", COL_PATIENTS)
        existing_master = read_csv_rows(Path(run_dir) / "mau_nghien_cuu.csv") or read_csv_rows(Path(run_dir) / "du_lieu_goc.csv")
        encounter_code_map, assigned_codes = build_visit_code_map(existing_master)
        allocator = ResearchCodeAllocator(existing_master + contexts)
        done_count = sum(1 for key in encounter_code_map.keys() if is_patient_done(progress, key))
        print(f"    Đã xử lý trước: {done_count} lượt điều trị | Danh sách đầu vào: {len(contexts)} Mã BN")

    input_copy_path = Path(run_dir) / "input" / Path(args.input).name
    prune_source_paths = [Path(args.input), input_copy_path]
    if getattr(args, "archive_initial_list", ""):
        prune_source_paths.append(Path(args.archive_initial_list))
    covered_initial_keys = set()

    # Các file kết quả được ghi theo nguyên tắc commit từng ca khi chạy nghiên cứu sâu.
    ensure_csv(Path(run_dir) / "lich_su_xn.csv", COL_XN)
    ensure_csv(Path(run_dir) / "lich_su_cdha.csv", COL_CDHA)
    f_err, w_err = open_csv(Path(run_dir) / ERRORS_FILE, COL_ERRORS)

    driver = wait = None
    watchdog_thread = start_watchdog(run_dir, lambda: driver)
    resource_thread = start_resource_monitor(run_dir)
    ok = skip = 0
    # Mốc restart Chrome: dùng chỉ số dòng input để restart giữa các BN,
    # không restart giữa lúc đang mở popup/đang ghi CSV.
    browser_restart_at_index = 0
    browser_restart_count = 0
    try:
        cfg = load_config(script_dir)
        driver, wait = init_driver(headless=args.headless)
        login(driver, wait, cfg)

        if args.patient_info_only:
            result = run_patient_extra_mode(driver, wait, run_dir, contexts, progress, w_err, f_err)
            write_manifest(run_dir, args, len(contexts))
            print(f"   Output: {run_dir}")
            return 0

        touch_watchdog("Mở danh sách điều trị nội trú")
        vao_noi_tru(driver, wait)
        touch_watchdog("Thiết lập trạng thái Hoàn tất và khoảng ngày")
        chon_hoan_tat(driver, wait, from_dt, to_dt)
        touch_watchdog("Bắt đầu đọc danh sách Hoàn tất")

        if args.list_only:
            result = scan_initial_list_pages(
                driver, wait, run_dir, progress, w_err, f_err,
                from_dt, to_dt,
                stop_at_existing=not args.no_stop_at_existing_initial,
            )
            write_manifest(run_dir, args, result.get("total_rows", 0))
            print(
                f"\n✅ Xong dữ liệu ban đầu! Đã đọc {result.get('seen', 0)} dòng trên danh sách | "
                f"thêm mới {result.get('saved', 0)} | đã có/cập nhật {result.get('updated_or_skipped', 0)} | "
                f"lỗi {result.get('errors', 0)} | tổng lưu {result.get('total_rows', 0)}"
            )
            print(f"   File: {Path(run_dir) / 'du_lieu_ban_dau.csv'}")
            print(f"   Output: {run_dir}")
            return 0

        for i, base_ctx in enumerate(contexts):
            touch_watchdog(f"BN {i + 1}/{len(contexts)}")

            # Recycle Chrome định kỳ hoặc khi RAM Chrome vượt ngưỡng.
            # Làm ở đầu vòng lặp để dữ liệu lượt trước đã commit xong, an toàn resume.
            if i > 0:
                restart_reason = _browser_restart_reason(
                    run_dir,
                    i - browser_restart_at_index,
                    driver=driver,
                    reason_prefix=f"restart_check_before_patient_{i + 1}",
                )
                if restart_reason:
                    save_progress(run_dir, progress)
                    driver, wait = restart_browser_session(
                        driver, args, cfg, run_dir, from_dt, to_dt,
                        mode="deep", reason=restart_reason,
                    )
                    browser_restart_at_index = i
                    browser_restart_count += 1
                    print(f"    ↻ Đã restart Chrome lần {browser_restart_count} — tiếp tục từ BN {i + 1}/{len(contexts)}", flush=True)

            ma_bn = base_ctx.get("Mã BN", "").strip()
            if not ma_bn:
                log_error(w_err, f_err, base_ctx, "BN", "input", "Thiếu Mã BN")
                skip += 1
                continue

            base_initial_key = initial_context_key(base_ctx)
            if base_initial_key and base_initial_key in covered_initial_keys:
                print(f"[{i + 1}/{len(contexts)}] {ma_bn} - {base_ctx.get('Họ tên','')} ↪ bỏ qua: T/G vào đã nằm trong lượt điều trị đã lấy sâu")
                skip += 1
                continue

            print(f"[{i + 1}/{len(contexts)}] {ma_bn} - {base_ctx.get('Họ tên','')}", flush=True)
            if (i + 1) == 1 or (i + 1) % 10 == 0:
                write_resource_snapshot(run_dir, reason=f"patient_{i + 1}")
            touch_watchdog(f"Tìm BN {ma_bn} ({i + 1}/{len(contexts)})")
            try:
                # Chống dừng im lặng ở đầu BN kế tiếp: sau khi đóng popup, EMR đôi lúc
                # vẫn còn state chi tiết/modal nên tim_kiem_benh_nhan kẹt trước khi in FIND.
                if RESEARCH_FORCE_LIST_ON_PATIENT_START:
                    log_info(f"[SAFE] Chuẩn bị tìm BN {ma_bn}: ép mở lại danh sách nội trú")
                    ok_list = force_open_noi_tru_list(
                        driver, wait, from_dt, to_dt,
                        reason=f"trước khi tìm BN {ma_bn} ({i + 1}/{len(contexts)})",
                    )
                    if not ok_list:
                        log_warn(f"[SAFE] Ép danh sách trước BN {ma_bn} chưa chắc chắn — thử ensure_noi_tru_list")
                        ensure_noi_tru_list(driver, wait, from_dt, to_dt)

                # Tìm BN một lần rồi dùng lại các dòng lượt điều trị trong cùng mã BN.
                # Đây là tối ưu tốc độ quan trọng cho deep scan: trước đây dem_luot_benh_nhan()
                # tìm 1 lần, sau đó mỗi visit lại tìm thêm 1 lần nữa.
                rows_for_bn = tim_kiem_benh_nhan(driver, wait, ma_bn, from_dt, to_dt)
            except Exception as e:
                rows_for_bn = []
                log_warn(f"Tìm BN {ma_bn} lỗi: {e}")
                try:
                    dong_popup(driver)
                    ensure_noi_tru_list(driver, wait, from_dt, to_dt)
                except Exception:
                    pass
            visit_count = len(rows_for_bn)
            if visit_count <= 0:
                # Kiểm tra thông minh: nếu BN này đã có dữ liệu XN hoặc CĐHA trong run hiện tại
                # thì đây chỉ là lỗi tìm kiếm tạm thời (EMR filter bị reset, BN đã xuất viện
                # trước khoảng lọc...) — ghi WARN thay vì ERROR và tiếp tục.
                already_has_data = _bn_has_existing_data(run_dir, ma_bn)
                if already_has_data:
                    log_warn(w_err, f_err, base_ctx, "BN", "tìm kiếm",
                             "Không tìm thấy trên danh sách hiện tại nhưng đã có dữ liệu — bỏ qua")
                else:
                    log_error(w_err, f_err, base_ctx, "BN", "tìm kiếm",
                              "Không tìm thấy người bệnh trên danh sách Hoàn tất")
                skip += 1
                continue

            consecutive_popup_failures = 0
            for visit_index in range(visit_count):
                ctx = dict(base_ctx)
                progress_key = f"{ma_bn}|row:{visit_index + 1}"
                try:
                    info = tim_bn_va_mo_popup(
                        driver, wait, ma_bn, row_index=visit_index,
                        from_dt=from_dt, to_dt=to_dt, base_ctx=base_ctx,
                        preloaded_rows=rows_for_bn,
                    )
                    if info is None:
                        consecutive_popup_failures += 1
                        mark_progress(progress, progress_key, "popup", "error", "Không mở được popup")
                        log_error(w_err, f_err, ctx, "Popup", "mở popup", "Không mở được popup Xem KQ/Lịch sử chung")
                        save_progress(run_dir, progress)
                        # Rất quan trọng: khi mở popup thất bại, EMR thường còn ở trang
                        # chi tiết/để lại modal-backdrop. Dọn và phục hồi danh sách ngay
                        # để BN kế tiếp không gặp element not interactable ở txtTimKiem.
                        try:
                            dong_popup(driver)
                            ensure_noi_tru_list(driver, wait, from_dt, to_dt)
                        except Exception as cleanup_err:
                            log_warn(f"Dọn sau lỗi popup thất bại: {cleanup_err}")
                        skip += 1
                        if consecutive_popup_failures >= 2:
                            log_warn(f"Bỏ qua các lượt còn lại của BN {ma_bn} sau {consecutive_popup_failures} lần không mở được popup")
                            break
                        continue

                    merge_non_empty(ctx, info)
                    if info.get("__skip_visit"):
                        print(
                            f"      ↪ Bỏ qua lượt không khớp điều kiện: "
                            f"{ctx.get('Ngày vào viện','') or ctx.get('T/G vào','')} → {ctx.get('Ngày ra viện','')}"
                        )
                        skip += 1
                        continue
                    consecutive_popup_failures = 0
                    if has_visit_filter(base_ctx) and not visit_matches_filter(base_ctx, ctx):
                        print(
                            f"      ↪ Bỏ qua lượt không khớp điều kiện: "
                            f"{ctx.get('Ngày vào viện','')} → {ctx.get('Ngày ra viện','')}"
                        )
                        try:
                            dong_popup(driver)
                        except Exception:
                            pass
                        continue

                    progress_key, research_code, seen_before = assign_research_code_for_visit(
                        ctx, base_ctx, allocator, encounter_code_map, assigned_codes,
                        fallback=f"row:{visit_index + 1}",
                    )
                    upsert_patient_master(run_dir, ctx)

                    if is_patient_done(progress, progress_key):
                        removed_count, removed_keys = prune_redundant_initial_sources(run_dir, ctx, prune_source_paths)
                        covered_initial_keys.update(removed_keys)
                        if removed_count:
                            print(f"      ↪ Đã gộp/xóa {removed_count} dòng ban đầu thuộc cùng lượt điều trị đã lấy")
                        print(f"      ↪ Bỏ qua lượt đã lấy: {ctx.get('Mã NC','')} | {ctx.get('Ngày vào viện','')} → {ctx.get('Ngày ra viện','')}")
                        try:
                            dong_popup(driver)
                        except Exception:
                            pass
                        skip += 1
                        continue

                    item = ensure_patient_progress(progress, progress_key)
                    item["Mã NC"] = ctx.get("Mã NC", "")
                    item["Mã BN"] = ctx.get("Mã BN", "")
                    item["Mã vào viện"] = ctx.get("Mã vào viện", "")
                    item["Mã điều trị"] = ctx.get("Mã điều trị", "")
                    item["Mã nội trú"] = ctx.get("Mã nội trú", "")
                    item["Ngày vào viện"] = ctx.get("Ngày vào viện", "")
                    item["Ngày ra viện"] = ctx.get("Ngày ra viện", "")
                    item["status"] = "running"
                    item["current_index"] = i + 1
                    item["current_visit_index"] = visit_index + 1
                    item["total"] = len(contexts)
                    item["visit_count"] = visit_count
                    item["started_at"] = item.get("started_at") or now_iso()
                    item["updated_at"] = now_iso()
                    save_progress(run_dir, progress)

                    print(
                        f"      Lượt {visit_index + 1}/{visit_count}: {ctx.get('Mã NC','')} | "
                        f"{ctx.get('Ngày vào viện','')} → {ctx.get('Ngày ra viện','')}"
                    , flush=True)
                    touch_watchdog(f"BN {ma_bn} lượt {visit_index + 1}/{visit_count} {ctx.get('Mã NC','')}")
                    case_trace_start(run_dir, ctx, index=i + 1, total=len(contexts), mode="xn_cdha")

                    # Nếu ca này từng bị dừng giữa chừng, xoá dòng cũ của đúng Mã NC/lượt này rồi lấy lại.
                    case_trace_event(
                        "OUTPUT.WRITE_CSV",
                        "Chuẩn bị commit lại case an toàn",
                        screen="run dir",
                        sees="xóa staging/dòng cũ của đúng Mã NC nếu có",
                        takes="research_code + encounter context",
                        writes="staging sạch trước khi lấy XN/CĐHA",
                        target="lich_su_xn.csv, lich_su_cdha.csv",
                    )
                    prepare_patient_commit(run_dir, ctx)
                    rows_by_table = {"xn": [], "cdha": []}

                    mark_progress(progress, progress_key, "popup", "done")
                    save_progress(run_dir, progress)

                    try:
                        touch_watchdog(f"Tab XN {ctx.get('Mã NC','')} | {ctx.get('Mã BN','')}")
                        log_step(f"  → Tab XN: {ctx.get('Mã NC','')} | {ctx.get('Mã BN','')}")
                        case_trace_event(
                            "XN.OPEN",
                            "Mở tab Xét nghiệm trong popup lịch sử chung",
                            screen="Popup Xem KQ/Lịch sử chung → Tab XN",
                            sees=f"Mã NC={ctx.get('Mã NC','')}; Mã BN={ctx.get('Mã BN','')}",
                            takes="bảng lịch sử xét nghiệm",
                            writes="rows_by_table.xn",
                            target="lich_su_xn.csv",
                        )
                        rows_by_table["xn"] = xu_ly_tab_xn(driver, ctx, None, None, from_dt, to_dt)
                        mark_progress(progress, progress_key, "xn", "done")
                        case_trace_event("XN.PARSE_ROWS", "Parse xong tab XN", "Tab XN", f"{len(rows_by_table['xn'])} dòng", "tên xét nghiệm, thời gian, kết quả, đơn vị, khoảng tham chiếu", "rows_by_table.xn", "lich_su_xn.csv")
                        log_ok(f"  Tab XN xong: {len(rows_by_table['xn'])} dòng")
                    except Exception as e:
                        mark_progress(progress, progress_key, "xn", "error", str(e))
                        log_error(w_err, f_err, ctx, "XN", "xử lý tab", e)
                        log_error_raw(f"  Tab XN lỗi: {e}")
                        save_progress(run_dir, progress)
                        raise
                    save_progress(run_dir, progress)

                    try:
                        touch_watchdog(f"Tab CĐHA {ctx.get('Mã NC','')} | {ctx.get('Mã BN','')}")
                        log_step(f"  → Tab CĐHA: {ctx.get('Mã NC','')} | {ctx.get('Mã BN','')}")
                        case_trace_event(
                            "CDHA.OPEN",
                            "Mở tab CĐHA trong popup lịch sử chung",
                            screen="Popup Xem KQ/Lịch sử chung → Tab CĐHA",
                            sees=f"Mã NC={ctx.get('Mã NC','')}; Mã BN={ctx.get('Mã BN','')}",
                            takes="bảng lịch sử CĐHA",
                            writes="rows_by_table.cdha",
                            target="lich_su_cdha.csv",
                        )
                        rows_by_table["cdha"] = xu_ly_tab_cdha(driver, ctx, None, None, from_dt, to_dt)
                        mark_progress(progress, progress_key, "cdha", "done")
                        case_trace_event("CDHA.PARSE_ROWS", "Parse xong tab CĐHA", "Tab CĐHA", f"{len(rows_by_table['cdha'])} dòng", "tên dịch vụ, thời gian, kết quả/mô tả", "rows_by_table.cdha", "lich_su_cdha.csv")
                        log_ok(f"  Tab CĐHA xong: {len(rows_by_table['cdha'])} dòng")
                    except Exception as e:
                        mark_progress(progress, progress_key, "cdha", "error", str(e))
                        log_error(w_err, f_err, ctx, "CĐHA", "xử lý tab", e)
                        log_error_raw(f"  Tab CĐHA lỗi: {e}")
                        save_progress(run_dir, progress)
                        raise
                    save_progress(run_dir, progress)

                    # Commit lượt điều trị vào CSV chính sau khi đã đủ dữ liệu.
                    log_step(f"  → Commit ca {ctx.get('Mã NC','')} | {ctx.get('Mã BN','')} vào CSV")
                    case_trace_event(
                        "OUTPUT.WRITE_CSV",
                        "Commit dữ liệu XN/CĐHA của case vào CSV",
                        screen="run dir",
                        sees=f"XN={len(rows_by_table['xn'])}; CĐHA={len(rows_by_table['cdha'])}",
                        takes="rows_by_table",
                        writes="lich_su_xn.csv + lich_su_cdha.csv",
                        target=str(run_dir),
                    )
                    commit_patient_outputs(run_dir, rows_by_table, ctx)
                    log_ok(f"  Commit xong: XN={len(rows_by_table['xn'])}, CĐHA={len(rows_by_table['cdha'])}")
                    case_trace_finish(run_dir, status="done", counts={"xn": len(rows_by_table["xn"]), "cdha": len(rows_by_table["cdha"])})
                    mark_patient_committed(progress, progress_key, {
                        "xn": len(rows_by_table["xn"]),
                        "cdha": len(rows_by_table["cdha"]),
                    })
                    save_progress(run_dir, progress)

                    removed_count, removed_keys = prune_redundant_initial_sources(run_dir, ctx, prune_source_paths)
                    covered_initial_keys.update(removed_keys)
                    if removed_count:
                        print(f"      ↪ Đã gộp/xóa {removed_count} dòng ban đầu có T/G vào nằm trong {ctx.get('Ngày vào viện','')} → {ctx.get('Ngày ra viện','')}")

                    dong_popup(driver)
                    time.sleep(0.3)
                    ensure_noi_tru_list(driver, wait, from_dt, to_dt)
                    ok += 1

                except KeyboardInterrupt:
                    print("\n⏹ Dừng thủ công. Ca hiện tại chưa commit đủ sẽ được lấy lại ở lần sau.")
                    save_progress(run_dir, progress)
                    raise
                except Exception as e:
                    item = ensure_patient_progress(progress, progress_key)
                    item["status"] = "incomplete"
                    item["committed"] = False
                    err_msg = str(e)
                    # Phân loại: FATAL nếu là lỗi session/driver (cần dừng và cảnh báo ngay)
                    is_fatal = any(kw in err_msg.lower() for kw in [
                        "invalid session id", "no such session", "session deleted",
                        "webdriverexception", "chrome not reachable",
                        "unable to connect", "connection refused",
                    ])
                    if is_fatal:
                        log_fatal(w_err, f_err, ctx, "BN", "vòng xử lý", e)
                        case_trace_finish(run_dir, status="fatal", counts={}, error=str(e))
                        save_progress(run_dir, progress)
                        # Ghi file cảnh báo để server/frontend hiển thị ngay
                        try:
                            alert = {
                                "level": "FATAL",
                                "time": now_iso(),
                                "ma_nc": ctx.get("Mã NC", ""),
                                "ma_bn": ctx.get("Mã BN", ""),
                                "ho_ten": ctx.get("Họ tên", ""),
                                "message": err_msg[:500],
                                "hint": "Session trình duyệt bị mất. Đóng Chrome, khởi động lại và chạy lại để resume.",
                            }
                            alert_path = Path(run_dir) / "fatal_alert.json"
                            with open(alert_path, "w", encoding="utf-8") as _fa:
                                json.dump(alert, _fa, ensure_ascii=False, indent=2)
                        except Exception:
                            pass
                        raise  # dừng toàn bộ — không tiếp tục loop
                    else:
                        log_error(w_err, f_err, ctx, "BN", "vòng xử lý", e)
                        case_trace_finish(run_dir, status="error", counts={}, error=str(e))
                        save_progress(run_dir, progress)
                        try:
                            dong_popup(driver)
                            ensure_noi_tru_list(driver, wait, from_dt, to_dt)
                        except Exception:
                            pass
                        skip += 1

        print(f"\n✅ Xong! Xử lý XN + CĐHA: {ok} | Bỏ qua/lỗi/chưa đủ: {skip}")
        print(f"   Output: {run_dir}")
        return 0

    except KeyboardInterrupt:
        print(f"\n⏹ Dừng thủ công! Tiến độ đã lưu tại {run_dir / PROGRESS_FILE}")
        return 130
    except Exception as e:
        print(f"\n❌ Lỗi: {e}")
        import traceback
        traceback.print_exc()
        return 1
    finally:
        try:
            stop_resource_monitor(run_dir if 'run_dir' in locals() else None)
        except Exception:
            pass
        stop_watchdog()
        for fh in [f_err]:
            try:
                fh.close()
            except Exception:
                pass
        _LOG.close()
        if driver:
            try:
                driver.quit()
            except Exception:
                pass


if __name__ == "__main__":
    raise SystemExit(main())
