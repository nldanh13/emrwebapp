#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""Build an atomic SQLite database from research CSV outputs.

The script only uses the Python standard library so the dashboard does not need
an additional npm or pip dependency.
"""

from __future__ import annotations

import argparse
import csv
import datetime as dt
import hashlib
import json
import os
import re
import sqlite3
import sys
import unicodedata
from pathlib import Path
from typing import Any, Dict, Iterable, List, Sequence, Tuple

DB_SCHEMA_VERSION = 1

TEXT_HINTS = {
    "patient_code", "research_code", "encounter_id", "row_hash", "source_run_id",
    "patient_name", "phone_number", "citizen_id", "insurance_card", "icd_code",
    "emr_admission_id", "emr_treatment_id", "emr_noitru_id", "lab_result_id",
    "imaging_id", "surgery_id", "med_order_id", "note_id", "diagnosis_id",
}
INTEGER_HINTS = {
    "age", "birth_year", "encounter_count", "times_per_day", "postop_day_index",
    "hospital_day", "has_lab", "lab_count", "has_imaging", "imaging_count",
    "has_surgery", "surgery_count", "has_medication", "medication_count",
    "ready_for_analysis", "drug_count", "column_count", "row_count",
}
REAL_HINTS = {
    "result_num", "days_from_admission", "days_from_surgery", "days_from_discharge",
    "hospital_stay_days", "time_to_surgery_hours", "treatment_duration",
    "hb", "hct", "neutrophil", "lymphocyte", "monocyte", "rdw", "plt",
    "creatinine", "egfr", "wbc", "crp",
}
DATE_TOKENS = ("date", "datetime", "time", "ngay", "thoi_gian", "tg_")
ID_TOKENS = ("_id", "code", "ma_", "so_", "phone", "card", "hash")
INDEX_COLUMNS = {
    "patient_code", "research_code", "encounter_id", "source_run_id", "row_hash",
    "admission_date", "discharge_date", "surgery_date", "lab_date", "order_date",
    "note_date", "date", "overall_status", "ready_for_analysis",
}


def now_iso() -> str:
    return dt.datetime.now(dt.timezone.utc).isoformat(timespec="seconds")


def strip_marks(value: str) -> str:
    normalized = unicodedata.normalize("NFD", str(value or ""))
    return "".join(ch for ch in normalized if unicodedata.category(ch) != "Mn").replace("đ", "d").replace("Đ", "D")


def safe_identifier(value: str, fallback: str = "column") -> str:
    raw = strip_marks(value).lower()
    raw = re.sub(r"[^a-z0-9_]+", "_", raw)
    raw = re.sub(r"_+", "_", raw).strip("_")
    if not raw:
        raw = fallback
    if raw[0].isdigit():
        raw = f"c_{raw}"
    return raw[:120]


def unique_identifiers(columns: Sequence[str]) -> Tuple[List[str], Dict[str, str]]:
    used: Dict[str, int] = {}
    db_columns: List[str] = []
    mapping: Dict[str, str] = {}
    for index, original in enumerate(columns):
        base = safe_identifier(original, f"column_{index + 1}")
        count = used.get(base, 0) + 1
        used[base] = count
        name = base if count == 1 else f"{base}_{count}"
        db_columns.append(name)
        mapping[str(original)] = name
    return db_columns, mapping


def quote_identifier(value: str) -> str:
    return '"' + str(value).replace('"', '""') + '"'


def read_csv_file(file_path: Path) -> Tuple[List[str], List[Dict[str, str]]]:
    with file_path.open("r", encoding="utf-8-sig", newline="") as handle:
        reader = csv.DictReader(handle)
        columns = list(reader.fieldnames or [])
        rows: List[Dict[str, str]] = []
        for row in reader:
            rows.append({str(key): ("" if value is None else str(value)) for key, value in row.items() if key is not None})
    return columns, rows


def is_int(value: str) -> bool:
    return bool(re.fullmatch(r"[-+]?\d+", value.strip()))


def is_float(value: str) -> bool:
    return bool(re.fullmatch(r"[-+]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][-+]?\d+)?", value.strip()))


def infer_sql_type(column: str, values: Iterable[str]) -> str:
    name = safe_identifier(column)
    if name in TEXT_HINTS or any(token in name for token in ID_TOKENS) or any(token in name for token in DATE_TOKENS):
        return "TEXT"
    if name in INTEGER_HINTS:
        return "INTEGER"
    if name in REAL_HINTS:
        return "REAL"
    non_empty = [str(value).strip() for value in values if str(value).strip()]
    if not non_empty:
        return "TEXT"
    sample = non_empty[:2000]
    if all(is_int(value) for value in sample):
        return "INTEGER"
    if all(is_float(value) for value in sample):
        return "REAL"
    return "TEXT"


def convert_value(value: Any, sql_type: str) -> Any:
    raw = "" if value is None else str(value).strip()
    if not raw:
        return None
    if sql_type == "INTEGER":
        try:
            return int(raw)
        except ValueError:
            return raw
    if sql_type == "REAL":
        try:
            return float(raw)
        except ValueError:
            return raw
    return raw


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def create_indexes(conn: sqlite3.Connection, table_name: str, db_columns: Sequence[str]) -> None:
    columns = set(db_columns)
    for column in sorted(columns & INDEX_COLUMNS):
        index_name = safe_identifier(f"idx_{table_name}_{column}")
        conn.execute(
            f"CREATE INDEX IF NOT EXISTS {quote_identifier(index_name)} "
            f"ON {quote_identifier(table_name)} ({quote_identifier(column)})"
        )
    if "patient_code" in columns and "encounter_id" in columns:
        index_name = safe_identifier(f"idx_{table_name}_patient_encounter")
        conn.execute(
            f"CREATE INDEX IF NOT EXISTS {quote_identifier(index_name)} "
            f"ON {quote_identifier(table_name)} ({quote_identifier('patient_code')}, {quote_identifier('encounter_id')})"
        )


def create_views(conn: sqlite3.Connection, table_names: Sequence[str]) -> List[str]:
    tables = set(table_names)
    created: List[str] = []
    conn.execute("DROP VIEW IF EXISTS v_analysis_dataset")
    analysis_source = next((name for name in ("analysis_final", "analysis_selected", "analysis_ready") if name in tables), "")
    if analysis_source:
        conn.execute(f"CREATE VIEW v_analysis_dataset AS SELECT * FROM {quote_identifier(analysis_source)}")
        created.append("v_analysis_dataset")

    conn.execute("DROP VIEW IF EXISTS v_encounter_summary")
    if "encounters" in tables and "patients" in tables:
        lab_expr = "(SELECT COUNT(*) FROM lab_results l WHERE l.encounter_id = e.encounter_id)" if "lab_results" in tables else "0"
        imaging_expr = "(SELECT COUNT(*) FROM imaging_results i WHERE i.encounter_id = e.encounter_id)" if "imaging_results" in tables else "0"
        surgery_expr = "(SELECT COUNT(*) FROM surgery_results s WHERE s.encounter_id = e.encounter_id)" if "surgery_results" in tables else "0"
        medication_expr = "(SELECT COUNT(*) FROM medication_orders m WHERE m.encounter_id = e.encounter_id)" if "medication_orders" in tables else "0"
        patient_columns = {row[1] for row in conn.execute("PRAGMA table_info(patients)").fetchall()}
        optional_patient_fields = [name for name in ("patient_name", "sex", "birth_year", "age") if name in patient_columns]
        patient_select = ", ".join(f"p.{quote_identifier(name)} AS {quote_identifier(name)}" for name in optional_patient_fields)
        if patient_select:
            patient_select += ", "
        conn.execute(
            "CREATE VIEW v_encounter_summary AS "
            f"SELECT e.*, {patient_select}"
            f"{lab_expr} AS lab_count_db, "
            f"{imaging_expr} AS imaging_count_db, "
            f"{surgery_expr} AS surgery_count_db, "
            f"{medication_expr} AS medication_count_db "
            "FROM encounters e LEFT JOIN patients p ON p.patient_code = e.patient_code"
        )
        created.append("v_encounter_summary")
    return created


def build_database(request: Dict[str, Any]) -> Dict[str, Any]:
    database_path = Path(str(request.get("database_path") or "")).resolve()
    if not database_path.name:
        raise ValueError("Thiếu database_path")
    database_path.parent.mkdir(parents=True, exist_ok=True)
    temp_path = database_path.with_suffix(database_path.suffix + f".tmp.{os.getpid()}")
    if temp_path.exists():
        temp_path.unlink()

    tables = request.get("tables") if isinstance(request.get("tables"), list) else []
    loaded_at = now_iso()
    table_manifest: List[Dict[str, Any]] = []
    created_table_names: List[str] = []

    conn = sqlite3.connect(str(temp_path))
    try:
        conn.execute("PRAGMA journal_mode=DELETE")
        conn.execute("PRAGMA synchronous=FULL")
        conn.execute("PRAGMA temp_store=MEMORY")
        conn.execute("PRAGMA foreign_keys=OFF")
        conn.execute("BEGIN IMMEDIATE")
        conn.execute("CREATE TABLE research_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)")
        conn.execute(
            "CREATE TABLE table_manifest ("
            "table_name TEXT PRIMARY KEY, source_file TEXT NOT NULL, row_count INTEGER NOT NULL, "
            "column_count INTEGER NOT NULL, columns_json TEXT NOT NULL, source_sha256 TEXT NOT NULL, loaded_at TEXT NOT NULL)"
        )
        conn.execute(
            "CREATE TABLE column_manifest ("
            "table_name TEXT NOT NULL, ordinal INTEGER NOT NULL, original_name TEXT NOT NULL, "
            "database_name TEXT NOT NULL, sqlite_type TEXT NOT NULL, "
            "PRIMARY KEY (table_name, ordinal))"
        )

        meta = {
            "database_schema_version": str(DB_SCHEMA_VERSION),
            "normalized_schema_version": str(request.get("normalized_schema_version") or ""),
            "dataset_id": str(request.get("dataset_id") or ""),
            "dataset_type": str(request.get("dataset_type") or ""),
            "run_id": str(request.get("run_id") or ""),
            "input_signature": str(request.get("input_signature") or ""),
            "loaded_at": loaded_at,
            "identified_data": "1",
        }
        conn.executemany("INSERT INTO research_meta(key, value) VALUES (?, ?)", list(meta.items()))

        for spec in tables:
            if not isinstance(spec, dict):
                continue
            source_path = Path(str(spec.get("file_path") or "")).resolve()
            if not source_path.is_file():
                continue
            table_name = safe_identifier(str(spec.get("table_name") or source_path.stem), "research_table")
            columns, rows = read_csv_file(source_path)
            if not columns:
                continue
            db_columns, mapping = unique_identifiers(columns)
            types: List[str] = []
            for original in columns:
                types.append(infer_sql_type(mapping[original], (row.get(original, "") for row in rows)))

            definitions = ["_row_id INTEGER PRIMARY KEY AUTOINCREMENT"]
            definitions.extend(
                f"{quote_identifier(db_name)} {sql_type}"
                for db_name, sql_type in zip(db_columns, types)
            )
            conn.execute(f"CREATE TABLE {quote_identifier(table_name)} ({', '.join(definitions)})")

            placeholders = ", ".join("?" for _ in db_columns)
            insert_sql = (
                f"INSERT INTO {quote_identifier(table_name)} "
                f"({', '.join(quote_identifier(name) for name in db_columns)}) VALUES ({placeholders})"
            )
            batch: List[Tuple[Any, ...]] = []
            for row in rows:
                batch.append(tuple(convert_value(row.get(original, ""), sql_type) for original, sql_type in zip(columns, types)))
                if len(batch) >= 1000:
                    conn.executemany(insert_sql, batch)
                    batch.clear()
            if batch:
                conn.executemany(insert_sql, batch)

            create_indexes(conn, table_name, db_columns)
            conn.executemany(
                "INSERT INTO column_manifest(table_name, ordinal, original_name, database_name, sqlite_type) VALUES (?, ?, ?, ?, ?)",
                [(table_name, idx + 1, original, db_name, sql_type) for idx, (original, db_name, sql_type) in enumerate(zip(columns, db_columns, types))],
            )
            source_hash = file_sha256(source_path)
            manifest_row = {
                "table_name": table_name,
                "source_file": str(spec.get("source_file") or source_path.name),
                "row_count": len(rows),
                "column_count": len(columns),
                "columns": [
                    {"original": original, "database": db_name, "type": sql_type}
                    for original, db_name, sql_type in zip(columns, db_columns, types)
                ],
                "source_sha256": source_hash,
            }
            table_manifest.append(manifest_row)
            created_table_names.append(table_name)
            conn.execute(
                "INSERT INTO table_manifest(table_name, source_file, row_count, column_count, columns_json, source_sha256, loaded_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?)",
                (table_name, manifest_row["source_file"], len(rows), len(columns), json.dumps(manifest_row["columns"], ensure_ascii=False), source_hash, loaded_at),
            )

        views = create_views(conn, created_table_names)
        conn.commit()
        conn.execute("PRAGMA optimize")
        conn.close()
        try:
            os.replace(temp_path, database_path)
        except PermissionError as exc:
            raise RuntimeError(
                "Không thể cập nhật research.sqlite3 vì file đang được chương trình khác mở. "
                "Hãy đóng DB Browser/Excel/Python đang dùng file rồi chuẩn hóa lại."
            ) from exc
        try:
            os.chmod(database_path, 0o600)
            os.chmod(database_path.parent, 0o700)
        except OSError:
            pass
    except Exception:
        try:
            conn.rollback()
        except Exception:
            pass
        try:
            conn.close()
        except Exception:
            pass
        try:
            temp_path.unlink()
        except OSError:
            pass
        raise

    result = {
        "status": "ok",
        "database_path": str(database_path),
        "database_file": database_path.name,
        "dataset_id": str(request.get("dataset_id") or ""),
        "dataset_type": str(request.get("dataset_type") or ""),
        "run_id": str(request.get("run_id") or ""),
        "input_signature": str(request.get("input_signature") or ""),
        "normalized_schema_version": request.get("normalized_schema_version"),
        "database_schema_version": DB_SCHEMA_VERSION,
        "loaded_at": loaded_at,
        "size_bytes": database_path.stat().st_size,
        "identified_data": True,
        "tables": table_manifest,
        "views": views,
    }
    manifest_path = Path(str(request.get("manifest_path") or f"{database_path}.manifest.json"))
    manifest_path.write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    try:
        os.chmod(manifest_path, 0o600)
    except OSError:
        pass
    return result



def _table_columns(conn: sqlite3.Connection, table_name: str) -> List[str]:
    return [str(row[1]) for row in conn.execute(f"PRAGMA table_info({quote_identifier(table_name)})").fetchall()]


def query_database(request: Dict[str, Any]) -> Dict[str, Any]:
    """Read-only batched SELECT used by the dashboard.

    Each query:
      {
        "name": "labs",
        "table": "lab_results",
        "where_any": {
          "patient_code": ["260..."],
          "research_code": ["NC..."],
          "encounter_id": ["enc_..."]
        },
        "limit": 50000
      }

    Identifiers are validated against the actual SQLite schema and values are
    always bound parameters; no arbitrary SQL is accepted from HTTP callers.
    """
    database_path = Path(str(request.get("database_path") or "")).resolve()
    if not database_path.is_file():
        raise FileNotFoundError(f"Không tìm thấy SQLite: {database_path}")

    queries = request.get("queries") if isinstance(request.get("queries"), list) else []
    uri = f"file:{database_path.as_posix()}?mode=ro"
    conn = sqlite3.connect(uri, uri=True)
    conn.row_factory = sqlite3.Row
    try:
        table_names = {
            str(row[0])
            for row in conn.execute(
                "SELECT name FROM sqlite_master WHERE type IN ('table','view')"
            ).fetchall()
        }
        results: Dict[str, Any] = {}
        for idx, spec in enumerate(queries):
            if not isinstance(spec, dict):
                continue
            name = str(spec.get("name") or f"q{idx + 1}")
            table = safe_identifier(str(spec.get("table") or ""))
            if not table or table not in table_names:
                results[name] = {"rows": [], "count": 0, "table": table, "missing": True}
                continue

            columns = _table_columns(conn, table)
            column_set = set(columns)
            where_any = spec.get("where_any") if isinstance(spec.get("where_any"), dict) else {}
            requested_filter_values = any(
                any(v is not None and str(v).strip() != "" for v in (raw if isinstance(raw, list) else [raw]))
                for raw in where_any.values()
            )
            clauses: List[str] = []
            params: List[Any] = []
            for raw_col, raw_values in where_any.items():
                col = safe_identifier(str(raw_col or ""))
                if col not in column_set:
                    continue
                values = raw_values if isinstance(raw_values, list) else [raw_values]
                values = [v for v in values if v is not None and str(v).strip() != ""]
                if not values:
                    continue
                # Chunk IN() lists to stay below SQLite parameter limits.
                chunks = [values[i:i + 300] for i in range(0, len(values), 300)]
                sub = []
                for chunk in chunks:
                    sub.append(
                        f"{quote_identifier(col)} IN ({','.join('?' for _ in chunk)})"
                    )
                    params.extend(chunk)
                clauses.append("(" + " OR ".join(sub) + ")")

            # Nếu caller yêu cầu lọc nhưng bảng không có bất kỳ cột lọc phù hợp,
            # trả rỗng. Không được SELECT toàn bảng vì vừa chậm vừa có thể trả JSON khổng lồ.
            if requested_filter_values and not clauses:
                results[name] = {
                    "rows": [],
                    "count": 0,
                    "table": table,
                    "missing": False,
                    "filter_columns_missing": True,
                }
                continue

            where_sql = (" WHERE " + " OR ".join(clauses)) if clauses else ""
            try:
                limit = int(spec.get("limit") or 50000)
            except Exception:
                limit = 50000
            limit = max(1, min(limit, 100000))

            sql = f"SELECT * FROM {quote_identifier(table)}{where_sql} LIMIT ?"
            params.append(limit)
            rows = [dict(row) for row in conn.execute(sql, params).fetchall()]
            # Preserve frontend convention: blanks are strings rather than null.
            clean_rows = [
                {str(k): ("" if v is None else v) for k, v in row.items() if k != "_row_id"}
                for row in rows
            ]
            results[name] = {
                "rows": clean_rows,
                "count": len(clean_rows),
                "table": table,
                "missing": False,
            }

        return {
            "status": "ok",
            "action": "query",
            "database_path": str(database_path),
            "results": results,
        }
    finally:
        conn.close()



def main(argv: Sequence[str] | None = None) -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--request", required=True)
    args = parser.parse_args(argv)
    request_path = Path(args.request)
    request = json.loads(request_path.read_text(encoding="utf-8"))
    action = str(request.get('action') or 'build').strip().lower()
    result = query_database(request) if action == 'query' else build_database(request)
    sys.stdout.write(json.dumps(result, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
