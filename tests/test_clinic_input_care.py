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

    def switch_account_to(self, username, password, ma_bn, allow_completed=False, reopen=None):
        return self._switch_account_to(username, password, ma_bn, reopen)

    def switch_to_creator_account(self, creator, ma_bn, reopen=None):
        account = self.accounts.get((creator or "").strip().lower())
        if not account:
            return False
        return self._switch_account_to(account["username"], account["password"], ma_bn, reopen)

    def restore_account(self, original_username, original_password, ma_bn, reopen=None):
        if not original_username or self.config.get("username") == original_username:
            return
        self._switch_account_to(original_username, original_password, ma_bn, reopen)


class _NurseWS(_FakeWS):
    """Mọi điều dưỡng đều có tài khoản EMR; ghi lại lần lượt đã đăng nhập tài khoản của ai."""

    def __init__(self, missing=()):
        super().__init__()
        self.logged_in_as = []
        self.missing = set(missing)

    def switch_to_creator_account(self, creator, ma_bn, reopen=None):
        if creator in self.missing:
            return False
        self.logged_in_as.append(creator)
        return True


def _nurse_ws(monkeypatch, no_account=(), cannot_login=()):
    import clinic_input_care as cic
    monkeypatch.setattr(cic, "get_emr_account_for_nurse",
                        lambda name: None if name in no_account else {"username": name, "password": "pw"})
    return _NurseWS(missing=cannot_login)


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
    # EMR chỉ cho tài khoản người lập phiếu cũ xóa phiếu đó.
    monkeypatch.setattr(cic, "click_thu_hoi_va_xoa", lambda driver: delete_calls.append(ws.config["username"]) or ws.config["username"] == "acct.cu")
    monkeypatch.setattr(cic, "click_thu_hoi_cham_soc", lambda driver: None)
    monkeypatch.setattr(cic, "_click_add_care", lambda driver, wait: None)
    monkeypatch.setattr(cic, "_open_care_page", lambda driver, wait, row: None)
    monkeypatch.setattr(cic, "set_thoi_gian_lap", lambda driver, time_str, max_retry=2: True)
    monkeypatch.setattr(cic, "dien_thong_tin", lambda *a, **k: True)
    monkeypatch.setattr(cic, "check_trang_thai_badge", lambda driver: "Hoàn tất")
    monkeypatch.setattr(cic, "handle_popups", lambda driver: None)

    accounts = {"nguoi lap cu": {"username": "acct.cu", "password": "pw_cu"}}
    monkeypatch.setattr(cic, "get_emr_account_for_nurse", lambda name: accounts.get((name or "").strip().lower()))
    ws = _FakeWS(username="acct.goc", accounts=accounts)
    row = {"ma_bn": "BN001", "ho_ten": "Nguyễn Văn A", "care_time_str": "10:30 15/09/2026", "khoa_chuyen_den": "Khoa Khám Bệnh"}

    result = cic._input_one(ws, row, ["Điều Dưỡng Hiện Tại"], "Nội dung chăm sóc", "Người bệnh tỉnh", False)

    assert result["success"] is True
    assert open_calls == ["CARE_1", "CARE_1"]
    assert delete_calls == ["acct.goc", "acct.cu"]  # thử tài khoản đang dùng trước
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
    monkeypatch.setattr(cic, "open_cham_soc_by_id", lambda driver, cid: None)
    monkeypatch.setattr(cic, "click_thu_hoi_va_xoa", lambda driver: deleted.append(True) and False)
    monkeypatch.setattr(cic, "get_emr_account_for_nurse", lambda name: None)

    ws = _FakeWS(username="acct.goc")
    row = {"ma_bn": "BN001", "ho_ten": "Nguyễn Văn A", "care_time_str": "10:30 15/09/2026", "khoa_chuyen_den": "Khoa Khám Bệnh"}

    result = cic._input_one(ws, row, ["Điều Dưỡng Hiện Tại"], "Nội dung chăm sóc", "Người bệnh tỉnh", False)

    assert result["success"] is False
    assert "Nguoi Khong Co Tai Khoan" in result["error"] and "Xóa tay" in result["error"]
    assert deleted == [True]  # chỉ thử bằng tài khoản đang dùng, EMR không cho
    assert ws.switch_calls == []


