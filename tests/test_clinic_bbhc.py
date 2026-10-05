# -*- coding: utf-8 -*-
"""worker/clinic_bbhc.py — soạn Sổ biên bản hội chẩn (TH4) theo mẫu của khoa."""
import os
import sys
from datetime import datetime as DT

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WORKER = os.path.join(ROOT, 'worker')
if WORKER not in sys.path:
    sys.path.insert(0, WORKER)

import clinic_bbhc as bb  # noqa: E402
import clinic_monitor as cm  # noqa: E402

INFO = {'ly_do': 'Đau cột sống thắt lưng 2 tuần', 'dau_hieu': '', 'so_bo': '',
        'cd_chinh': 'Thoái hóa cột sống thắt lưng', 'cd_kem_theo': []}


def test_imaging_orders_keep_name_and_time():
    html = ('<table><tr><td>1</td><td>Chụp MRI cột sống thắt lưng (không tiêm thuốc)</td><td>09:12 28/09/2026</td></tr>'
            '<tr><td>2</td><td>Chụp X quang khớp gối</td><td>09:15 28/09/2026</td></tr>'
            '<tr><td>3</td><td>Chụp CT sọ não</td><td>10:01 28/09/2026</td></tr></table>')
    orders = bb.imaging_orders(html)
    assert [(o['kind'], o['name'], o['time']) for o in orders] == [
        ('MRI', 'Chụp MRI cột sống thắt lưng (không tiêm thuốc)', DT(2026, 9, 28, 9, 12)),
        ('CT', 'Chụp CT sọ não', DT(2026, 9, 28, 10, 1)),
    ]
    assert bb.body_part_from_order('Chụp MRI khớp gối trái (không tiêm thuốc)') == 'khớp gối trái'
    assert bb.body_part_from_order('Chụp cắt lớp vi tính cột sống cổ có tiêm thuốc cản quang') == 'cột sống cổ'


def test_build_bbhc_for_mri_lumbar_follows_template():
    reason = {'type': 'imaging', 'kind': 'MRI', 'name': 'Chụp MRI cột sống thắt lưng', 'time': DT(2026, 9, 28, 9, 12)}
    f = bb.build_bbhc(reason, INFO)
    assert f['ThoiGianHoiChan'] == '09:12 28/09/2026'
    assert f['HopTai'] == 'Khoa khám' and f['ChamSoc'] == 'CSCIII'
    assert f['YeuCau'] == f['HuongDieuTri'] == 'Chụp MRI cột sống thắt lưng'
    assert f['TomTat'] == 'Người bệnh tỉnh, đau cột sống thắt lưng\nTê lan hai chân\nVận động hạn chế'
    assert f['TomTatBenhAn'] == f['TomTat']
    assert f['TinhTrang'].split('\n') == ['Người bệnh tỉnh', 'Tiếp xúc tốt', 'Da niêm hồng', 'Mạch rõ, chi ấm',
                                          'Đau cột sống thắt lưng', 'Tê lan hai chân', 'Vận động hạn chế']
    assert f['ChanDoanTuyenDuoi'] == f['NguyenNhan'] == 'Thoái hóa cột sống thắt lưng(TS: 0)'
    assert f['KetLuan'] == ('Chẩn đoán: Thoái hóa cột sống thắt lưng(TS: 0)\n'
                            'Hướng xử lý: Chụp MRI cột sống thắt lưng\nTiên lượng: Trung bình')


def test_region_lines_only_where_template_says():
    assert bb.region_lines('MRI', 'Chụp MRI khớp gối phải') == ['Đi lỏng gối']
    assert bb.region_lines('CT', 'Chụp CT khớp gối phải') == []                      # CT không thêm dòng
    assert bb.region_lines('CT', 'Chụp CT cột sống thắt lưng') == []
    assert bb.region_lines('transfer', 'Thoát vị đĩa đệm cột sống cổ') == ['Tê lan hai tay']
    assert bb.region_lines('MRI', 'cột sống thắt lưng') == ['Tê lan hai chân']


def test_build_bbhc_for_transfer_and_missing_hospital():
    info = {**INFO, 'ly_do': 'Đau vùng cổ', 'cd_chinh': 'Thoát vị đĩa đệm cột sống cổ', 'cd_kem_theo': ['Tăng huyết áp']}
    reason = bb.transfer_from_xutri([
        {'label': 'Thời gian ra *', 'id': 'txtThoigianRa', 'value': '10:30 28/09/2026'},
        {'label': 'Nơi chuyển đến', 'id': 'cbbNoiChuyen', 'value': 'Bệnh viện Chợ Rẫy'},
        {'label': 'Hướng điều trị', 'id': 'txtHuong', 'value': 'Phẫu thuật cột sống cổ'},
    ])
    f = bb.build_bbhc(reason, info)
    assert f['ThoiGianHoiChan'] == '10:30 28/09/2026'
    assert f['YeuCau'] == 'Chuyển viện Bệnh viện Chợ Rẫy'
    assert f['HuongDieuTri'] == 'Phẫu thuật cột sống cổ'
    assert f['TomTat'].split('\n') == ['Người bệnh tỉnh, đau cột sống cổ', 'Tê lan hai tay', 'Vận động hạn chế']  # vị trí đau lấy từ chẩn đoán
    assert f['ChanDoanTuyenDuoi'] == 'Thoát vị đĩa đệm cột sống cổ + Tăng huyết áp(TS: 1)'
    assert bb.missing_fields({**f, 'ThuKy': 'ĐD A'}) == []

    # Không đọc được nơi chuyển / hướng điều trị → báo thiếu, không tự bịa.
    empty = bb.build_bbhc(bb.transfer_from_xutri([{'label': 'Thời gian ra', 'id': 'txtThoigianRa', 'value': '10:30 28/09/2026'}]), info)
    missing = bb.missing_fields({**empty, 'ThuKy': ''})
    assert 'Tên bệnh viện chuyển đến' in missing and 'Phương pháp điều trị' in missing and 'Thư ký' in missing


