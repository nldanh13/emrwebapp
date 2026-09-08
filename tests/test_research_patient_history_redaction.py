# -*- coding: utf-8 -*-
"""Regression cho lỗ hổng PHI: /research/archive/patient-history và
/research/archive/variable-catalog trả dữ liệu có định danh (họ tên, lịch sử
điều trị, giá trị mẫu của cột nhạy cảm) cho bất kỳ vai trò researcher nào,
không qua researchResponseShouldRedact như mọi route xuất dữ liệu khác trong
cùng file (server/routes/research.js: /data, /export dùng redactCsvTable).
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_patient_history_route_requires_identified_export_gate():
    source = (ROOT / "server/routes/research.js").read_text(encoding="utf-8")
    start = source.index("router.get('/research/archive/patient-history'")
    end = source.index("router.get('/research/archive/variable-catalog'", start)
    block = source[start:end]

    assert "researchResponseShouldRedact(req)" in block
    assert "err.status = 403" in block
    # Phải kiểm tra và chặn TRƯỚC khi gọi buildPatientHistory (không rò dữ liệu
    # rồi mới từ chối).
    gate_pos = block.index("researchResponseShouldRedact(req)")
    build_pos = block.index("buildPatientHistory(")
    assert gate_pos < build_pos


def test_variable_catalog_route_redacts_sensitive_columns_by_default():
    source = (ROOT / "server/routes/research.js").read_text(encoding="utf-8")
    start = source.index("router.get('/research/archive/variable-catalog'")
    end = source.index("router.get(", start + 1)
    block = source[start:end]

    assert "researchResponseShouldRedact(req)" in block
    assert "buildVariableCatalog(runDir, { redact })" in block


def test_build_variable_catalog_strips_sensitive_columns_when_redacting():
    source = (ROOT / "server/routes/research.js").read_text(encoding="utf-8")
    start = source.index("function buildVariableCatalog(")
    end = source.index("\n}\n", start)
    block = source[start:end]

    assert "redact = true" in block
    assert "isSensitiveColumn(col)" in block
