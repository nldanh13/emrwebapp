# -*- coding: utf-8 -*-
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_research_admission_vitals_selectors_and_pipeline_columns_present():
    worker = (ROOT / "worker" / "hchanh_fetch.py").read_text(encoding="utf-8")
    source = (ROOT / "server" / "research" / "research_source.js").read_text(encoding="utf-8")
    normalize = (ROOT / "server" / "research" / "normalize.js").read_text(encoding="utf-8")
    schema = (ROOT / "server" / "research" / "normalized_schema.js").read_text(encoding="utf-8")

    for selector in [
        "Phiếu vào viện",
        "txtMach",
        "txtNhietDo",
        "txtHuyetApMax",
        "txtHuyetApMin",
        "txtNhipTho",
        "txtCanNang",
        "txtChieuCao",
    ]:
        assert selector in worker

    for column in [
        "Mạch vào viện",
        "Nhiệt độ vào viện",
        "HA tâm thu vào viện",
        "HA tâm trương vào viện",
        "Nhịp thở vào viện",
        "Cân nặng vào viện",
        "Chiều cao vào viện",
    ]:
        assert column in source

    for field in [
        "admission_pulse",
        "admission_temperature",
        "admission_bp_systolic",
        "admission_bp_diastolic",
        "admission_respiratory_rate",
        "admission_weight_kg",
        "admission_height_cm",
    ]:
        assert field in normalize
        assert field in schema


def test_admission_vitals_collection_is_research_only_and_read_only():
    worker = (ROOT / "worker" / "hchanh_fetch.py").read_text(encoding="utf-8")
    fn = worker[worker.index("def _read_research_admission_vitals_by_click"):worker.index("# ── Fetcher: profile")]
    profile = worker[worker.index("def fetch_profile"):]

    assert "research_mode" in profile
    assert "is_research" in profile
    assert "Research key" in profile
    assert "send_keys(" not in fn
    assert ".clear(" not in fn
