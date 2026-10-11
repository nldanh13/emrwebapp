"""Nạp các ca gom được từ EMR (phiếu phòng khám, giấy ra viện) vào danh sách hồ sơ."""
from __future__ import annotations

from typing import Any

from .mapping import DOC_BHXH, SICK_LEAVE_QUESTION, Record, validate_fields

SOURCE_FILE = "EMR-phieu"


def import_harvest(store: Any, out: dict[str, Any], sheet: str) -> dict[str, Any]:
    records = []
    for item in out.get("found", []):
        fields = item.get("fields") or {}
        if not fields:
            continue
        rec = Record(doc_type=item.get("doc_type") or DOC_BHXH, source_file=SOURCE_FILE,
                     source_sheet=sheet, source_row=0, fields=fields, raw={})
        rec.issues = validate_fields(rec.doc_type, fields)
        records.append(rec)
    imported = store.import_records(records) if records else {"added": 0, "updated": 0}
    return {
        "scanned": out.get("scanned", 0),
        "working_age": out.get("working_age", 0),
        "found": len(out.get("found", [])),
        # Ca thẻ DN chưa ghi nghỉ ốm: người dùng phải hỏi người bệnh trước khi nhập.
        "ask_sick_leave": sum(1 for rec in records if SICK_LEAVE_QUESTION in rec.issues),
        **imported,
    }
