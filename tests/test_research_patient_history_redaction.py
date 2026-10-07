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


def test_patient_history_route_requires_identified_export_gate(research_backend_src):
    source = research_backend_src
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


def test_variable_catalog_route_redacts_sensitive_columns_by_default(research_backend_src):
    source = research_backend_src
    start = source.index("router.get('/research/archive/variable-catalog'")
    end = source.index("router.get(", start + 1)
    block = source[start:end]

    assert "researchResponseShouldRedact(req)" in block
    assert "buildVariableCatalog(runDir, { redact })" in block


def test_build_variable_catalog_strips_sensitive_columns_when_redacting(research_backend_src):
    source = research_backend_src
    start = source.index("function buildVariableCatalog(")
    end = source.index("\n}\n", start)
    block = source[start:end]

    assert "redact = true" in block
    assert "isSensitiveColumn(col)" in block


def test_collection_operational_screen_keeps_patient_code_but_export_policy_stays_redacted():
    source = (ROOT / "server" / "routes" / "research_collection.js").read_text(encoding="utf-8")
    start = source.index("function handleCollectionScreen")
    end = source.index("function handleCollectionExceptionsExport", start)
    screen = source[start:end]

    # Màn vận hành phải giữ Mã BN/Mã NB để tra ngược EMR khi xử lý ngoại lệ.
    assert "patient_code: r.patient_code ? '[đã che]'" not in screen
    assert "ma_bn: ''" not in screen
    # Họ tên vẫn được che ở chế độ mặc định.
    assert "patient_name: ''" in screen
    assert "ho_ten: ''" in screen

    # File export nghiên cứu vẫn phải đi qua gate/redaction cũ.
    export = source[end:source.index("lockedResearchRoute", end)]
    assert "researchResponseShouldRedact(req)" in export
    assert "sendCsvFile" in export
    assert "{ redact: researchResponseShouldRedact(req) }" in export


def test_collection_operational_status_preserves_patient_code_only_for_on_screen_rows():
    source = (ROOT / "server" / "routes" / "research_collection.js").read_text(encoding="utf-8")
    start = source.index("function handleCollectionStatus")
    end = source.index("function handleCollectionScreen", start)
    block = source[start:end]
    assert "keepPatientCode: true" in block