def test_nurse_comes_from_clinic_schedule_then_shared_shift(monkeypatch):
    import clinic_input_care as cic

    config = {
        "clinic_nurse_schedule": {
            "days": {"2026-07-20": {"work": ["ĐD Phòng khám Ngày"]}},
            "Monday": {"work": ["ĐD Phòng khám Thứ hai"]},
        },
        "ten_dieu_duong": {},
    }
    # 20/07/2026 có lịch riêng theo ngày.
    assert cic._effective_nurses({}, config, "08:25 20/07/2026", []) == ["ĐD Phòng khám Ngày"]
    # 27/07/2026 là thứ hai, không có lịch riêng -> lấy lịch theo thứ.
    assert cic._effective_nurses({}, config, "08:25 27/07/2026", []) == ["ĐD Phòng khám Thứ hai"]
    # Không có lịch Phòng khám -> dùng lịch ca chung như bệnh phòng.
    monkeypatch.setattr(cic, "get_nurse_by_shift", lambda time_str, cfg: "ĐD Ca chung")
    assert cic._effective_nurses({}, {"ten_dieu_duong": {}}, "08:25 21/07/2026", []) == ["ĐD Ca chung"]


def test_pain_location_from_first_order_replaces_only_pain_line():
    import clinic_input_care as cic

    location, text = cic._pain_suggestion_from_first_order(cic.DEFAULT_DIEN_BIEN, "Té ngã, đau cổ tay trái, sưng nề")
    assert location
    assert "cổ tay" in location.lower()
    lines = text.split("\n")
    assert len(lines) == len(cic.DEFAULT_DIEN_BIEN.split("\n"))
    assert "Đau vùng tổn thương" not in lines
    assert lines[0] == "Phòng khám Chấn thương chỉnh hình - Thần kinh nhận"


# ── 2 phiếu chăm sóc: Khoa Khám Bệnh chuyển + Khoa nhận ─────────────────────

def test_care_sheets_builds_clinic_and_ward_sheet_with_user_vitals():
    import clinic_input_care as cic

    row = {"care_time_str": "08:49 12/10/2026", "dien_bien": "Phòng khám Chấn thương chỉnh hình - Thần kinh nhận\nNgười bệnh tỉnh",
           "vitals": {"mach": "80", "nhiet_do": "37", "huyet_ap": "120/80", "nhip_tho": "20"}}
    kham, khoa = cic.care_sheets(row)
    assert kham["time_str"] == "08:49 12/10/2026" and kham["vitals"] is None
    assert kham["cham_soc"] == "Kính chuyển Khoa Chấn Thương chỉnh hình - Thần kinh nhận\nHồ sơ"
    assert khoa["time_str"] == "09:04 12/10/2026"
    assert khoa["dien_bien"] == "Khoa Chấn Thương chỉnh hình - Thần kinh nhận\nNgười bệnh tỉnh"
    assert khoa["cham_soc"].splitlines() == ["Nhận HS", "Lấy dấu hiệu sinh tồn", "Trình Bs trực",
                                            "Hướng dẫn nội quy khoa phòng", "Thực hiện CLS"]
    assert khoa["vitals"]["huyet_ap"] == "120/80"


def test_ward_vitals_blank_uses_usual_care_fill_but_typed_values_must_be_valid():
    import clinic_input_care as cic

    assert cic.vitals_errors({}) == []  # trống: điền như phiếu chăm sóc thường
    assert cic.vitals_errors({"mach": "80", "nhiet_do": "37,5", "huyet_ap": "120/80", "nhip_tho": "20"}) == []
    errors = cic.vitals_errors({"mach": "8", "nhiet_do": "", "huyet_ap": "120", "nhip_tho": "20"})
    assert len(errors) == 2 and any("Mạch" in e for e in errors) and any("Huyết áp" in e for e in errors)


