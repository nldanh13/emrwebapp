# -*- coding: utf-8 -*-
"""Regression cho một loạt điểm không đồng nhất phát hiện khi rà soát toàn hệ
thống: audit log thiếu ở vài route ghi/xóa dữ liệu, module.exports nằm giữa
file, đọc/ghi file cấu hình dùng chung bằng fs thô thay vì helper atomic, và
một hàm readJsonSafe bị viết lại trùng với server/utils/file.js.
"""
from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_hchanh_clear_routes_are_audited():
    source = (ROOT / "server/routes/hchanh.js").read_text(encoding="utf-8")
    start = source.index("router.post('/hchanh/clear-patient'")
    end = source.index("router.get('/hchanh/ticket/:ticketId/print'", start)
    block = source[start:end]

    assert "appendActivity(ctx, { kind: 'hchanh.clear_patient'" in block
    assert "appendActivity(ctx, { kind: 'hchanh.clear_all'" in block


def test_hchanh_module_exports_is_at_end_of_file():
    source = (ROOT / "server/routes/hchanh.js").read_text(encoding="utf-8")
    occurrences = [i for i in range(len(source)) if source.startswith("module.exports = router;", i)]
    assert len(occurrences) == 1, "Chỉ nên có một dòng module.exports trong file route."

    tail = source[occurrences[0]:].strip()
    assert tail == "module.exports = router;", (
        "module.exports phải nằm ở cuối file — không có route nào đăng ký sau nó "
        "(trước đây có 4 route bao gồm /hchanh/rescan bị đăng ký sau module.exports)."
    )


def test_vtyt_catalog_uses_atomic_json_helpers_and_logs_mutations():
    source = (ROOT / "server/routes/vtyt_catalog.js").read_text(encoding="utf-8")

    assert "fs.readFileSync" not in source
    assert "fs.writeFileSync" not in source
    assert "readJsonSafe" in source and "writeJsonAtomic" in source

    assert "appendActivity(ctx, { kind: 'vtyt_catalog.update'" in source
    assert "appendActivity(ctx, { kind: 'vtyt_catalog.reset'" in source


def test_care_baseline_reuses_shared_read_json_safe():
    source = (ROOT / "server/routes/care_baseline.js").read_text(encoding="utf-8")
    assert "function readJsonSafe(" not in source, "Không nên định nghĩa lại readJsonSafe cục bộ."
    assert "require('../utils/file')" in source


def test_research_fetch_hchanh_run_is_audited():
    source = (ROOT / "server/routes/research.js").read_text(encoding="utf-8")
    start = source.index("async function fetchHchanhForResearchRun")
    end = source.index("\nfunction ", source.index("\n}\n", start))
    block = source[start:end]

    assert "appendActivity(ctx, {" in block
    assert "workflow.research.fetch_hchanh.start" in block
    assert "workflow.research.fetch_hchanh.finish" in block
