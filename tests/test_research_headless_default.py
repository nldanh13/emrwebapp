from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_research_backend_defaults_to_headless_unless_explicit_false(research_backend_src):
    src = research_backend_src
    assert "function researchHeadlessFromBody" in src
    assert "return parseResearchHeadless(body?.headless, true);" in src
    assert "headless: req.body?.headless === true" not in src
    assert "if (req.body?.headless) args.push('--headless');" not in src


def test_research_ui_uses_headless_default_without_a_toggle(research_ui_src):
    src = research_ui_src
    assert "{ headless: true, fromDate: '2026-01-01', toDate: todayInputDate() }" in src
    assert "useState({ headless: true })" in src
    assert "Chạy ẩn" not in src
    assert "checked={headless}" not in src