def test_sheet_done_only_for_completed_sheets():
    import clinic_input_care as cic

    kham, khoa = cic.care_sheets({"care_time_str": "08:49 12/10/2026"})
    draft = {"time_full": "08:49 12/10/2026", "date": "12/10/2026", "status": "Mới", "dien_bien": "", "cham_soc": ""}
    assert not cic.sheet_done([draft], kham)
    assert cic.sheet_done([{**draft, "status": "Hoàn tất"}], kham)
    # Khoa tự lập phiếu nhận ở giờ khác vẫn tính là đã có.
    ward = {"time_full": "10:30 12/10/2026", "date": "12/10/2026", "status": "Hoàn tất",
            "dien_bien": "Khoa Chấn Thương chỉnh hình - Thần kinh nhận\nNgười bệnh tỉnh", "cham_soc": "Nhận HS"}
    assert cic.sheet_done([ward], khoa)
    assert not cic.sheet_done([{**ward, "date": "11/10/2026"}], khoa)
    assert not cic.sheet_done([{**draft, "status": "Hoàn tất"}], khoa)


def test_input_patient_enters_both_sheets_and_skips_completed_one(monkeypatch):
    import clinic_input_care as cic

    calls = []

    def fake_input_one(ws, row, nurses, care, dien_bien, needs_vitals, vitals=None, done_check=None, require_done=False):
        calls.append((row["care_time_str"], care.splitlines()[0], vitals))
        if row["care_time_str"] == "08:49 12/10/2026":
            return {"success": True, "skipped": True}
        return {"success": True}

    monkeypatch.setattr(cic, "_input_one", fake_input_one)
    vitals = {"mach": "80", "nhiet_do": "37", "huyet_ap": "120/80", "nhip_tho": "20"}
    sheets = cic.care_sheets({"care_time_str": "08:49 12/10/2026", "vitals": vitals})
    res = cic._input_patient(_nurse_ws(monkeypatch), {"ma_bn": "1"}, ["ĐD A"], sheets, False)
    assert res["success"] is True and not res.get("skipped")
    assert [c[0] for c in calls] == ["08:49 12/10/2026", "09:04 12/10/2026"]
    assert calls[0][2] == {} and calls[1][2] == vitals
    assert res["sheets"][0].endswith("đã có") and res["sheets"][1].endswith("đã nhập")


def test_input_patient_stops_before_emr_when_ward_vitals_wrong_or_time_before_admission(monkeypatch):
    import clinic_input_care as cic

    calls = []
    monkeypatch.setattr(cic, "_input_one", lambda *a, **k: calls.append((a, k)) or {"success": True})
    sheets = cic.care_sheets({"care_time_str": "08:49 12/10/2026", "vitals": {"mach": "8"}})
    res = cic._input_patient(_nurse_ws(monkeypatch), {}, ["ĐD A"], sheets, False)
    assert res["success"] is False and "Mạch" in res["error"] and calls == []  # không ghi phiếu nào
    sheets = cic.care_sheets({"care_time_str": "08:49 12/10/2026", "khoa_time_str": "08:30 12/10/2026"})
    res = cic._input_patient(_nurse_ws(monkeypatch), {}, ["ĐD A"], sheets, False)
    assert res["success"] is False and "phải sau T/G vào" in res["error"] and calls == []


def test_ward_sheet_with_blank_vitals_asks_usual_vitals_fill(monkeypatch):
    import clinic_input_care as cic

    calls = []
    monkeypatch.setattr(cic, "_input_one", lambda *a, **k: calls.append((a[5], k["vitals"])) or {"success": True})
    sheets = cic.care_sheets({"care_time_str": "08:49 12/10/2026", "vitals": {"mach": "90"}})
    assert cic._input_patient(_nurse_ws(monkeypatch), {}, ["ĐD A"], sheets, False)["success"] is True
    # phiếu 1 không sinh hiệu; phiếu 2 có sinh hiệu: mạch người dùng gõ, còn lại điền như phiếu thường
    assert calls == [(False, {}), (True, {"mach": "90"})]


