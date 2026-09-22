# -*- coding: utf-8 -*-
"""worker/sign_discharge_bundle.py — chèn ảnh chữ ký vào bộ phiếu "IN RA VIỆN"
tại mọi chỗ tên người đã cấu hình chữ ký xuất hiện, kể cả khi chữ bị xoay dọc
90° (cột "Ký và ghi tên" trên phiếu chức năng sống — xem worker/nurse_emr_accounts.py).

Dùng tên thuần ASCII trong PDF test (thay vì tên tiếng Việt có dấu) vì font
mặc định của PyMuPDF khi tự tạo PDF test không có bảng mã tiếng Việt — không
liên quan tới thuật toán đang kiểm tra. Việc chèn đúng vị trí trên PDF tiếng
Việt thật (có dấu, chữ do EMR sinh ra) đã được đối chiếu thủ công khớp chính
xác với 1 bản mẫu do người dùng cung cấp khi xây dựng tính năng này.
"""
import json
import os
import sys

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WORKER = os.path.join(ROOT, 'worker')
if WORKER not in sys.path:
    sys.path.insert(0, WORKER)

import pytest

fitz = pytest.importorskip("fitz", reason="Cần PyMuPDF (pip install pymupdf) để test chèn chữ ký PDF.")

import nurse_emr_accounts as nea  # noqa: E402
import sign_discharge_bundle as sdb  # noqa: E402


@pytest.fixture(autouse=True)
def _patch_nurse_accounts_paths(monkeypatch, tmp_path):
    accounts_path = tmp_path / 'nurse_emr_accounts.json'
    signatures_dir = tmp_path / 'signatures'
    signatures_dir.mkdir()
    monkeypatch.setattr(nea, 'NURSE_EMR_ACCOUNTS_FILE', str(accounts_path))
    monkeypatch.setattr(nea, 'NURSE_SIGNATURES_DIR', str(signatures_dir))
    nea.load_nurse_signature_rows.cache_clear()
    return {'accounts_path': accounts_path, 'signatures_dir': signatures_dir}


def _write_accounts(accounts_path, rows):
    accounts_path.write_text(json.dumps(rows, ensure_ascii=False), encoding='utf-8')
    nea.load_nurse_signature_rows.cache_clear()


def _make_signature_png(path, w=60, h=30):
    doc = fitz.open()
    page = doc.new_page(width=w, height=h)
    page.draw_line((2, h - 2), (w - 2, 2), color=(0, 0, 1), width=2)
    pix = page.get_pixmap()
    pix.save(str(path))
    doc.close()


def _make_test_pdf(path, entries, page_size=(400, 300)):
    """entries: list of (text, x, y, rotate)."""
    doc = fitz.open()
    page = doc.new_page(width=page_size[0], height=page_size[1])
    for text, x, y, rotate in entries:
        page.insert_text((x, y), text, fontsize=10, rotate=rotate)
    doc.save(str(path))
    doc.close()


def test_sign_bundle_stamps_horizontal_and_vertical_occurrences(tmp_path, _patch_nurse_accounts_paths):
    sig_path = tmp_path / 'signatures' / 'sig.png'
    _make_signature_png(sig_path)
    _write_accounts(_patch_nurse_accounts_paths['accounts_path'], [
        {'name': 'Nguyen Van Test', 'signature_file': 'sig.png'},
    ])

    in_pdf = tmp_path / 'in.pdf'
    _make_test_pdf(in_pdf, [
        ('Nguyen Van Test', 50, 100, 0),
        ('Nguyen Van Test', 250, 250, 90),
    ])
    out_pdf = tmp_path / 'out.pdf'

    result = sdb.sign_bundle(str(in_pdf), str(out_pdf))

    assert result['status'] == 'ok'
    assert result['stamped_count'] == 2
    assert result['signed_names'] == ['Nguyen Van Test']
    assert out_pdf.exists()

    doc = fitz.open(str(out_pdf))
    page = doc[0]
    images = [info for info in page.get_image_info(xrefs=True)]
    assert len(images) == 2

    text_rects = {q.rect for q in page.search_for('Nguyen Van Test', quads=True)}
    # Mỗi ảnh chèn phải nằm sát ngay phía trên (y nhỏ hơn) 1 trong 2 vùng chữ.
    for info in images:
        img_rect = fitz.Rect(info['bbox'])
        matched = [
            t for t in text_rects
            if abs(((img_rect.x0 + img_rect.x1) / 2) - ((t.x0 + t.x1) / 2)) < 5
            and img_rect.y1 <= t.y0 + 0.5
        ]
        assert matched, f"Ảnh {img_rect} không nằm ngay trên vùng chữ nào trong {text_rects}"


