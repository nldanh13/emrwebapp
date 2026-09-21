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


class _FakeElement:
    def click(self):
        pass


class _FakeWait:
    def until(self, _condition):
        return _FakeElement()


class _FakeDriver:
    def find_element(self, *_a, **_k):
        return _FakeElement()

    def execute_script(self, *_a, **_k):
        pass


class _FakeWS:
    """WorkerSession giả: switch_account luôn thành công và đổi driver/wait mới.

    switch_to_creator_account/restore_account mô phỏng đúng hành vi tập
    trung ở WorkerSession thật (worker/shared/worker_session.py) — tra tài
    khoản qua `accounts` (thay cho nurse_emr_accounts.get_emr_account_for_nurse
    thật) rồi gọi switch_account + reopen."""

    def __init__(self, username="acct.goc", accounts=None):
        self.config = {"username": username, "password": "pw_goc"}
        self.driver = _FakeDriver()
        self.wait = _FakeWait()
        self.switch_calls = []
        self.accounts = accounts or {}

    def switch_account(self, username, password):
        self.switch_calls.append((username, password))
        self.config = {"username": username, "password": password}
        self.driver = _FakeDriver()
        self.wait = _FakeWait()
        return True

    def _switch_account_to(self, username, password, ma_bn, reopen):
        if username == self.config.get("username"):
            return True
        if not self.switch_account(username, password):
            return False
        try:
            (reopen or (lambda w, mb: None))(self, ma_bn)
        except Exception:
            return False
        return True

    def switch_to_creator_account(self, creator, ma_bn, reopen=None):
        account = self.accounts.get((creator or "").strip().lower())
        if not account:
            return False
        return self._switch_account_to(account["username"], account["password"], ma_bn, reopen)

    def restore_account(self, original_username, original_password, ma_bn, reopen=None):
        if not original_username or self.config.get("username") == original_username:
            return
        self._switch_account_to(original_username, original_password, ma_bn, reopen)


def test_input_one_switches_to_old_creator_account_to_delete_then_restores(monkeypatch):
    """EMR hiện chỉ cho đúng tài khoản người tạo phiếu tự sửa/xóa phiếu của họ.
    Khi cần thu hồi/xóa phiếu cũ (EDIT) do người khác lập, _input_one phải đổi
    sang đúng tài khoản người đó để xóa, rồi đổi lại tài khoản gốc của lượt
    nhập này trước khi tạo phiếu mới."""
    import clinic_input_care as cic

    monkeypatch.setattr(cic, "scan_cham_soc_cache", lambda driver, ngay, hours_needed=None: ({}, []))
    monkeypatch.setattr(cic, "kiem_tra_bang_cached", lambda *a, **k: ("EDIT", "CARE_1", "Nguoi Lap Cu"))

    open_calls = []
    monkeypatch.setattr(cic, "open_cham_soc_by_id", lambda driver, cid: open_calls.append(cid))
    delete_calls = []
    monkeypatch.setattr(cic, "click_thu_hoi_va_xoa", lambda driver: delete_calls.append(True))
    monkeypatch.setattr(cic, "click_thu_hoi_cham_soc", lambda driver: None)
    monkeypatch.setattr(cic, "_open_care_page", lambda driver, wait, row: None)
    monkeypatch.setattr(cic, "set_thoi_gian_lap", lambda driver, time_str, max_retry=2: True)
    monkeypatch.setattr(cic, "dien_thong_tin", lambda *a, **k: True)
    monkeypatch.setattr(cic, "check_trang_thai_badge", lambda driver: "Hoàn tất")
    monkeypatch.setattr(cic, "handle_popups", lambda driver: None)

    accounts = {"nguoi lap cu": {"username": "acct.cu", "password": "pw_cu"}}
    ws = _FakeWS(username="acct.goc", accounts=accounts)
    row = {"ma_bn": "BN001", "ho_ten": "Nguyễn Văn A", "care_time_str": "10:30 15/09/2026", "khoa_chuyen_den": "Khoa Khám Bệnh"}

    result = cic._input_one(ws, row, ["Điều Dưỡng Hiện Tại"], "Nội dung chăm sóc", "Người bệnh tỉnh", False)

    assert result["success"] is True
    assert open_calls == ["CARE_1"]
    assert delete_calls == [True]
    # Đổi sang đúng tài khoản người lập cũ để xóa, rồi đổi lại tài khoản gốc.
    assert ws.switch_calls == [("acct.cu", "pw_cu"), ("acct.goc", "pw_goc")]
    assert ws.config["username"] == "acct.goc"


def test_input_one_blocks_edit_when_old_creator_has_no_emr_account(monkeypatch):
    """Không tra được tài khoản EMR cho người lập phiếu cũ -> không tự xóa,
    báo lỗi rõ ràng thay vì thao tác nhầm tài khoản."""
    import clinic_input_care as cic

    monkeypatch.setattr(cic, "scan_cham_soc_cache", lambda driver, ngay, hours_needed=None: ({}, []))
    monkeypatch.setattr(cic, "kiem_tra_bang_cached", lambda *a, **k: ("EDIT", "CARE_1", "Nguoi Khong Co Tai Khoan"))
    monkeypatch.setattr(cic, "_open_care_page", lambda driver, wait, row: None)

    deleted = []
    monkeypatch.setattr(cic, "click_thu_hoi_va_xoa", lambda driver: deleted.append(True))

    ws = _FakeWS(username="acct.goc")
    row = {"ma_bn": "BN001", "ho_ten": "Nguyễn Văn A", "care_time_str": "10:30 15/09/2026", "khoa_chuyen_den": "Khoa Khám Bệnh"}

    result = cic._input_one(ws, row, ["Điều Dưỡng Hiện Tại"], "Nội dung chăm sóc", "Người bệnh tỉnh", False)

    assert result["success"] is False
    assert "Nguoi Khong Co Tai Khoan" in result["error"]
    assert deleted == []
    assert ws.switch_calls == []