def test_ward_sheet_seen_done_at_search_needs_no_vitals_but_is_never_written_blind(monkeypatch):
    import clinic_input_care as cic

    calls = []

    def fake_input_one(ws, row, nurses, care, dien_bien, needs_vitals, vitals=None, done_check=None, require_done=False):
        calls.append((row["care_time_str"], vitals, require_done))
        return {"success": True, "skipped": True}

    monkeypatch.setattr(cic, "_input_one", fake_input_one)
    sheets = cic.care_sheets({"care_time_str": "08:49 12/10/2026", "sheets_done": {"kham": False, "khoa": True}})
    res = cic._input_patient(_nurse_ws(monkeypatch), {}, ["ĐD A"], sheets, False)
    assert res["success"] is True
    assert calls[1] == ("09:04 12/10/2026", None, True)


def test_dien_thong_tin_uses_typed_vitals_and_usual_values_for_blank(monkeypatch):
    import care_form_actions as actions

    typed = {}

    class El:
        def __init__(self, key):
            self.key = key

        def is_displayed(self):
            return True

        def clear(self):
            pass

        def click(self):
            pass

        def send_keys(self, value):
            if isinstance(value, str) and self.key not in typed:
                typed[self.key] = value

    class Driver:
        def find_element(self, _by, key):
            return El(key)

        def execute_script(self, *a, **k):
            return None

        class switch_to:
            active_element = El("active")

    monkeypatch.setattr(actions.time, "sleep", lambda *_a: None)
    actions.dien_thong_tin(Driver(), 9, "09:04 12/10/2026", "Nhận HS", ["ĐD A"], "Khoa nhận",
                           needs_vitals=True, vitals={"mach": "92"})
    assert typed["txtMachTrenlan"] == "92"
    assert typed["txtNhietDo"] == "37" and typed["txtNhipTho"] == "20"
    assert typed["txtHuyetAp"] in {"120/80", "110/70", "130/80"}


def test_ward_sheet_creator_is_oncall_nurse_from_schedule(monkeypatch):
    import clinic_input_care as cic

    cfg = {"ten_dieu_duong": {"Default": {"work": ["ĐD Ca Làm"], "oncall": ["ĐD Trực"]}}}
    assert cic.ward_oncall_nurse(cfg, "09:04 12/10/2026") == "ĐD Trực"

    calls = []
    monkeypatch.setattr(cic, "_input_one", lambda ws, row, nurses, *a, **k: calls.append(nurses) or {"success": True})
    sheets = cic.care_sheets({"care_time_str": "08:49 12/10/2026"})
    sheets[1]["nurses"] = ["ĐD Trực"]
    assert cic._input_patient(_nurse_ws(monkeypatch), {}, ["ĐD Phòng Khám"], sheets, False)["success"] is True
    assert calls == [["ĐD Phòng Khám"], ["ĐD Trực"]]

    calls.clear()
    sheets[1]["nurses"] = []
    res = cic._input_patient(_nurse_ws(monkeypatch), {}, ["ĐD Phòng Khám"], sheets, False)
    assert res["success"] is False and "chưa có người trực" in res["error"] and calls == []


def test_each_sheet_is_entered_with_its_own_nurse_account(monkeypatch):
    """EMR không cho Thu hồi để đổi Người lập: phiếu 1 lập bằng tài khoản ĐD phòng khám, phiếu 2 bằng tài khoản người trực."""
    import clinic_input_care as cic

    ws = _nurse_ws(monkeypatch)
    order = []
    monkeypatch.setattr(cic, "_input_one", lambda w, row, nurses, *a, **k: order.append((list(w.logged_in_as), nurses)) or {"success": True})
    sheets = cic.care_sheets({"care_time_str": "08:49 12/10/2026"})
    sheets[1]["nurses"] = ["ĐD Trực"]
    assert cic._input_patient(ws, {"ma_bn": "1"}, ["ĐD Phòng Khám"], sheets, False)["success"] is True
    assert order == [(["ĐD Phòng Khám"], ["ĐD Phòng Khám"]), (["ĐD Phòng Khám", "ĐD Trực"], ["ĐD Trực"])]


