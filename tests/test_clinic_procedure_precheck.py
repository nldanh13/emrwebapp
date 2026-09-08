# -*- coding: utf-8 -*-
"""Nhập thủ thuật phòng khám phải qua precheck token một lần, giống mọi
route ghi EMR khác (care/infusion/procedure bệnh phòng, chăm sóc phòng khám).
Trước đây /clinic/input-procedures chạy thẳng worker chỉ dựa vào
window.confirm() phía client — không có gì ngăn gọi thẳng API hoặc gửi lại
đúng request cũ nhiều lần.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_clinic_preview_issues_procedure_precheck_token():
    source = (ROOT / "server/routes/clinic.js").read_text(encoding="utf-8")
    start = source.index("router.post('/clinic/preview'")
    end = source.index("router.post('/clinic/input-procedures'", start)
    block = source[start:end]

    assert "clinicProcedurePrecheckTargets(actionRows)" in block
    assert "issueInputPrecheckToken(" in block
    assert "'clinic_input_procedures'" in block
    # Token phải đi kèm dữ liệu preview trả về client, không phát riêng lẻ.
    assert "res.json({ ...data, ...precheck })" in block


def test_clinic_input_procedures_validates_precheck_token_before_running_worker():
    source = (ROOT / "server/routes/clinic.js").read_text(encoding="utf-8")
    start = source.index("router.post('/clinic/input-procedures'")
    end = source.index("router.post(", start + 1)
    block = source[start:end]

    assert "validateAndConsumeInputPrecheckToken(" in block
    assert "'clinic_input_procedures'" in block
    assert "needs_precheck" in block

    token_check_pos = block.index("validateAndConsumeInputPrecheckToken(")
    enqueue_pos = block.index("enqueueHeavy(")
    assert token_check_pos < enqueue_pos, (
        "Phải xác thực token TRƯỚC khi enqueue worker Selenium ghi EMR."
    )


def test_clinic_tab_sends_and_requires_procedure_precheck_token():
    source = (ROOT / "src/components/ClinicTab.jsx").read_text(encoding="utf-8")
    start = source.index("async function inputProcedures")
    end = source.index("\n  }", source.index("setInputLoading(false)", start))
    block = source[start:end]

    assert "result?.precheck_token" in block
    assert "precheck_token: result.precheck_token" in block
