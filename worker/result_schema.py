# -*- coding: utf-8 -*-
"""result_schema.py — Chuẩn hóa result file của các worker nhập EMR.

Tất cả worker nên trả về cùng shape để backend/UI không hiểu nhầm:
- succeeded: list key đã nhập/đã xử lý thành công
- failed: map key -> lỗi thật
- skipped: map key -> lý do bỏ qua hợp lệ, hoặc {'reason': ...} khi toàn job rỗng
- changed: map/list các thay đổi phát hiện được, mặc định rỗng
- warnings: list cảnh báo không chặn xử lý
- summary: thống kê nhanh
"""
from __future__ import annotations

import json
import os
from datetime import datetime
from typing import Any, Dict, Iterable, Mapping, Optional


def _truthy_success(value: Mapping[str, Any]) -> bool:
    return bool(value.get("success"))


def build_worker_result(
    patient_results: Optional[Mapping[str, Mapping[str, Any]]] = None,
    *,
    skipped_reason: str = "",
    skipped: Optional[Any] = None,
    changed: Optional[Any] = None,
    warnings: Optional[Iterable[Any]] = None,
    mode: str = "",
    extra: Optional[Mapping[str, Any]] = None,
) -> Dict[str, Any]:
    rows: Dict[str, Mapping[str, Any]] = {
        str(k): (v or {}) for k, v in (patient_results or {}).items()
        if str(k or "").strip()
    }
    failed = {
        k: str(v.get("error") or "Không rõ lỗi")
        for k, v in rows.items()
        if not _truthy_success(v)
    }
    succeeded = [k for k, v in rows.items() if _truthy_success(v) and not v.get("skipped")]

    skipped_map: Any = {}
    if skipped is not None:
        skipped_map = skipped
    else:
        skipped_items = {
            k: str(v.get("reason") or v.get("message") or "Bỏ qua hợp lệ")
            for k, v in rows.items()
            if _truthy_success(v) and v.get("skipped")
        }
        if skipped_items:
            skipped_map = skipped_items
        elif not rows and skipped_reason:
            skipped_map = {"reason": str(skipped_reason), "patient_count": 0}

    warnings_list = list(warnings or [])
    changed_payload = changed if changed is not None else {}

    result: Dict[str, Any] = {
        "schema_version": "worker-result-v1",
        "updated_at": datetime.now().astimezone().isoformat(timespec="seconds"),
        "succeeded": succeeded,
        "failed": failed,
        "skipped": skipped_map,
        "changed": changed_payload,
        "warnings": warnings_list,
        "summary": {
            "succeeded_count": len(succeeded),
            "failed_count": len(failed),
            "skipped_count": len(skipped_map) if isinstance(skipped_map, dict) and not skipped_map.get("reason") else (1 if skipped_map else 0),
            "warning_count": len(warnings_list),
        },
    }
    if mode:
        result["mode"] = mode
    if extra:
        result.update(dict(extra))
    return result


def write_worker_result(path: str, result: Mapping[str, Any]) -> None:
    os.makedirs(os.path.dirname(os.path.abspath(path)), exist_ok=True)
    with open(path, "w", encoding="utf-8") as f:
        json.dump(dict(result), f, ensure_ascii=False, indent=2)