class FakeBbhc:
    """Thay BbhcPage: ghi lại thao tác."""
    existing_rows = []

    def __init__(self, page):
        self.writes = page.writes

    def exam_info(self): return INFO
    def imaging_services(self): return None  # trang không có bảng Chỉ định DVKT → dùng popup lịch sử
    def transfer_info(self): return {'type': 'transfer', 'hospital': 'BV X', 'direction': 'Điều trị tiếp', 'time': DT(2026, 9, 28, 10, 0)}
    def existing(self): return list(FakeBbhc.existing_rows)
    def open_attachments(self): self.writes.append('mo_giay_to'); return list(FakeBbhc.existing_rows)
    def close_attachments(self): self.writes.append('dong_giay_to')
    def add_form(self): self.writes.append('them'); return f"id{len(self.writes)}"

    def fill_and_finish(self, hoso_id, fields, out):
        self.writes.append(('hoan_tat', hoso_id, fields['YeuCau'], fields['ThuKy']))
        return {'id': hoso_id, 'pdf': out}


class Page:
    def __init__(self): self.writes = []


def test_prepare_is_read_only_and_create_skips_existing(monkeypatch, tmp_path):
    monkeypatch.setattr(cm.clinic_bbhc, 'BbhcPage', FakeBbhc)
    config = {'clinic_nurse_schedule': {'days': {'2026-09-28': {'work': ['ĐD Phòng khám']}}}}
    row = {'case': 'chuyen_vien', 'has_bhyt': True, 'stage': 'dang_lam_dv'}
    imaging = {'orders': [{'kind': 'MRI', 'name': 'Chụp MRI cột sống thắt lưng', 'time': '09:12 28/09/2026'}]}
    FakeBbhc.existing_rows = []
    page = Page()
    res = cm.prepare_bbhc(page, row, imaging, config, DT(2026, 9, 28, 11, 0))
    assert res['status'] == 'draft' and [d['label'] for d in res['drafts']] == ['Chụp MRI: Chụp MRI cột sống thắt lưng', 'Chuyển viện BV X']
    assert res['drafts'][0]['fields']['ThuKy'] == 'ĐD Phòng khám' and res['drafts'][0]['missing'] == []
    assert page.writes == []

    page = Page()
    out = cm.create_bbhc(page, row, res['drafts'], str(tmp_path))
    assert out['result'] == 'done' and len(out['pdfs']) == 2
    assert page.writes[0] == 'mo_giay_to' and page.writes[-1] == 'dong_giay_to'
    assert [w[2] for w in page.writes if isinstance(w, tuple)] == ['Chụp MRI cột sống thắt lưng', 'Chuyển viện BV X']

    # Đã có đủ SBBHC trên EMR → không lập thêm.
    FakeBbhc.existing_rows = [{'id': 'a'}, {'id': 'b'}]
    page = Page()
    assert cm.create_bbhc(page, row, res['drafts'], str(tmp_path))['result'] == 'exists'
    assert page.writes == []
    assert cm.prepare_bbhc(Page(), row, imaging, config, DT(2026, 9, 28, 11, 0))['status'] == 'exists'

    # Nháp còn thiếu ô bắt buộc → dừng trước khi Thêm.
    FakeBbhc.existing_rows = []
    bad = [{**res['drafts'][0], 'fields': {**res['drafts'][0]['fields'], 'ThuKy': ''}}]
    page = Page()
    try:
        cm.create_bbhc(page, row, bad, str(tmp_path))
        raised = ''
    except cm.ExamStepError as e:
        raised = str(e)
    assert 'Thư ký' in raised and 'them' not in page.writes


def test_merge_pdfs(tmp_path):
    import pymupdf as fitz
    paths = []
    for i in range(2):
        doc = fitz.open()
        doc.new_page().insert_text((72, 72), f'SBBHC {i}')
        p = str(tmp_path / f'{i}.pdf')
        doc.save(p)
        doc.close()
        paths.append(p)
    out = bb.merge_pdfs(paths, str(tmp_path / 'all.pdf'))
    with fitz.open(out) as merged:
        assert merged.page_count == 2


def test_imaging_from_exam_service_table():
    services = [
        {'cells': ['1', '(XQ.22) Chụp X-quang cột sống cổ thẳng nghiêng [số hóa 2 phim]', 'PHÒNG CHỤP XQUANG', '1', 'Bảo hiểm', '10:00 28/09/2026', 'Chờ thực hiện', '105,300'], 'done': False},
        {'cells': ['2', '(CT.12) Chụp CT cột sống thắt lưng không tiêm thuốc cản quang', 'PHÒNG CT', '1', 'Bảo hiểm', '10:05 28/09/2026', 'Hoàn tất', '500,000'], 'done': True},
        {'cells': ['3', '(MRI.3) Chụp cộng hưởng từ khớp gối', 'PHÒNG MRI', '1', 'Bảo hiểm', '10:07 28/09/2026', 'Chờ thực hiện', '1'], 'done': False},
    ]
    assert bb.imaging_from_services(services) == [
        {'kind': 'CT', 'name': 'Chụp CT cột sống thắt lưng không tiêm thuốc cản quang', 'time': DT(2026, 9, 28, 10, 5)},
        {'kind': 'MRI', 'name': 'Chụp cộng hưởng từ khớp gối', 'time': DT(2026, 9, 28, 10, 7)},
    ]