def test_sheet_already_done_does_not_switch_account(monkeypatch):
    import clinic_input_care as cic

    ws = _nurse_ws(monkeypatch, no_account={"ĐD Trực"})
    monkeypatch.setattr(cic, "_input_one", lambda *a, **k: {"success": True, "skipped": True})
    sheets = cic.care_sheets({"care_time_str": "08:49 12/10/2026", "sheets_done": {"kham": False, "khoa": True}})
    sheets[1]["nurses"] = ["ĐD Trực"]
    assert cic._input_patient(ws, {}, ["ĐD Phòng Khám"], sheets, False)["success"] is True
    assert ws.logged_in_as == ["ĐD Phòng Khám"]


def test_missing_nurse_account_blocks_before_any_emr_write(monkeypatch):
    import clinic_input_care as cic

    calls = []
    monkeypatch.setattr(cic, "_input_one", lambda *a, **k: calls.append(a) or {"success": True})
    sheets = cic.care_sheets({"care_time_str": "08:49 12/10/2026"})
    sheets[1]["nurses"] = ["ĐD Trực"]
    ws = _nurse_ws(monkeypatch, no_account={"ĐD Trực"})
    res = cic._input_patient(ws, {}, ["ĐD Phòng Khám"], sheets, False)
    assert res["success"] is False and "chưa có tài khoản EMR của ĐD Trực" in res["error"]
    assert calls == [] and ws.logged_in_as == []  # không ghi phiếu 1 rồi mới báo thiếu phiếu 2

    ws = _nurse_ws(monkeypatch, cannot_login={"ĐD Trực"})
    res = cic._input_patient(ws, {}, ["ĐD Phòng Khám"], sheets, False)
    assert res["success"] is False and "không đăng nhập được tài khoản EMR của ĐD Trực" in res["error"]
    assert len(calls) == 1  # phiếu 1 đã lập bằng tài khoản ĐD phòng khám, phiếu 2 không lập dưới tên người khác


def test_open_care_page_uses_current_login_session_after_switching_account(monkeypatch):
    """Link hồ sơ quét bằng tài khoản bác sĩ mang usid/st của phiên đó; đổi sang tài khoản điều dưỡng
    (Chrome mới) mà mở nguyên link cũ thì EMR đẩy về trang đăng nhập."""
    import clinic_input_care as cic

    monkeypatch.setattr(cic, "wait_after_action", lambda *a, **k: None)
    monkeypatch.setattr(cic, "_verify_opened_patient", lambda driver, row: True)

    class Driver:
        current_url = "http://emr/home.aspx?scope=sys&lang=vi&usid=NEW_SID&st=NEW_ST&wpid=homedraw"

        def __init__(self):
            self.opened = []

        def get(self, url):
            self.opened.append(url)

        def find_elements(self, *_a):
            return [object()]

    d = Driver()
    row = {"nursing_url": "http://emr/home.aspx?scope=sys&lang=vi&usid=OLD_SID&st=OLD_ST&wpid=dieuduongdraw&noitruid=42"}
    cic._open_care_page(d, None, row)
    q = dict(cic.parse_qsl(cic.urlparse(d.opened[0]).query))
    assert q["usid"] == "NEW_SID" and q["st"] == "NEW_ST"
    assert q["wpid"] == "dieuduongdraw" and q["noitruid"] == "42"


