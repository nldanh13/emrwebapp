# -*- coding: utf-8 -*-
"""Regression tests for completed EMR slips -> processing. Fictional input only."""
from processing.structured_order_adapter import (
    build_classification_text, extract_structured_source,
)
from processing.patient_day_builder import build_patient_day_records


def _form(form_id="form-a", drug="Nefopam 20mg/2ml", qty="2.00"):
    return {
        "id": form_id,
        "so_phieu": "999101",
        "ngay_y_lenh": "16/10/2026",
        "ngay_lam": "16/10/2026",
        "gio_y_lenh": "05:00 16/10/2026",
        "thoi_gian_chi_dinh": "05:00 16/10/2026",
        "bac_si": "Bác sĩ A",
        "trang_thai_y_lenh": "Hoàn tất",
        "dien_bien_benh": "Dự trù thuốc",
        "thuoc": [{
            "id": "drug-" + form_id,
            "ten_duoc": drug, "so_luong": qty,
            "don_vi": "Ống", "ham_luong": "20mg/2ml",
            "duong_dung": "Tiêm",
            "cach_dung": "Pha Natri clorid 0,9% 100ml TTM 30 g/ph (8 giờ, 20 giờ)",
            "thuoc_pha": "Natri clorid 0,9%",
            "trang_thai_thuoc": "Chưa hoàn tất",
        }],
        "vat_tu_y_te": [{
            "id": "supply-" + form_id,
            "ten_vat_tu": "Bơm tiêm vô trùng 10ml",
            "so_luong": "2.00", "don_vi": "Cái",
            "trang_thai_vat_tu": "Chờ tổng hợp",
            "nguoi_benh_tu_tra": True,
        }],
        "y_lenh_khac": "Mời hội chẩn",
        "y_lenh_khac_muc": ["Mời hội chẩn"],
        "chi_dinh_khac": {
            "dich_vu_ky_thuat": {
                "bang": [{
                    "cot": ["STT", "Thời gian chỉ định", "Thông tin chỉ định (1)", "Trạng thái"],
                    "dong": [
                        {"id": "", "gia_tri": ["Thủ thuật (1)"]},
                        {"id": "svc-" + form_id,
                         "gia_tri": ["1", "05:00 16/10/2026", "Thay băng vết thương", "Chờ thực hiện"]},
                    ],
                }],
                "noi_dung": "",
            }
        },
    }


def test_adapter_keeps_medicines_separate_from_vtyt_and_services():
    form = _form()
    text = build_classification_text([form])
    assert "Nefopam 20mg/2ml" in text
    assert "TTM" in text
    assert "Thuốc pha: Natri clorid" in text
    assert "Bơm tiêm" not in text
    assert "+ Chỉ định DVKT:\n- Thay băng vết thương" in text
    assert "Mời hội chẩn" in text
    assert "05:00 | Bác sĩ: Bác sĩ A" in text


def test_preserves_original_service_status_and_supply_by_ticket():
    form = _form()
    source = extract_structured_source({"order_history": [form, form]})
    assert source["order_count"] == 1
    assert len(source["medications"]) == 1
    assert source["medications"][0]["trang_thai_thuoc"] == "Chưa hoàn tất"
    assert len(source["supplies"]) == 1
    assert source["supplies"][0]["trang_thai_vat_tu"] == "Chờ tổng hợp"
    assert source["services"][0]["ten"] == "Thay băng vết thương"
    assert source["services"][0]["trang_thai"] == "Chờ thực hiện"
    assert source["services"][0]["so_phieu"] == "999101"
    assert source["other_orders"][0]["noi_dung"] == "Mời hội chẩn"


def test_structured_forms_never_classify_syringes_as_drugs():
    item = {
        "ma_bn": "TEST_001", "ho_ten": "BỆNH NHÂN THỬ",
        "bac_si": "Bác sĩ A", "ngay_lam": "16/10/2026", "Vi_Tri": "P99",
        "Y lệnh": "+ Thuốc:\nBơm tiêm vô trùng 10ml x 2 (Cái)\n"
                  "Nefopam 20mg/2ml x 2 (Ống) | TTM 30 g/ph (8 giờ, 20 giờ)",
        "Diễn biến": "Dự trù thuốc",
        "order_history": [_form()],
    }
    out = build_patient_day_records([item])
    assert len(out) == 1
    classified = out[0]
    source = classified["emr_order_source"]
    assert len(source["medications"]) == 1
    assert len(source["supplies"]) == 1
    assert source["medications"][0]["trang_thai_thuoc"] == "Chưa hoàn tất"
    assert source["supplies"][0]["trang_thai_vat_tu"] == "Chờ tổng hợp"
    # Original EMR VTYT must not be mistaken for a medication.
    drugs = classified.get("thuoc") or {}
    names = [
        str(d.get("ten_thuoc") or d.get("ten_hien_thi") or "")
        for bucket in drugs.values() if isinstance(bucket, list)
        for d in bucket if isinstance(d, dict)
    ]
    assert not any("Bơm tiêm vô trùng" in name for name in names)
    assert any("Nefopam" in name for name in names)
    assert classified["ngay_lam"] == "16/10/2026"


def test_old_order_text_is_untouched():
    legacy = {
        "ma_bn": "TEST_OLD", "ho_ten": "BỆNH NHÂN THỬ",
        "bac_si": "Bác sĩ B", "ngay_lam": "16/10/2026",
        "Y lệnh": "+ Thuốc:\nParacetamol 500mg x 1 (Viên)\nUống 8 giờ",
        "Diễn biến": "",
    }
    assert extract_structured_source(legacy) is None
    assert "Paracetamol" in legacy["Y lệnh"]
    out = build_patient_day_records([legacy])
    assert len(out) == 1
    assert "emr_order_source" not in out[0]


def test_same_medication_on_distinct_slips_keeps_both_provenances():
    f1, f2 = _form("a"), _form("b")
    f2["so_phieu"] = "999102"
    source = extract_structured_source({"order_history": [f1, f2]})
    assert source["order_count"] == 2
    assert len(source["medications"]) == 2
    assert {d["so_phieu"] for d in source["medications"]} == {"999101", "999102"}
    assert len(source["supplies"]) == 2
