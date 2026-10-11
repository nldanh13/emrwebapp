# -*- coding: utf-8 -*-
"""Single-owner, read-only Chrome/HTTP worker for records-check batches.

Protocol is one JSON object per line on stdin/stdout. stdout is reserved for
responses; verbose EMR diagnostics go to stderr. This worker is spawned and owned
by Node on the same host, not exposed as an HTTP endpoint or shared WebDriver.
"""
from __future__ import annotations

import contextlib
import json
import os
from pathlib import Path
import sys
from typing import Any, Dict

# Import the existing safety wrappers, exactly as hchanh_fetch_entry.py does.
import hchanh_fetch_entry  # noqa: F401
import hchanh_fetch as core

_ALLOWED_FILES = frozenset({"discharge", "cls"})
_MAX_RECORDS_PER_REQUEST = 10
_MAX_CHROME_PATIENTS = 30


def _file_in_runtime(value: Any, root: Path) -> str:
    if not isinstance(value, str) or not value or not Path(value).is_absolute():
        raise ValueError("Đường dẫn đầu vào/đầu ra phải tuyệt đối.")
    resolved = Path(value).resolve()
    if not resolved.is_relative_to(root):
        raise ValueError("Không được truy cập dữ liệu ngoài workspace của tác vụ.")
    return str(resolved)


def validate_command(command: Any, runtime_dir: str) -> Dict[str, Any]:
    if not isinstance(command, dict) or command.get("op") != "records_check":
        raise ValueError("Chrome Worker chỉ hỗ trợ đọc dữ liệu kiểm hồ sơ.")
    root = Path(runtime_dir).resolve()
    if not root.is_dir():
        raise ValueError("Workspace không tồn tại.")
    input_path = _file_in_runtime(command.get("input"), root)
    output_path = _file_in_runtime(command.get("output"), root)
    if input_path == output_path:
        raise ValueError("Đầu ra không được trùng đầu vào.")
    if not os.path.isfile(input_path):
        raise ValueError("Không tìm thấy danh sách hồ sơ đầu vào.")
    with open(input_path, encoding="utf-8") as file:
        rows = json.load(file)
    if not isinstance(rows, list) or not 1 <= len(rows) <= _MAX_RECORDS_PER_REQUEST:
        raise ValueError("Một yêu cầu chỉ nhận từ 1 đến 10 hồ sơ.")
    files = command.get("files")
    if not isinstance(files, list) or not files or set(files) - _ALLOWED_FILES:
        raise ValueError("Không hỗ trợ loại dữ liệu yêu cầu.")
    # Only the read-only records-check workflow may use a resident browser.
    if command.get("headless") is not True:
        raise ValueError("Chrome Worker thử nghiệm chỉ chạy ở chế độ headless.")
    if command.get("status") != "Hoàn tất":
        raise ValueError("Chỉ hỗ trợ luồng hồ sơ Hoàn tất.")
    return {
        "input_path": input_path,
        "out_path": output_path,
        "scope": "discharge",
        "files": files,
        "date_from": "",
        "date_to": "",
        "inpatient_status": "Hoàn tất",
        "headless": True,
        # Allow three 10-patient requests to reuse a single Chrome session;
        # existing hchanh code rotates it after the quota is reached.
        "batch_size": _MAX_CHROME_PATIENTS,
        "keep_alive": True,
    }


def run_command(command: Any, runtime_dir: str) -> int:
    opts = validate_command(command, runtime_dir)
    # hchanh_fetch emits operational logs to stdout. Do not let them corrupt
    # the line-based JSON protocol; they are redacted by the Node supervisor.
    with contextlib.redirect_stdout(sys.stderr):
        return int(core.run_hchanh_fetch_batch(**opts))


def serve(runtime_dir: str) -> None:
    if not runtime_dir:
        raise ValueError("WORKER_RUNTIME_DIR is required.")
    root = Path(runtime_dir).resolve()
    if not root.is_dir():
        raise ValueError("WORKER_RUNTIME_DIR must be an existing workspace.")
    try:
        for line in sys.stdin:
            try:
                cmd = json.loads(line)
                request_id = cmd.get("id") if isinstance(cmd, dict) else None
                if not isinstance(request_id, str) or len(request_id) > 80:
                    raise ValueError("Thiếu mã yêu cầu hợp lệ.")
                if cmd.get("op") == "shutdown":
                    break
                code = run_command(cmd, str(root))
                response = {"id": request_id, "code": code}
            except Exception as exc:
                response = {"id": locals().get("request_id"), "code": 1,
                            "error": type(exc).__name__}
                # Do not log raw exception messages: they can contain patient data.
            sys.stdout.write(json.dumps(response, ensure_ascii=True) + "\n")
            sys.stdout.flush()
    finally:
        core._HCHANH_BATCH_HTTP_CACHE.clear()
        core._shutdown_hchanh_click_driver()


if __name__ == "__main__":
    serve(os.environ.get("WORKER_RUNTIME_DIR", ""))
