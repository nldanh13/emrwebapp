# -*- coding: utf-8 -*-
"""xlsx_utils.py — Đọc .xlsx bằng stdlib (zipfile + XML), không cần openpyxl.

Tách từ phần "XLSX parser không cần thư viện ngoài" ban đầu chỉ có trong
clinic_outpatient.py, để các script khác (vd parse_bhxh_sick_leave_list.py)
dùng lại được thay vì chép lại logic đọc XML thô.
"""
from __future__ import annotations

import re
import zipfile
from typing import Dict, List, Tuple
from xml.etree import ElementTree as ET

NS = "{http://schemas.openxmlformats.org/spreadsheetml/2006/main}"
REL_NS = "{http://schemas.openxmlformats.org/officeDocument/2006/relationships}"
PKG_REL_NS = "{http://schemas.openxmlformats.org/package/2006/relationships}"


def compact(value) -> str:
    return re.sub(r"\s+", " ", str(value or "")).strip()


def xlsx_col_index(cell_ref: str) -> int:
    m = re.match(r"([A-Z]+)", cell_ref.upper())
    if not m:
        return 0
    n = 0
    for ch in m.group(1):
        n = n * 26 + (ord(ch) - ord("A") + 1)
    return n - 1


def read_shared_strings(zf: zipfile.ZipFile) -> List[str]:
    try:
        raw = zf.read("xl/sharedStrings.xml")
    except KeyError:
        return []
    root = ET.fromstring(raw)
    out: List[str] = []
    for si in root.findall(f"{NS}si"):
        parts = [t.text or "" for t in si.iter(f"{NS}t")]
        out.append("".join(parts))
    return out


def _cell_value(cell: ET.Element, shared: List[str]) -> str:
    cell_type = cell.attrib.get("t", "")
    if cell_type == "inlineStr":
        parts = [t.text or "" for t in cell.iter(f"{NS}t")]
        return "".join(parts)
    v = cell.find(f"{NS}v")
    raw = v.text if v is not None else ""
    if cell_type == "s":
        try:
            return shared[int(raw)]
        except Exception:
            return ""
    return raw or ""


def read_sheet_matrix(zf: zipfile.ZipFile, sheet_path: str, shared: List[str]) -> List[List[str]]:
    root = ET.fromstring(zf.read(sheet_path))
    rows: List[List[str]] = []
    for row in root.iter(f"{NS}row"):
        values: Dict[int, str] = {}
        max_col = -1
        for c in row.findall(f"{NS}c"):
            idx = xlsx_col_index(c.attrib.get("r", ""))
            max_col = max(max_col, idx)
            values[idx] = compact(_cell_value(c, shared))
        if max_col >= 0:
            rows.append([values.get(i, "") for i in range(max_col + 1)])
    return rows


def read_sheet_name_paths(zf: zipfile.ZipFile) -> List[Tuple[str, str]]:
    """Trả về [(tên sheet, đường dẫn sheetN.xml trong zip)] đúng thứ tự khai báo
    trong workbook.xml — tin cậy hơn là đoán theo tên file sheet1.xml/sheet2.xml,
    vì thứ tự đó không được đảm bảo khớp thứ tự tab hiển thị trong Excel."""
    try:
        wb_root = ET.fromstring(zf.read("xl/workbook.xml"))
        rels_root = ET.fromstring(zf.read("xl/_rels/workbook.xml.rels"))
    except KeyError:
        return []

    rid_to_target: Dict[str, str] = {}
    for rel in rels_root.findall(f"{PKG_REL_NS}Relationship"):
        rid = rel.attrib.get("Id", "")
        target = rel.attrib.get("Target", "")
        if rid and target:
            rid_to_target[rid] = target if target.startswith("xl/") else f"xl/{target}"

    out: List[Tuple[str, str]] = []
    sheets_el = wb_root.find(f"{NS}sheets")
    if sheets_el is None:
        return []
    for sheet in sheets_el.findall(f"{NS}sheet"):
        name = sheet.attrib.get("name", "")
        rid = sheet.attrib.get(f"{REL_NS}id", "")
        target = rid_to_target.get(rid, "")
        if name and target:
            out.append((name, target))
    return out


def read_xlsx_sheets_by_name(xlsx_path: str) -> Dict[str, List[List[str]]]:
    """Đọc toàn bộ workbook, trả về {tên sheet: ma trận ô [[cell,...],...]}."""
    with zipfile.ZipFile(xlsx_path, "r") as zf:
        shared = read_shared_strings(zf)
        result: Dict[str, List[List[str]]] = {}
        for name, sheet_path in read_sheet_name_paths(zf):
            try:
                result[name] = read_sheet_matrix(zf, sheet_path, shared)
            except KeyError:
                result[name] = []
        return result
