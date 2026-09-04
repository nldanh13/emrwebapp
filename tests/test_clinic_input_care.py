# -*- coding: utf-8 -*-
from clinic_input_care import (
    _department_matches,
    _parse_admission_time,
    parse_inpatient_care_rows,
)


def _row(stt, tg_vao, code, name, department, noitruid):
    return f"""
    <tr>
      <td>{stt}</td>
      <td><a>{tg_vao}</a></td>
      <td><a href="home.aspx?scope=sys&amp;wpid=dieuduongdraw&amp;noitruid={noitruid}"><i class="far fa-eye"></i></a></td>
      <td>Xem KQ</td><td>-</td>
      <td><a>{code}</a></td>
      <td><a id="btna{noitruid}">{name}<br><i>- PM: PHÒNG KHÁM</i></a></td>
      <td>45</td><td>Nam</td><td>Bảo hiểm</td><td></td><td>0</td><td>0</td>
      <td><span>Đang thực hiện</span></td><td>BS A</td><td>Chẩn đoán</td>
      <td>{department}</td><td></td>
    </tr>
    """


def _table(*rows):
    return f"""
    <table id="tblNoiTru">
      <thead><tr>
        <th>STT</th><th>T/G vào</th><th>ĐD</th><th>KQ</th><th>B-G</th>
        <th>Mã BN</th><th>Họ tên</th><th>Tuổi</th><th>GT</th><th>Đối tượng</th>
        <th>ĐT chi tiết</th><th>Tạm ứng</th><th>Phải trả</th><th>Trạng thái</th>
        <th>Bác sĩ</th><th>Chẩn đoán</th><th>Khoa chuyển đến</th><th>Xử trí</th>
      </tr></thead>
      <tbody>{''.join(rows)}</tbody>
    </table>
    """


def test_parse_inpatient_care_rows_filters_date_and_department_and_keeps_exact_time():
    html = _table(
        _row(1, "08:25 20/07/2026", "99070001", "NGUYỄN VĂN A", "Khoa Khám Bệnh", "noi-1"),
        _row(2, "20/07/2026 09:10", "99070002", "TRẦN THỊ B", "KHOA KHÁM BỆNH", "noi-2"),
        _row(3, "10:15 19/07/2026", "99070003", "LÊ VĂN C", "Khoa Khám Bệnh", "noi-3"),
        _row(4, "11:30 20/07/2026", "99070004", "PHẠM THỊ D", "Khoa Ngoại CTCH-TK", "noi-4"),
    )

    rows = parse_inpatient_care_rows(
        html,
        "2026-07-20",
        target_department="Khoa Khám Bệnh",
        base_url="http://emr.local/home.aspx?usid=session-1",
    )

    assert [r["ma_bn"] for r in rows] == ["99070001", "99070002"]
    assert [r["care_time_str"] for r in rows] == ["08:25 20/07/2026", "09:10 20/07/2026"]
    assert rows[0]["ngay_lam"] == "20/07/2026"
    assert rows[0]["care_hour"] == 8
    assert rows[0]["khoa_chuyen_den"] == "Khoa Khám Bệnh"
    assert rows[0]["noitruid"] == "noi-1"
    assert "wpid=dieuduongdraw" in rows[0]["nursing_url"]
    assert rows[0]["ho_ten"] == "NGUYỄN VĂN A"


def test_parse_admission_time_never_invents_fallback_time():
    assert _parse_admission_time("") == ("", "", -1)
    assert _parse_admission_time("20/07/2026") == ("", "", -1)
    assert _parse_admission_time("25:10 20/07/2026") == ("", "", -1)
    assert _parse_admission_time("07:05 20/07/2026") == ("07:05 20/07/2026", "20/07/2026", 7)


def test_department_match_is_accent_and_case_insensitive_but_not_other_wards():
    assert _department_matches("KHOA KHÁM BỆNH", "Khoa Khám Bệnh")
    assert _department_matches("Khoa Kham Benh", "Khoa Khám Bệnh")
    assert not _department_matches("Khoa Ngoại Chấn thương", "Khoa Khám Bệnh")
    assert not _department_matches("Khoa Khám Bệnh - Cơ sở 2", "Khoa Khám Bệnh")
    assert not _department_matches("", "Khoa Khám Bệnh")