def test_order_seeds_skips_first_order_for_saved_rows_but_rechecks_sheets(monkeypatch):
    """Nội dung đã lưu từ lần tìm trước: không mở lại lịch sử y lệnh, vẫn đọc lại phiếu đã có."""
    import contextlib
    import clinic_input_care as cic

    out = {}
    opened = []
    monkeypatch.setattr(cic, "_build_config", lambda req: {"url_login": "u", "username": "a", "password": "b"})
    monkeypatch.setattr(cic, "_validate_request", lambda req: ("12/10/2026", "Khoa Khám Bệnh"))
    monkeypatch.setattr(cic, "open_session", lambda *a, **k: contextlib.nullcontext(_FakeWS()))
    monkeypatch.setattr(cic, "scan_matching_rows", lambda *a, **k: [])
    monkeypatch.setattr(cic, "_resolve_doctor_history_url", lambda req, rows: opened.append(req["ma_bn"]) or "http://emr/h")
    monkeypatch.setattr(cic, "_read_first_order_seed", lambda driver, url: {"seed_dien_bien": "Đau gối phải"})
    monkeypatch.setattr(cic, "_pain_suggestion_from_first_order", lambda t, raw: ("gối phải", "Đau gối phải"))
    monkeypatch.setattr(cic, "_read_sheets_done", lambda ws, req, rows: {"sheets_done": {"kham": True, "khoa": False}})
    monkeypatch.setattr(cic, "_write_json", lambda path, data: out.update(data))
    req = {"rows": [{"ma_bn": "1", "client_key": "1::a"}, {"ma_bn": "2", "client_key": "2::b", "skip_seed": True}]}
    assert cic._fetch_order_seeds(req, "out.json") == 0
    assert opened == ["1"]
    by = {r["ma_bn"]: r for r in out["results"]}
    assert by["2"]["seed_skipped"] and by["2"]["sheets_done"] == {"kham": True, "khoa": False}
    assert by["1"]["suggestion_available"] and out["status"] == "ok"
    assert "Giữ nội dung đã lưu của 1 người bệnh" in out["message"]


def test_add_care_button_is_clicked_even_when_emr_chat_widget_covers_it(monkeypatch):
    """Tài khoản điều dưỡng có khung chat oneiss (iframe cố định góc phải) che nút Thêm chăm sóc:
    bấm thường bị 'element click intercepted'."""
    import clinic_input_care as cic

    class Btn:
        def click(self):
            raise RuntimeError("element click intercepted: Other element would receive the click: <iframe id=\"oneiss-widget\">")

    class Driver:
        def __init__(self):
            self.scripts = []

        def execute_script(self, script, *args):
            self.scripts.append(script)

    class Wait:
        def until(self, cond):
            return Btn()

    d = Driver()
    cic._click_add_care(d, Wait())
    assert any("oneiss-widget" in s for s in d.scripts)  # ẩn khung chat
    assert any("arguments[0].click()" in s for s in d.scripts)  # bấm bằng JS, không bị che


def test_input_logs_failure_reason_and_hides_raw_selenium_text(monkeypatch, capsys):
    """Log tác vụ phải ghi người bệnh nào lỗi ở bước nào; giao diện không hiện nguyên traceback Selenium."""
    import contextlib
    import clinic_input_care as cic

    ws = _FakeWS()
    ws.results = {}
    ws.mark_failed = lambda key, err: ws.results.__setitem__(key, {"success": False, "error": str(err)})
    ws.mark_skipped = lambda key, reason: ws.results.__setitem__(key, {"success": True, "skipped": True})
    monkeypatch.setattr(cic, "_build_config", lambda req: {})
    monkeypatch.setattr(cic, "_validate_request", lambda req: ("12/10/2026", "Khoa Khám Bệnh"))
    monkeypatch.setattr(cic, "open_session", lambda *a, **k: contextlib.nullcontext(ws))
    row = {"ma_bn": "26100091", "care_time_str": "09:22 12/10/2026", "dieu_duong": "ĐD A"}
    monkeypatch.setattr(cic, "scan_matching_rows", lambda *a, **k: [dict(row)])
    monkeypatch.setattr(cic, "ward_oncall_nurse", lambda config, t: "ĐD Trực")

    def boom(*a, **k):
        raise RuntimeError("Message: no such element\nStacktrace: chromedriver!GetHandleVerifier")

    monkeypatch.setattr(cic, "_input_patient", boom)
    assert cic._input({"rows": [row]}, "out.json") == 2
    err = list(ws.results.values())[0]["error"]
    assert err.startswith("Lỗi khi thao tác trên EMR") and "Stacktrace" not in err
    assert "LỖI: Lỗi khi thao tác trên EMR" in capsys.readouterr().out


