# -*- coding: utf-8 -*-
"""Ghi tiến trình tác vụ từ Python worker vào task_progress.json của session.

Backend Node vẫn là nơi tổng hợp chính sau khi process kết thúc, nhưng file này
cho phép UI thấy trạng thái gần thời gian thực hơn: running/done/failed theo
ma_bn::ngay_lam trong lúc Selenium đang chạy.
"""
from __future__ import annotations

import json
import os
from datetime import datetime, timezone
from typing import Any, Dict, Optional


def _now_iso() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


def _read_json(path: str) -> Dict[str, Any]:
    try:
        with open(path, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, dict) else {}
    except Exception:
        return {}


def _atomic_write_json(path: str, data: Dict[str, Any]) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    tmp = f"{path}.tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(data, f, ensure_ascii=False, indent=2)
    os.replace(tmp, path)


def progress_path_from_input(input_path: Optional[str]) -> str:
    base = os.path.dirname(os.path.abspath(input_path or __file__))
    return os.path.join(base, "task_progress.json")


def mark_task_status(progress_path: str, task_name: str, key: str, status: str, message: str = "") -> None:
    key = str(key or "").strip()
    task_name = str(task_name or "").strip()
    status = str(status or "").strip() or "running"
    if not key or not task_name:
        return

    progress = _read_json(progress_path)
    task = progress.get(task_name)
    if not isinstance(task, dict):
        task = {}

    at = _now_iso()
    old = task.get(key) if isinstance(task.get(key), dict) else {}
    item = dict(old)
    item["status"] = status
    item["updated_at"] = at
    if status == "running" and not item.get("started_at"):
        item["started_at"] = at
    if status in {"done", "failed", "skipped"}:
        item["finished_at"] = at
    item["last_error"] = "" if status == "done" else str(message or "")
    task[key] = item
    progress[task_name] = task
    _atomic_write_json(progress_path, progress)


def mark_many(progress_path: str, task_name: str, keys: list[str], status: str, message: str = "") -> None:
    for key in keys or []:
        mark_task_status(progress_path, task_name, key, status, message)
