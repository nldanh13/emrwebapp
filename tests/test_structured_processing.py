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
    assert "Natri clorid 0,9% 100ml" in text
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



def test_new_emr_text_keeps_drug_quantity_and_route_separate():
    from processing.medication_parser import parse_drug_name, update_drug_usage
    form = {
        "gio_y_lenh": "05:00 16/10/2026", "bac_si": "Bác sĩ A",
        "thuoc": [{
            "ten_duoc": "Paracetamol 10mg/ml (Paracetamol)",
            "so_luong": "3.00", "don_vi": "Túi", "ham_luong": "10mg/1ml",
            "cach_dung": "TTM 100g/p(8 giờ, 16 giờ, 22 giờ)",
        }],
    }
    lines = build_classification_text([form]).splitlines()
    assert lines == [
        "05:00 | Bác sĩ: Bác sĩ A", "+ Thuốc:",
        "Paracetamol 10mg/ml (Paracetamol) x 3 (Túi)",
        "TTM 100g/p(8 giờ, 16 giờ, 22 giờ)",
    ]
    drug = parse_drug_name(lines[2])
    assert drug["so_luong"] == "3"
    assert drug["dang"] == "Túi"
    updated = update_drug_usage(drug, lines[3], {})
    assert updated["toc_do"] == "100"
    assert "TTM" in updated["duong_dung_goc"]


def test_nacl_marked_to_mix_two_drugs_is_not_third_infusion():
    meds = [
        {"ten_duoc": "Vinphacine (Amikacin)", "so_luong": "2.00", "don_vi": "Ống",
         "cach_dung": "TTM 30g/ph 8h", "thuoc_pha": "Natri clorid 0,9%"},
        {"ten_duoc": "Mizapenem 0,5g (Meropenem)", "so_luong": "6.00", "don_vi": "Lọ",
         "cach_dung": "pha Natri Clorid 0,9% 100ml (TTM) 30g/p sáng 2 lọ, chiều 2 lọ, tối 2 lọ(8 giờ, 16 giờ, 23 giờ)",
         "thuoc_pha": "Natri clorid 0,9%"},
        {"ten_duoc": "Natri clorid 0,9% 100ml", "so_luong": "1.00", "don_vi": "Túi",
         "cach_dung": "pha vinphacin"},
        {"ten_duoc": "Natri clorid 0,9% 100ml", "so_luong": "3.00", "don_vi": "Túi",
         "cach_dung": "pha mizapenem"},
    ]
    form = {"gio_y_lenh": "05:00 16/10/2026", "bac_si": "Bác sĩ A",
            "trang_thai_y_lenh": "Hoàn tất", "id": "f001", "thuoc": meds}
    text = build_classification_text([form])
    assert text.count("Natri clorid 0,9% 100ml") == 0
    assert "pha vinphacin" not in text
    assert "pha mizapenem" not in text
    assert "Mizapenem" in text and "Vinphacine" in text
    source = extract_structured_source({"order_history": [form]})
    assert len(source["medications"]) == 4
    assert [x["so_luong"] for x in source["medications"][2:]] == ["1.00", "3.00"]


def test_standalone_nacl_ttm_remains_classifiable_infusion():
    form = {"gio_y_lenh": "08:00 16/10/2026", "bac_si": "Bác sĩ A",
            "thuoc": [{"ten_duoc": "Natri clorid 0,9% 500ml",
                       "so_luong": "1.00", "don_vi": "Chai",
                       "cach_dung": "TTM 40 giọt/phút (9 giờ)"}]}
    text = build_classification_text([form])
    assert "Natri clorid 0,9% 500ml x 1 (Chai)" in text
    assert "TTM 40 giọt/phút (9 giờ)" in text



def test_structured_infusion_schedule_uses_dose_times_not_vial_count():
    """Two vials per saline bag is one infusion session, not two bags."""
    data = [
        {
            "ma_bn": "TEST_IV_SCHED", "ho_ten": "BỆNH NHÂN THỬ",
            "ngay_lam": "16/10/2026", "bac_si": "Bác sĩ A",
            "Diễn biến": "Dự trù thuốc", "Y lệnh": "",
            "order_history": [{
                "id": "full-drug-order", "trang_thai_y_lenh": "Hoàn tất",
                "so_phieu": "999002", "gio_y_lenh": "05:00 16/10/2026",
                "ngay_lam": "16/10/2026", "bac_si": "Bác sĩ A",
                "dien_bien_benh": "Dự trù thuốc",
                "thuoc": [
                    {
                        "ten_duoc": "Paracetamol 10mg/ml (Paracetamol)",
                        "so_luong": "3.00", "don_vi": "Túi",
                        "cach_dung": "TTM 100g/p(8 giờ, 16 giờ, 22 giờ)",
                    },
                    {
                        "ten_duoc": "Vinphacine (Amikacin)",
                        "so_luong": "2.00", "don_vi": "Ống",
                        "cach_dung": "TTM 30g/ph 8h",
                        "thuoc_pha": "Natri clorid 0,9%",
                    },
                    {
                        "ten_duoc": "Mizapenem 0,5g (Meropenem)",
                        "so_luong": "6.00", "don_vi": "Lọ",
                        "cach_dung": "pha Natri Clorid 0,9% 100ml (TTM) 30g/p sáng 2 lọ, chiều 2 lọ, tối 2 lọ(8 giờ, 16 giờ, 23 giờ)",
                        "thuoc_pha": "Natri clorid 0,9%",
                    },
                    {
                        "ten_duoc": "Natri clorid 0,9% 100ml", "so_luong": "1.00", "don_vi": "Túi",
                        "cach_dung": "pha vinphacin",
                    },
                    {
                        "ten_duoc": "Natri clorid 0,9% 100ml", "so_luong": "3.00", "don_vi": "Túi",
                        "cach_dung": "pha mizapenem",
                    },
                ]
            }]
        }
    ]
    result = build_patient_day_records(data)
    assert len(result) == 1
    rec = result[0]
    infusions = rec.get("thuoc", {}).get("dich_truyen", [])
    names = [(d.get("ten_thuoc") or "").lower() for d in infusions]
    assert all("natri clorid" not in name for name in names), infusions
    para = [d for d in infusions if "paracetamol" in (d.get("ten_thuoc") or "").lower()]
    vina = [d for d in infusions if "vinphacine" in (d.get("ten_thuoc") or "").lower()]
    miza = [d for d in infusions if "mizapenem" in (d.get("ten_thuoc") or "").lower()]
    assert (len(para), len(vina), len(miza)) == (3, 1, 3), [
        (d.get("ten_thuoc"), d.get("gio_dung"), d.get("tg_bat_dau"), d.get("the_tich"),
         d.get("so_lo_moi_lan"), d.get("dang")) for d in infusions
    ]
    assert rec.get("emr_order_source", {}).get("order_count") == 1
    assert len(rec["emr_order_source"]["medications"]) == 5
    assert vina[0]["the_tich"] == 100.0
    assert vina[0].get("so_lo_pha_mot_tui") == 2
    assert all(x["the_tich"] == 100.0 for x in miza)
    assert all(x.get("so_lo_pha_mot_tui") == 2 for x in miza)
