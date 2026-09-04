# -*- coding: utf-8 -*-
"""Đọc/ghi JSON an toàn cho worker.

File nghiệp vụ quan trọng không được phép âm thầm biến thành {} hoặc [] khi hỏng.
Nếu parse lỗi, file được đổi tên .corrupt-* và worker dừng để tránh nhập lặp/sai.
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from pathlib import Path
from typing import Any, Optional, Type


class CriticalJsonError(RuntimeError):
    def __init__(self, message: str, *, path: str = "", quarantine_path: str = "") -> None:
        super().__init__(message)
        self.path = path
        self.quarantine_path = quarantine_path


def _stamp() -> str:
    return datetime.now().astimezone().isoformat(timespec="seconds").replace(":", "-")


def read_json_critical(
    path: str | os.PathLike[str],
    fallback_if_missing: Any = None,
    *,
    expected_type: Optional[Type[Any]] = None,
    quarantine: bool = True,
) -> Any:
    p = Path(path)
    if not p.exists():
        return fallback_if_missing
    try:
        with p.open("r", encoding="utf-8") as handle:
            value = json.load(handle)
    except Exception as cause:
        quarantine_path = ""
        if quarantine:
            target = p.with_name(f"{p.name}.corrupt-{_stamp()}")
            try:
                os.replace(p, target)
                quarantine_path = str(target)
            except Exception:
                quarantine_path = ""
        raise CriticalJsonError(
            f"File JSON nghiệp vụ bị hỏng: {p.name}. Worker đã dừng để tránh nhập lặp hoặc sai dữ liệu.",
            path=str(p),
            quarantine_path=quarantine_path,
        ) from cause

    if expected_type is not None and not isinstance(value, expected_type):
        raise CriticalJsonError(
            f"File JSON nghiệp vụ sai kiểu: {p.name}; cần {expected_type.__name__}.",
            path=str(p),
        )
    return value


def read_json_optional(path: str | os.PathLike[str], fallback: Any = None) -> Any:
    try:
        return read_json_critical(path, fallback, quarantine=False)
    except Exception:
        return fallback
