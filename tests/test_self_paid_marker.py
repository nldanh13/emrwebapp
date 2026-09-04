# -*- coding: utf-8 -*-
"""Test các marker tự túc/có sẵn bị méo khi lấy dữ liệu từ EMR."""
import json
import os
import tempfile

try:
    from xu_ly import process_all
    XU_LY_AVAILABLE = True
except Exception as e:  # pragma: no cover
    XU_LY_AVAILABLE = False
    XU_LY_ERROR = str(e)


def _run(records: list) -> list:
    with tempfile.NamedTemporaryFile(mode="w", suffix=".json", encoding="utf-8", delete=False) as f:
        json.dump(records, f, ensure_ascii=False)
        in_path = f.name
    out_path = in_path.replace(".json", "_out.json")
    try:
        process_all(in_path, output_file=out_path)
        with open(out_path, encoding="utf-8") as f:
            return json.load(f)
    finally:
        for path in (in_path, out_path):
            try:
                os.unlink(path)
            except FileNotFoundError:
                pass


def test_tt0_nucleo_cmp_tb_8h_duoc_nhan_la_thuoc_tiem_tu_tuc():
    assert XU_LY_AVAILABLE, XU_LY_ERROR if not XU_LY_AVAILABLE else ""
    result = _run([{
        "Mã BN": "TEST_TT0_NUCLEO",
        "Họ tên": "BN TEST",
        "Bác sĩ": "BS TEST",
        "Vi_Tri": "P09",
        "ngay_lam": "04/05/2026",
        "Diễn biến": "",
        "Y lệnh": (
            "08:00 | Bác sĩ: BS TEST\n"
            "+ Thuốc:\n"
            "(TT0 Nucleo CMP 1A (TB) 8h\n"
        ),
    }])
    assert result
    thuoc = result[0].get("thuoc", {})
    tiem = thuoc.get("thuoc_tiem", [])
    uong = thuoc.get("thuoc_uong", [])
    nucleo = next((d for d in tiem if "NUCLEO CMP" in str(d.get("ten_thuoc", "")).upper()), None)
    assert nucleo is not None, f"Nucleo CMP phải vào thuốc tiêm, không được mất. Tiêm={tiem}; Uống={uong}"
    assert "8 giờ" in str(nucleo.get("gio_dung", ""))
    assert "bắp" in str(nucleo.get("duong_dung_goc", "")).lower()
    assert nucleo.get("tu_tuc") is True
    assert not any("NUCLEO CMP" in str(d.get("ten_thuoc", "")).upper() for d in uong)


def test_tt_paracetamol_1g_x3_ttm_8h_duoc_mo_rong_8_16_23():
    records = [{
        "Mã BN": "TEST_PARA_X3_8H",
        "Họ tên": "BN TEST",
        "Bác sĩ": "BS Test",
        "Chẩn đoán": "test",
        "T/G vào": "08:00 01/05/2026",
        "Khoa chuyển đến": "",
        "Xử trí": "Đang thực hiện",
        "Vi_Tri": "P08",
        "ngay_lam": "01/05/2026",
        "Diễn biến": "",
        "Y lệnh": "(TT) paracetamol 1g 01 chai x3 ( TTM) 100g/p/8h",
    }]
    result = _run(records)
    assert result
    dt = result[0]["thuoc"].get("dich_truyen", [])
    paras = [d for d in dt if "PARACETAMOL" in (d.get("ten_thuoc", "").upper())]
    assert len(paras) == 3
    assert [p.get("gio_dung") for p in paras] == ["8 giờ", "16 giờ", "23 giờ"]
    assert all(p.get("tu_tuc") is True for p in paras)
    assert all(str(p.get("toc_do")) == "100" for p in paras)
    assert all((p.get("ten_hien_thi") or p.get("ten_thuoc") or "").upper() != "THERMODOL" for p in paras)
    assert all("PARACETAMOL" in ((p.get("ten_hien_thi") or p.get("ten_thuoc") or "").upper()) for p in paras)
