# -*- coding: utf-8 -*-
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
WORKER = ROOT / "worker"
if str(WORKER) not in sys.path:
    sys.path.insert(0, str(WORKER))

from processing.rule_engine import detect_drug_category


def test_detect_infusion_by_route_keyword():
    drug = {
        "ten_thuoc": "SODIUM CHLORIDE INJECTION 0,9% 500ml",
        "duong_dung_goc": "Tiêm truyền tĩnh mạch 40g/ph.",
        "toc_do": "40",
        "the_tich": 500,
    }
    assert detect_drug_category(drug) == "dich_truyen"


def test_detect_slow_iv_injection():
    drug = {"ten_thuoc": "CEFOXITIN 1G", "duong_dung_goc": "Tiêm mạch chậm, 8 giờ", "the_tich": 0}
    assert detect_drug_category(drug) == "thuoc_tiem"


def test_detect_oral_and_sublingual():
    assert detect_drug_category({"ten_thuoc": "ESOMEPRAZOL", "duong_dung_goc": "Uống, sáng 1 viên"}) == "thuoc_uong"
    assert detect_drug_category({"ten_thuoc": "TEST", "duong_dung_goc": "Ngậm dưới lưỡi"}) == "thuoc_uong"