def test_sign_bundle_ignores_unconfigured_name(tmp_path, _patch_nurse_accounts_paths):
    sig_path = tmp_path / 'signatures' / 'sig.png'
    _make_signature_png(sig_path)
    _write_accounts(_patch_nurse_accounts_paths['accounts_path'], [
        {'name': 'Someone Else', 'signature_file': 'sig.png'},
    ])

    in_pdf = tmp_path / 'in.pdf'
    _make_test_pdf(in_pdf, [('Nguyen Van Test', 50, 100, 0)])
    out_pdf = tmp_path / 'out.pdf'

    result = sdb.sign_bundle(str(in_pdf), str(out_pdf))

    assert result['status'] == 'ok'
    assert result['stamped_count'] == 0
    assert result['signed_names'] == ['Someone Else']


def test_sign_bundle_error_when_no_signatures_configured(tmp_path, _patch_nurse_accounts_paths):
    _write_accounts(_patch_nurse_accounts_paths['accounts_path'], [])

    in_pdf = tmp_path / 'in.pdf'
    _make_test_pdf(in_pdf, [('Nguyen Van Test', 50, 100, 0)])
    out_pdf = tmp_path / 'out.pdf'

    result = sdb.sign_bundle(str(in_pdf), str(out_pdf))

    assert result['status'] == 'error'
    assert 'chữ ký' in result['message'].lower()
    assert not out_pdf.exists()


def test_sign_bundle_error_when_input_pdf_missing(tmp_path, _patch_nurse_accounts_paths):
    sig_path = tmp_path / 'signatures' / 'sig.png'
    _make_signature_png(sig_path)
    _write_accounts(_patch_nurse_accounts_paths['accounts_path'], [
        {'name': 'Nguyen Van Test', 'signature_file': 'sig.png'},
    ])

    result = sdb.sign_bundle(str(tmp_path / 'khong_ton_tai.pdf'), str(tmp_path / 'out.pdf'))

    assert result['status'] == 'error'


def test_sign_bundle_avoids_double_stamp_when_name_is_substring_of_another(tmp_path, _patch_nurse_accounts_paths):
    """'Test' là chuỗi con của 'Nguyen Van Test' — chỉ chèn 1 lần (theo tên dài
    hơn), không chèn thêm lần nữa cho tên ngắn trùng vị trí."""
    sig_path = tmp_path / 'signatures' / 'sig.png'
    _make_signature_png(sig_path)
    _write_accounts(_patch_nurse_accounts_paths['accounts_path'], [
        {'name': 'Nguyen Van Test', 'signature_file': 'sig.png'},
        {'name': 'Test', 'signature_file': 'sig.png'},
    ])

    in_pdf = tmp_path / 'in.pdf'
    _make_test_pdf(in_pdf, [('Nguyen Van Test', 50, 100, 0)])
    out_pdf = tmp_path / 'out.pdf'

    result = sdb.sign_bundle(str(in_pdf), str(out_pdf))

    assert result['status'] == 'ok'
    assert result['stamped_count'] == 1
    assert result['stamped'][0]['name'] == 'Nguyen Van Test'


def test_sign_bundle_stamps_separately_when_names_do_not_overlap(tmp_path, _patch_nurse_accounts_paths):
    """2 tên khác nhau, xuất hiện ở 2 chỗ không chồng nhau -> chèn cả 2."""
    sig_path = tmp_path / 'signatures' / 'sig.png'
    _make_signature_png(sig_path)
    _write_accounts(_patch_nurse_accounts_paths['accounts_path'], [
        {'name': 'Nguyen Van A', 'signature_file': 'sig.png'},
        {'name': 'Tran Thi B', 'signature_file': 'sig.png'},
    ])

    in_pdf = tmp_path / 'in.pdf'
    _make_test_pdf(in_pdf, [
        ('Nguyen Van A', 50, 100, 0),
        ('Tran Thi B', 50, 200, 0),
    ])
    out_pdf = tmp_path / 'out.pdf'

    result = sdb.sign_bundle(str(in_pdf), str(out_pdf))

    assert result['status'] == 'ok'
    assert result['stamped_count'] == 2
    assert {s['name'] for s in result['stamped']} == {'Nguyen Van A', 'Tran Thi B'}
