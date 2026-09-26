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

from processing.route_table import detect_route_code, mentioned_routes, normalize_route_code  # noqa: E402

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
    assert _js_eval("m.ROUTE_TABLE") == data
    assert _server_eval("m.ROUTE_TABLE") == data


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
