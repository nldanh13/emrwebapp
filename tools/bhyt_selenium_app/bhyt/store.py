from __future__ import annotations

from contextlib import contextmanager
from datetime import datetime
import json
from pathlib import Path
import sqlite3
import threading
from typing import Any, Iterable

from .mapping import Record, validate_fields


class Store:
    def __init__(self, path: str | Path):
        self.path = Path(path)
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self._lock = threading.RLock()
        self._init_db()

    @contextmanager
    def connect(self):
        con = sqlite3.connect(self.path, timeout=30)
        con.row_factory = sqlite3.Row
        try:
            yield con
            con.commit()
        finally:
            con.close()

    def _init_db(self):
        with self.connect() as con:
            con.executescript(
                """
                CREATE TABLE IF NOT EXISTS records (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    record_key TEXT NOT NULL UNIQUE,
                    doc_type TEXT NOT NULL,
                    source_file TEXT NOT NULL,
                    source_sheet TEXT NOT NULL,
                    source_row INTEGER NOT NULL,
                    patient_name TEXT,
                    doctor_name TEXT,
                    fields_json TEXT NOT NULL,
                    raw_json TEXT NOT NULL,
                    issues_json TEXT NOT NULL,
                    status TEXT NOT NULL DEFAULT 'pending',
                    message TEXT NOT NULL DEFAULT '',
                    attempt_count INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS logs (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    record_id INTEGER,
                    level TEXT NOT NULL,
                    message TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(record_id) REFERENCES records(id)
                );
                """
            )

    def import_records(self, records: Iterable[Record]) -> dict[str, int]:
        added = 0
        updated = 0
        now = datetime.now().isoformat(timespec="seconds")
        with self._lock, self.connect() as con:
            for record in records:
                data = record.to_store()
                old = con.execute(
                    "SELECT id, status, fields_json, doc_type FROM records WHERE record_key=?",
                    (data["record_key"],),
                ).fetchone()
                if old:
                    # Keep values the operator supplied locally when the re-imported
                    # workbook still has that field blank (notably Số KCB).
                    old_fields = json.loads(old["fields_json"])
                    new_fields = json.loads(data["fields_json"])
                    for key, value in old_fields.items():
                        if value and not new_fields.get(key):
                            new_fields[key] = value
                    data["fields_json"] = json.dumps(new_fields, ensure_ascii=False)
                    data["issues_json"] = json.dumps(
                        validate_fields(old["doc_type"], new_fields), ensure_ascii=False
                    )
                    data["patient_name"] = new_fields.get("ho_ten", data["patient_name"])
                    data["doctor_name"] = new_fields.get("doctor_text", data["doctor_name"])
                    con.execute(
                        """
                        UPDATE records SET source_file=?, source_sheet=?, source_row=?,
                            patient_name=?, doctor_name=?, fields_json=?, raw_json=?,
                            issues_json=?, updated_at=? WHERE record_key=?
                        """,
                        (
                            data["source_file"], data["source_sheet"], data["source_row"],
                            data["patient_name"], data["doctor_name"], data["fields_json"],
                            data["raw_json"], data["issues_json"], now, data["record_key"],
                        ),
                    )
                    updated += 1
                else:
                    con.execute(
                        """
                        INSERT INTO records (
                            record_key, doc_type, source_file, source_sheet, source_row,
                            patient_name, doctor_name, fields_json, raw_json, issues_json,
                            status, message, created_at, updated_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', '', ?, ?)
                        """,
                        (
                            data["record_key"], data["doc_type"], data["source_file"],
                            data["source_sheet"], data["source_row"], data["patient_name"],
                            data["doctor_name"], data["fields_json"], data["raw_json"],
                            data["issues_json"], now, now,
                        ),
                    )
                    added += 1
        return {"added": added, "updated": updated}

    @staticmethod
    def _decode(row: sqlite3.Row) -> dict[str, Any]:
        item = dict(row)
        item["fields"] = json.loads(item.pop("fields_json"))
        item["raw"] = json.loads(item.pop("raw_json"))
        item["issues"] = json.loads(item.pop("issues_json"))
        item["ready"] = len(item["issues"]) == 0
        return item

    def list_records(self, doc_type: str = "", status: str = "", search: str = "") -> list[dict[str, Any]]:
        query = "SELECT * FROM records WHERE 1=1"
        params: list[Any] = []
        if doc_type:
            query += " AND doc_type=?"
            params.append(doc_type)
        if status:
            query += " AND status=?"
            params.append(status)
        if search:
            query += " AND (patient_name LIKE ? OR doctor_name LIKE ? OR fields_json LIKE ?)"
            term = f"%{search}%"
            params.extend([term, term, term])
        query += " ORDER BY doc_type, source_file, source_row"
        with self.connect() as con:
            return [self._decode(row) for row in con.execute(query, params).fetchall()]

    def get_record(self, record_id: int) -> dict[str, Any] | None:
        with self.connect() as con:
            row = con.execute("SELECT * FROM records WHERE id=?", (record_id,)).fetchone()
            return self._decode(row) if row else None

    def update_fields(self, record_id: int, updates: dict[str, str]):
        with self._lock, self.connect() as con:
            row = con.execute("SELECT doc_type, fields_json FROM records WHERE id=?", (record_id,)).fetchone()
            if not row:
                raise KeyError(record_id)
            fields = json.loads(row["fields_json"])
            fields.update({key: str(value or "").strip() for key, value in updates.items()})
            issues = validate_fields(row["doc_type"], fields)
            con.execute(
                """UPDATE records SET fields_json=?, issues_json=?, patient_name=?,
                    doctor_name=?, updated_at=? WHERE id=?""",
                (
                    json.dumps(fields, ensure_ascii=False),
                    json.dumps(issues, ensure_ascii=False),
                    fields.get("ho_ten", ""),
                    fields.get("doctor_text", ""),
                    datetime.now().isoformat(timespec="seconds"),
                    record_id,
                ),
            )

    def mark(self, record_id: int, status: str, message: str = "", increment_attempt: bool = False):
        now = datetime.now().isoformat(timespec="seconds")
        with self._lock, self.connect() as con:
            extra = ", attempt_count=attempt_count+1" if increment_attempt else ""
            con.execute(
                f"UPDATE records SET status=?, message=?, updated_at=?{extra} WHERE id=?",
                (status, message, now, record_id),
            )
            con.execute(
                "INSERT INTO logs(record_id, level, message, created_at) VALUES (?, ?, ?, ?)",
                (record_id, "error" if status == "error" else "info", f"{status}: {message}", now),
            )

    def reset_status(self, record_ids: Iterable[int]):
        ids = [int(value) for value in record_ids]
        if not ids:
            return
        placeholders = ",".join("?" for _ in ids)
        with self._lock, self.connect() as con:
            con.execute(
                f"UPDATE records SET status='pending', message='', updated_at=? WHERE id IN ({placeholders})",
                [datetime.now().isoformat(timespec="seconds"), *ids],
            )

    def summary(self) -> dict[str, Any]:
        with self.connect() as con:
            rows = con.execute(
                "SELECT doc_type, status, COUNT(*) count FROM records GROUP BY doc_type, status"
            ).fetchall()
            not_ready = con.execute(
                "SELECT COUNT(*) count FROM records WHERE issues_json != '[]'"
            ).fetchone()["count"]
            total = con.execute("SELECT COUNT(*) count FROM records").fetchone()["count"]
        result: dict[str, Any] = {"total": total, "not_ready": not_ready, "by_type": {}}
        for row in rows:
            result["by_type"].setdefault(row["doc_type"], {})[row["status"]] = row["count"]
        return result

    def recent_logs(self, limit: int = 100) -> list[dict[str, Any]]:
        with self.connect() as con:
            rows = con.execute(
                """
                SELECT logs.*, records.patient_name, records.doc_type
                FROM logs LEFT JOIN records ON records.id=logs.record_id
                ORDER BY logs.id DESC LIMIT ?
                """,
                (limit,),
            ).fetchall()
            return [dict(row) for row in rows]
