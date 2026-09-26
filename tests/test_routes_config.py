# -*- coding: utf-8 -*-
"""Model đường dùng duy nhất: config/routes.json.

Worker Python (route_table.py), giao diện (src/config/routes.js) và máy chủ Node
(server/utils/routeModel.js) đều đọc file này — test kiểm cả ba cho kết quả như nhau.
"""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))

import processing.route_table as route_table  # noqa: E402
from processing.route_table import (  # noqa: E402
    detect_route_code, keyword_pattern, mentioned_routes, merge_route_table, normalize_route_code,
)

SAMPLES = [
    ("TTM 40 giọt/phút", "TTM"),
    ("Tiêm truyền tĩnh mạch", "TTM"),
    ("Tiêm TM chậm", "TMC"),
    ("tiêm mạch", "TMC"),
    ("TM", "TMC"),
    ("Tiêm", "TMC"),
    ("Tiêm bắp", "TB"),
    ("TDD", "TDD"),
    ("tiêm dưới da bụng", "TDD"),
    ("Tiêm trong da (test)", "TTD"),
    ("SE 2ml/h", "SE"),
    ("bơm tiêm điện 5 ml/h", "SE"),
    ("Uống sau ăn", "UONG"),
    ("Ngậm dưới lưỡi", "NDL"),
    ("Khí dung", "KHI_DUNG"),
    ("Xịt mũi", "HIT_XIT"),
    ("Nhỏ mắt", "NHO_MAT"),
    ("Bôi ngoài da", "BOI"),
    ("Đặt hậu môn", "DAT_HM"),
    ("dẫn lưu", ""),
]


def _js_eval(expr: str):
    uri = (ROOT / "src/config/routes.js").as_uri()
    script = f"import * as m from {json.dumps(uri)}; console.log(JSON.stringify({expr}));"
    out = subprocess.run(["node", "--input-type=module", "-"], input=script, text=True, cwd=ROOT,
                         check=True, capture_output=True)
    return json.loads(out.stdout.strip())


def _server_eval(expr: str):
    script = f"const m = require('./server/utils/routeModel.js'); console.log(JSON.stringify({expr}));"
    out = subprocess.run(["node", "-e", script], text=True, cwd=ROOT, check=True, capture_output=True)
    return json.loads(out.stdout.strip())


def test_ui_and_server_read_the_same_json():
    data = json.loads((ROOT / "config/routes.json").read_text(encoding="utf-8"))
    # Giao diện khởi động với bảng chuẩn (phần tự cài nạp sau qua /api/routes).
    assert _js_eval("m.getRouteTable()") == merge_route_table(data, {"routes": []})
    assert _js_eval("m.getBaseRouteTable()") == data
    custom = route_table._read_json(route_table.CUSTOM_ROUTES_FILE, {"routes": []})
    assert _server_eval("m.ROUTE_TABLE") == merge_route_table(data, custom)


CUSTOM_SAMPLE = {
    "routes": [
        {"code": "TIEM_KHOP", "label": "Tiêm nội khớp", "short": "Tiêm khớp", "category": "thuoc_tiem",
         "keywords": ["tiêm khớp", "nội khớp"]},
        {"code": "TB", "label": "Tiêm bắp sâu", "keywords": ["mông"]},
        {"code": "KHI_DUNG", "report": "hide"},
    ]
}


def test_merge_and_keywords_same_in_python_and_js():
    data = json.loads((ROOT / "config/routes.json").read_text(encoding="utf-8"))
    core = "const c = require('./src/config/routeModelCore.cjs');"
    script = (f"{core} const base = require('./config/routes.json');"
              f"console.log(JSON.stringify([c.mergeRouteTable(base, {json.dumps(CUSTOM_SAMPLE, ensure_ascii=False)}),"
              f" ['tiêm khớp', 'Nội-khớp', 'a.b (c)', '  '].map(c.keywordPattern)]));")
    out = subprocess.run(["node", "-e", script], text=True, cwd=ROOT, check=True, capture_output=True)
    js_table, js_patterns = json.loads(out.stdout.strip())
    assert js_table == merge_route_table(data, CUSTOM_SAMPLE)
    assert js_patterns == [keyword_pattern(k) for k in ["tiêm khớp", "Nội-khớp", "a.b (c)", "  "]]


