# -*- coding: utf-8 -*-
"""Bảng chuẩn đường dùng: config/routes.json (worker) và src/config/routes.js (giao diện) phải khớp nhau."""
from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))

from processing.route_table import detect_route_code, normalize_route_code  # noqa: E402

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


def test_js_table_matches_json():
    data = json.loads((ROOT / "config/routes.json").read_text(encoding="utf-8"))
    js = _js_eval("m.ROUTE_TABLE")
    for key in ("routes", "legacy_aliases", "rules"):
        assert js[key] == data[key], f"src/config/routes.js lệch config/routes.json ở '{key}'"


def test_python_detection():
    for text, expected in SAMPLES:
        assert detect_route_code(text) == expected, text


def test_js_detection_matches_python():
    texts = [t for t, _ in SAMPLES]
    js = _js_eval(f"{json.dumps(texts, ensure_ascii=False)}.map(t => m.detectRouteCode(t))")
    assert js == [detect_route_code(t) for t in texts]


def test_legacy_labels_normalize():
    assert normalize_route_code("U") == "UONG"
    assert normalize_route_code("IV") == "TMC"
    assert normalize_route_code("IM") == "TB"
    assert normalize_route_code("SC") == "TDD"
    assert normalize_route_code("Hít/Xịt") == "HIT_XIT"
    assert normalize_route_code("Uống") == "UONG"
    assert normalize_route_code("TTM") == "TTM"
