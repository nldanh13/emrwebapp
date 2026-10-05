# -*- coding: utf-8 -*-
"""In ra viện (in chung) — in 2 mặt: mỗi nhóm phiếu và mỗi người bệnh phải bắt đầu ở MẶT TRƯỚC
(trang lẻ). Người dùng báo "sai thứ tự / trang trắng": phiếu chức năng sống lẻ trang (giả định
luôn 2 trang) làm cả phần truyền dịch, chăm sóc phía sau lệch sang mặt sau; ghép chung tính trang
trắng theo từng file nên một file lệch kéo theo mọi người sau."""
import json
import sys
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "worker"))

pypdf = pytest.importorskip("pypdf")
from pypdf import PdfReader, PdfWriter  # noqa: E402
from pypdf.generic import NameObject, TextStringObject  # noqa: E402

import ward_print_discharge_bundle as wpdb  # noqa: E402
import merge_pdf_files as mpf  # noqa: E402


def _pdf(path: Path, label: str, pages: int) -> Path:
    w = PdfWriter()
    for i in range(pages):
        p = w.add_blank_page(595, 842)
        p[NameObject("/SrcId")] = TextStringObject(f"{label}.{i + 1}")
    with path.open("wb") as f:
        w.write(f)
    return path


def _labels(path: Path):
    """Nhãn từng trang ('-' = trang trắng chèn thêm)."""
    return [str(p.get("/SrcId") or "-") for p in PdfReader(str(path)).pages]


def _start_page(labels, label):
    return labels.index(f"{label}.1") + 1  # số trang 1-based


def test_patient_bundle_every_group_starts_on_front_page(tmp_path):
    recs = [
        {"key": "phieu_chuc_nang_song_ve", "pdf_path": str(_pdf(tmp_path / "v.pdf", "VITAL", 3)), "status_context": "Hoàn tất", "index": 1},
        {"key": "phieu_theo_doi_truyen_dich", "pdf_path": str(_pdf(tmp_path / "i.pdf", "INF", 1)), "status_context": "Hoàn tất", "index": 1},
        {"key": "phieu_cham_soc", "pdf_path": str(_pdf(tmp_path / "c1.pdf", "CARE1", 3)), "status_context": "Hoàn tất", "index": 1},
        {"key": "phieu_cham_soc", "pdf_path": str(_pdf(tmp_path / "c2.pdf", "CARE2", 2)), "status_context": "Đang thực hiện", "index": 1},
    ]
    out = tmp_path / "bundle.pdf"
    wpdb._merge_discharge_bundle_records(recs, out)
    labels = _labels(out)
    for group in ("VITAL", "INF", "CARE1", "CARE2"):
        assert _start_page(labels, group) % 2 == 1, (group, labels)
    assert len(labels) % 2 == 0, labels
    # Thứ tự nhóm giữ nguyên: chức năng sống → truyền dịch → chăm sóc (Hoàn tất trước Đang thực hiện).
    order = [l.split(".")[0] for l in labels if l != "-"]
    assert order == ["VITAL"] * 3 + ["INF"] + ["CARE1"] * 3 + ["CARE2"] * 2


def test_batch_each_patient_starts_on_front_page(tmp_path):
    files = [
        {"path": str(_pdf(tmp_path / "a.pdf", "A", 3)), "ma_bn": "A"},
        {"path": str(_pdf(tmp_path / "b.pdf", "B", 1)), "ma_bn": "B"},
        {"path": str(_pdf(tmp_path / "c.pdf", "C", 2)), "ma_bn": "C"},
    ]
    inp = tmp_path / "in.json"
    inp.write_text(json.dumps({"files": files, "blank_between_patients": True}), encoding="utf-8")
    out = tmp_path / "all.pdf"
    assert mpf.merge_files(inp, out, tmp_path / "out.json") == 0
    labels = _labels(out)
    for patient in ("A", "B", "C"):
        assert _start_page(labels, patient) % 2 == 1, (patient, labels)


def test_batch_unreadable_file_does_not_shift_next_patients(tmp_path):
    bad = tmp_path / "bad.pdf"
    bad.write_bytes(b"<html>EMR tra ve trang loi</html>")
    files = [
        {"path": str(_pdf(tmp_path / "a.pdf", "A", 2)), "ma_bn": "A"},
        {"path": str(bad), "ma_bn": "X"},
        {"path": str(_pdf(tmp_path / "c.pdf", "C", 1)), "ma_bn": "C"},
        {"path": str(_pdf(tmp_path / "d.pdf", "D", 2)), "ma_bn": "D"},
    ]
    inp = tmp_path / "in.json"
    inp.write_text(json.dumps({"files": files}), encoding="utf-8")
    out = tmp_path / "all.pdf"
    out_json = tmp_path / "out.json"
    mpf.merge_files(inp, out, out_json)
    labels = _labels(out)
    assert _start_page(labels, "C") % 2 == 1 and _start_page(labels, "D") % 2 == 1, labels
    result = json.loads(out_json.read_text(encoding="utf-8"))
    assert result["status"] == "partial" and result["failures"][0]["ma_bn"] == "X"
