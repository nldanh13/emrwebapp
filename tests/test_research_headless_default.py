from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def test_research_backend_defaults_to_headless_unless_explicit_false():
    src = (ROOT / "server" / "routes" / "research.js").read_text(encoding="utf-8")
    assert "function researchHeadlessFromBody" in src
    assert "return parseResearchHeadless(body?.headless, true);" in src
    assert "headless: req.body?.headless === true" not in src
    assert "if (req.body?.headless) args.push('--headless');" not in src


def test_research_ui_starts_in_hidden_mode():
    src = (ROOT / "src" / "components" / "ResearchTab.jsx").read_text(encoding="utf-8")
    assert "{ headless: true, fromDate: '2026-01-01', toDate: todayInputDate() }" in src
    assert "useState({ headless: true })" in src
    assert "Chạy ẩn" in src
