"""Một lượt nhập nghỉ ốm tự động: người dùng chỉ giải CAPTCHA đăng nhập cổng.

Thứ tự: quét Danh sách Khám bệnh (đọc phiếu nghỉ từng ca) → quét người bệnh ra viện (đọc giấy
ra viện) → nạp vào danh sách hồ sơ → nhập thật lên cổng BHXH mọi hồ sơ đọc từ EMR đã đủ dữ liệu.
Ca còn thiếu (vd. thẻ DN chưa hỏi nghỉ ốm) giữ lại để người dùng xử lý, lượt sau nhập tiếp.
Trạng thái lượt chạy giữ ở đây (máy chủ), giao diện chỉ đọc lại.
"""
from __future__ import annotations

import threading
from datetime import date, datetime
from typing import Any

from .emr import parse_day
from .harvest_import import SOURCE_FILE, import_harvest


class AutoRunError(RuntimeError):
    pass


def _now() -> str:
    return datetime.now().isoformat(timespec="seconds")


def _logged_in(site: Any) -> bool:
    try:
        return bool(site.session_status().get("logged_in"))
    except Exception:  # noqa: BLE001 - chưa mở trình duyệt = chưa đăng nhập
        return False


class AutoRunner:
    def __init__(self, emr: Any, portal: Any, worker: Any, store: Any, delay_seconds: float = 1.0):
        self.emr = emr
        self.portal = portal
        self.worker = worker
        self.store = store
        self.delay_seconds = delay_seconds
        self.thread: threading.Thread | None = None
        self._lock = threading.Lock()
        self.state: dict[str, Any] = {"running": False, "phase": "", "message": "", "results": {}}

    def status(self) -> dict[str, Any]:
        return dict(self.state)

    def _set(self, **kw):
        self.state.update(kw, updated_at=_now())

    def start(self, day: Any = None, defaults: dict[str, str] | None = None) -> None:
        if not _logged_in(self.portal):
            raise AutoRunError("Chưa đăng nhập cổng BHXH: nhập mã CAPTCHA rồi bấm Đăng nhập.")
        if not _logged_in(self.emr):
            raise AutoRunError("Chưa đăng nhập EMR nên chưa đọc được giấy. Bấm Đăng nhập lại để đăng nhập EMR.")
        target = parse_day(day)  # ngày sai thì báo ngay, không chạy nửa chừng
        with self._lock:
            if self.thread and self.thread.is_alive():
                raise AutoRunError("Lượt nhập tự động đang chạy.")
            self.thread = threading.Thread(target=self.run, args=(target.isoformat(), defaults), daemon=True)
            self.thread.start()

    def run(self, day: Any = None, defaults: dict[str, str] | None = None) -> None:
        target = parse_day(day)
        results: dict[str, Any] = {}
        self.state = {"running": True, "phase": "", "message": "", "results": results,
                      "day": target.strftime("%d/%m/%Y"), "started_at": _now(), "updated_at": _now()}
        try:
            self._scan_clinic(target, results)
            self._scan_discharges(target, defaults, results)
            self._submit(results)
            self._set(phase="done", message="Xong lượt nhập tự động.")
        except Exception as exc:  # noqa: BLE001 - báo lên giao diện, không làm chết máy chủ
            self._set(phase="error", message=f"Lượt nhập tự động dừng: {exc}", error=str(exc))
        finally:
            self._set(running=False, finished_at=_now())

    def _progress(self, what: str):
        def report(i: int, n: int, name: str):
            self._set(message=f"{what}: ca {i}/{n} · {name}")
        return report

    def _scan_clinic(self, target: date, results: dict[str, Any]) -> None:
        if target != date.today():
            results["clinic"] = {"skipped": "Danh sách khám trên EMR chỉ quét được ngày hôm nay."}
            return
        self._set(phase="clinic", message="Đang quét Danh sách Khám bệnh trên EMR")
        try:
            out = self.emr.harvest_sick_leave(progress=self._progress("Đọc phiếu phòng khám"))
            results["clinic"] = import_harvest(self.store, out, "danh-sach-kham")
        except Exception as exc:  # noqa: BLE001 - lỗi phòng khám không chặn phần ra viện
            results["clinic"] = {"error": str(exc)}

    def _scan_discharges(self, target: date, defaults: dict[str, str] | None,
                         results: dict[str, Any]) -> None:
        self._set(phase="discharge", message="Đang quét người bệnh ra viện trên EMR")
        try:
            out = self.emr.harvest_discharges(day=target.isoformat(), defaults=defaults,
                                              progress=self._progress("Đọc giấy ra viện"))
            results["discharge"] = import_harvest(self.store, out, "danh-sach-ra-vien")
        except Exception as exc:  # noqa: BLE001
            results["discharge"] = {"error": str(exc)}

    def _submit(self, results: dict[str, Any]) -> None:
        ids = [r["id"] for r in self.store.list_records()
               if r["source_file"] == SOURCE_FILE and r["ready"] and r["status"] != "success"]
        if not ids:
            results["submit"] = {"count": 0, "success": 0, "error": 0}
            return
        self._set(phase="submit", message=f"Đang nhập {len(ids)} hồ sơ lên cổng BHXH")
        self.worker.start(ids, dry_run=False, delay_seconds=self.delay_seconds, auto_enrich=False)
        if self.worker.thread:
            self.worker.thread.join()
        statuses = [(self.store.get_record(i) or {}).get("status") for i in ids]
        results["submit"] = {"count": len(ids), "success": statuses.count("success"),
                             "error": statuses.count("error")}
