# -*- coding: utf-8 -*-
import zipfile
from pathlib import Path

from clinic_outpatient import parse_clinic_table, parse_xlsx_patient_rows, is_trauma_room, summarize_procedure_rows


def make_minimal_xlsx(path: Path):
    shared = [
        "Tên phòng khám", "Trạng thái KB", "Mã BN", "Tên BN", "Mã PK",
        "PHÒNG KHÁM CHẤN THƯƠNG CHỈNH HÌNH - 20", "Đang khám", "99049150", "NGƯỜI BỆNH O", "PK20",
        "PHÒNG KHÁM CHẤN THƯƠNG CHỈNH HÌNH - 20B", "Chờ khám", "99045641", "NGƯỜI BỆNH P", "PK20B",
    ]
    def c(ref, idx):
        return f'<c r="{ref}" t="s"><v>{idx}</v></c>'
    rows = [
        '<row r="1">' + ''.join(c(ref, idx) for ref, idx in zip(["A1","B1","C1","D1","E1"], range(5))) + '</row>',
        '<row r="2">' + ''.join(c(ref, idx) for ref, idx in zip(["A2","B2","C2","D2","E2"], range(5,10))) + '</row>',
        '<row r="3">' + ''.join(c(ref, idx) for ref, idx in zip(["A3","B3","C3","D3","E3"], range(10,15))) + '</row>',
    ]
    with zipfile.ZipFile(path, "w") as z:
        z.writestr("xl/sharedStrings.xml", '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' + ''.join(f'<si><t>{s}</t></si>' for s in shared) + '</sst>')
        z.writestr("xl/worksheets/sheet1.xml", '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' + ''.join(rows) + '</sheetData></worksheet>')


def test_parse_xlsx_patient_rows(tmp_path):
    p = tmp_path / "clinic.xlsx"
    make_minimal_xlsx(p)
    rows = parse_xlsx_patient_rows(str(p))
    assert [r["ma_bn"] for r in rows] == ["99049150", "99045641"]
    assert rows[0]["trang_thai_excel"] == "Đang khám"
    assert rows[1]["ma_pk"] == "PK20B"


def test_parse_clinic_table_statuses():
    html = """
    <table class="table"><thead><tr>
      <th>STT</th><th>SĐK</th><th>Mã BN</th><th>Họ tên</th><th>Thời gian</th><th>Trạng thái</th><th>Kết quả dịch vụ</th><th>Xử trí</th><th>Nơi thực hiện</th>
    </tr></thead><tbody>
      <tr access_id="abc"><td>1</td><td>044</td><td><a href="home.aspx?khambenhid=abc">99057116</a></td><td>NGƯỜI BỆNH THỬ</td><td>10:10 20/05/2026</td><td><span class="badge">Chờ thực hiện</span></td><td><a onclick="onShowLichSuChung('abc','TT');">TT: 0/1</a> | CDHA: 1/1</td><td></td><td>PHÒNG KHÁM CHẤN THƯƠNG CHỈNH HÌNH - 20</td></tr>
      <tr access_id="def"><td>2</td><td>068</td><td>99018597</td><td>LÊ THỊ TRANG</td><td>15:27 20/05/2026</td><td><span>Hoàn tất</span></td><td><a onclick="onShowLichSuChung('def','TT');">TT: 0/1</a></td><td>Cho về</td><td>PHÒNG KHÁM CHẤN THƯƠNG CHỈNH HÌNH - 20B</td></tr>
      <tr access_id="ghi"><td>3</td><td>069</td><td>99018598</td><td>NGUYỄN A</td><td>15:30 20/05/2026</td><td><span>Đang thực hiện</span></td><td><a onclick="onShowLichSuChung('ghi','TT');">TT: 1/1</a></td><td></td><td>PHÒNG KHÁM CHẤN THƯƠNG CHỈNH HÌNH - 20</td></tr>
    </tbody></table>
    """
    rows = parse_clinic_table(html)
    assert len(rows) == 3
    assert rows[0]["ma_bn"] == "99057116"
    assert rows[0]["trang_thai"] == "Chờ thực hiện"
    assert rows[0]["tt_done"] == 0
    assert rows[0]["tt_total"] == 1
    assert rows[0]["needs_procedure"] is True
    assert rows[1]["skip_status"] is True
    assert rows[1]["needs_procedure"] is False
    assert rows[2]["tt_done"] == 1
    assert rows[2]["needs_procedure"] is False
    assert rows[1]["xu_tri"] == "Cho về"
    assert all(is_trauma_room(r) for r in rows)
    summary = summarize_procedure_rows(rows)
    assert summary["actionable_count"] == 1
    assert summary["skipped_status_count"] == 1


def test_parse_tt_history_modal_and_shift_classification():
    from clinic_outpatient import parse_tt_history_modal, classify_procedure_performer
    html = """
    <div id="divLichSuTTContent"><table><thead><tr>
      <th>STT</th><th>TG chỉ định</th><th>Người chỉ định</th><th>Tên chỉ định</th><th>Tên chỉ định cha</th><th>Trạng thái</th><th>Chi tiết</th>
    </tr></thead><tbody id="BodyDichVu">
      <tr><td colspan="6">PHÒNG THỦ THUẬT</td></tr>
      <tr><td>1</td><td>09:18 20/05/2026</td><td>Hoàng Minh Tú</td><td>Khâu vết thương phần mềm nông dài &lt; 5cm</td><td>Khám Ngoại tổng hợp</td><td><span>Chờ thực hiện</span></td><td></td></tr>
      <tr><td>2</td><td>15:20 20/05/2026</td><td>Hoàng Minh Tú</td><td>Thay băng vết thương</td><td>Khám Ngoại tổng hợp</td><td><span>Hoàn tất</span></td><td></td></tr>
    </tbody></table></div>
    """
    orders = parse_tt_history_modal(html)
    assert len(orders) == 2
    assert orders[0]["ten_chi_dinh"] == "Khâu vết thương phần mềm nông dài < 5cm"
    assert orders[0]["is_pending"] is True
    assert orders[1]["is_done"] is True

    sched = {
        "doctorMorningName": "BS Sáng",
        "doctorAfternoonName": "BS Chiều",
        "nurseName": "ĐD Một",
        "defaultRole": "nurse",
        "afternoonStartHour": "12",
        "doctorKeywords": "khâu, tiêm khớp",
        "nurseKeywords": "thay băng",
    }
    morning = classify_procedure_performer({"procedure_service_name": orders[0]["ten_chi_dinh"], "procedure_order_time": orders[0]["tg_chi_dinh"]}, sched)
    assert morning["procedure_performer_role"] == "doctor"
    assert morning["procedure_performer_name"] == "BS Sáng"

    afternoon = classify_procedure_performer({"procedure_service_name": "Tiêm khớp gối", "procedure_order_time": "15:10 20/05/2026"}, sched)
    assert afternoon["procedure_performer_role"] == "doctor"
    assert afternoon["procedure_performer_name"] == "BS Chiều"

    nurse = classify_procedure_performer({"procedure_service_name": "Thay băng vết thương", "procedure_order_time": "15:20 20/05/2026"}, sched)
    assert nurse["procedure_performer_role"] == "nurse"
    assert nurse["procedure_performer_name"] == "ĐD Một"