def test_custom_routes_apply_to_python_detection(tmp_path, monkeypatch):
    custom_file = tmp_path / "routes.custom.json"
    custom_file.write_text(json.dumps(CUSTOM_SAMPLE, ensure_ascii=False), encoding="utf-8")
    monkeypatch.setattr(route_table, "CUSTOM_ROUTES_FILE", str(custom_file))
    route_table._load_route_table_cached.cache_clear()
    try:
        assert detect_route_code("Tiêm khớp gối (P)") == "TIEM_KHOP"
        assert detect_route_code("tiêm NỘI KHỚP") == "TIEM_KHOP"
        assert detect_route_code("tiêm mông") == "TB"
        assert detect_route_code("TTM 40 giọt/phút") == "TTM"
        assert route_table.route_category("TIEM_KHOP") == "thuoc_tiem"
        assert route_table.route_short("TIEM_KHOP") == "Tiêm khớp"
        assert route_table.route_info("TB")["label"] == "Tiêm bắp sâu"
        assert route_table.route_info("KHI_DUNG")["report"] == "hide"
        assert normalize_route_code("Tiêm khớp") == "TIEM_KHOP"
    finally:
        monkeypatch.undo()
        route_table._load_route_table_cached.cache_clear()
    assert detect_route_code("Tiêm khớp gối") == "TMC"


def test_server_sanitizes_custom_routes():
    script = """
const r = require('./server/routes/route_table.js');
const out = [];
out.push(r.sanitizeCustom({ routes: [{ code: 'tiem_khop', label: ' Tiêm  khớp ', keywords: 'tiêm khớp, nội khớp,, ' }] }));
for (const bad of [
  { routes: [{ code: '1AB', label: 'x' }] },
  { routes: [{ code: 'NEW_ONE' }] },
  { routes: [{ code: 'TB', category: 'khong_co' }] },
  { routes: [{ code: 'TB' }, { code: 'tb' }] },
]) { try { r.sanitizeCustom(bad); out.push('ok'); } catch (e) { out.push('error'); } }
console.log(JSON.stringify(out));
"""
    out = subprocess.run(["node", "-e", script], text=True, cwd=ROOT, check=True, capture_output=True)
    first, *rest = json.loads(out.stdout.strip())
    assert first == {"version": 1, "routes": [{"code": "TIEM_KHOP", "label": "Tiêm khớp", "keywords": ["tiêm khớp", "nội khớp"]}]}
    assert rest == ["error"] * 4


def test_no_route_copies_left():
    """Không còn nơi nào tự khai báo lại bảng đường dùng."""
    assert "drug_routes" not in json.loads((ROOT / "config/order_rules.json").read_text(encoding="utf-8"))
    assert "ROUTE_LABEL_MAP" not in (ROOT / "worker/xu_ly_config.py").read_text(encoding="utf-8")
    assert "ROUTE_FILTERS" not in (ROOT / "src/components/report/reportBaseUtils.js").read_text(encoding="utf-8")


def test_python_detection():
    for text, expected in SAMPLES:
        assert detect_route_code(text) == expected, text


def test_ui_server_python_detect_the_same():
    texts = [t for t, _ in SAMPLES] + ["TMC pha truyền", "tiêm bắp pha NaCl", "(u)", "Đặt", "nhỏ"]
    expr = f"{json.dumps(texts, ensure_ascii=False)}.map(t => [m.detectRouteCode(t), m.mentionedRoutes(t)])"
    py = [[detect_route_code(t), mentioned_routes(t)] for t in texts]
    assert _js_eval(expr) == py
    assert _server_eval(expr) == py


def test_legacy_labels_normalize():
    assert normalize_route_code("U") == "UONG"
    assert normalize_route_code("IV") == "TMC"
    assert normalize_route_code("IM") == "TB"
    assert normalize_route_code("SC") == "TDD"
    assert normalize_route_code("Hít/Xịt") == "HIT_XIT"
    assert normalize_route_code("Uống") == "UONG"
    assert normalize_route_code("TTM") == "TTM"