def test_old_sheet_made_with_doctor_login_is_deleted_with_that_login_then_entered_by_nurse(monkeypatch):
    """Lần nhập trước tạo phiếu bằng tài khoản bác sĩ (trước khi chuyển sang tài khoản điều dưỡng).
    Điều dưỡng không xóa được phiếu đó: xóa bằng tài khoản đăng nhập (bác sĩ), rồi lập lại bằng tài khoản điều dưỡng."""
    import clinic_input_care as cic

    monkeypatch.setattr(cic, "scan_cham_soc_cache", lambda driver, ngay, hours_needed=None: ({}, []))
    monkeypatch.setattr(cic, "kiem_tra_bang_cached", lambda *a, **k: ("UPDATE", "CARE_9", "BS Trần Sơn"))
    monkeypatch.setattr(cic, "open_cham_soc_by_id", lambda driver, cid: None)
    monkeypatch.setattr(cic, "_open_care_page", lambda driver, wait, row: None)
    monkeypatch.setattr(cic, "get_emr_account_for_nurse", lambda name: None)  # bác sĩ không có tài khoản điều dưỡng
    ws = _FakeWS(username="lndieu")
    ws.clinic_login = {"username": "tqson", "password": "pw_bs"}
    deleted_by = []
    monkeypatch.setattr(cic, "click_thu_hoi_va_xoa", lambda driver: ws.config["username"] == "tqson" and not deleted_by.append("tqson"))
    created_by = []
    monkeypatch.setattr(cic, "_click_add_care", lambda driver, wait: created_by.append(ws.config["username"]))
    monkeypatch.setattr(cic, "set_thoi_gian_lap", lambda driver, time_str, max_retry=2: True)
    monkeypatch.setattr(cic, "dien_thong_tin", lambda *a, **k: True)
    monkeypatch.setattr(cic, "check_trang_thai_badge", lambda driver: "Hoàn tất")
    monkeypatch.setattr(cic, "handle_popups", lambda driver: None)
    monkeypatch.setattr(cic.time, "sleep", lambda *_a: None)

    row = {"ma_bn": "26100091", "care_time_str": "09:22 12/10/2026"}
    res = cic._input_one(ws, row, ["Lê Ngọc Diệu"], "Kính chuyển", "Phòng khám nhận", False)
    assert res["success"] is True
    assert deleted_by == ["tqson"]
    assert created_by == ["lndieu"]  # phiếu mới lập bằng tài khoản điều dưỡng
    assert ws.switch_calls == [("tqson", "pw_bs"), ("lndieu", "pw_goc")]


def test_update_own_old_sheet_edits_in_place_without_adding_new(monkeypatch):
    """Phiếu cũ cùng giờ của chính người lập (vd còn 'Mới'): Thu hồi rồi sửa tại chỗ, không bấm Thêm (tránh trùng)."""
    import clinic_input_care as cic

    monkeypatch.setattr(cic, "scan_cham_soc_cache", lambda driver, ngay, hours_needed=None: ({}, []))
    monkeypatch.setattr(cic, "kiem_tra_bang_cached", lambda *a, **k: ("UPDATE", "CARE_2", "Lê Ngọc Diệu"))
    monkeypatch.setattr(cic, "open_cham_soc_by_id", lambda driver, cid: None)
    monkeypatch.setattr(cic, "click_thu_hoi_cham_soc", lambda driver: True)
    monkeypatch.setattr(cic, "_open_care_page", lambda driver, wait, row: None)
    added = []
    monkeypatch.setattr(cic, "_click_add_care", lambda driver, wait: added.append(True))
    monkeypatch.setattr(cic, "set_thoi_gian_lap", lambda driver, time_str, max_retry=2: True)
    monkeypatch.setattr(cic, "dien_thong_tin", lambda *a, **k: True)
    monkeypatch.setattr(cic, "check_trang_thai_badge", lambda driver: "Hoàn tất")
    monkeypatch.setattr(cic, "handle_popups", lambda driver: None)
    monkeypatch.setattr(cic.time, "sleep", lambda *_a: None)
    ws = _FakeWS(username="lndieu", accounts={"lê ngọc diệu": {"username": "lndieu", "password": "pw"}})
    res = cic._input_one(ws, {"ma_bn": "1", "care_time_str": "09:22 12/10/2026"}, ["Lê Ngọc Diệu"], "Kính chuyển", "PK nhận", False)
    assert res["success"] is True and added == [] and ws.switch_calls == []
