import hchanh_fetch_safe as safe
import hchanh_fetch as core


class FakeOrderHistoryDriver:
    def __init__(self, *, has_select=True, has_all=True, settle=True):
        self.has_select = has_select
        self.has_all = has_all
        self.settle = settle
        self.value = "25"
        self.status = "0"
        self.load_calls = 0
        self.polls = 0

    def execute_script(self, script):
        if "const size = document.querySelector('#soLuongHienThi')" in script and "loadListYLenh" in script:
            if not self.has_select:
                return {"ok": False, "reason": "missing_soLuongHienThi"}
            if not self.has_all:
                return {"ok": False, "reason": "missing_all_option_1000"}
            self.value = "1000"
            self.status = "99"
            self.load_calls += 1
            return {"ok": True, "method": "loadListYLenh"}

        # _order_history_dom_state()
        self.polls += 1
        if not self.has_select:
            return {
                "has_select": False,
                "value": "",
                "has_all_option": False,
                "status_value": "",
                "has_status_select": True,
                "row_count": 0,
                "html_len": 0,
                "text_len": 0,
                "ajax_busy": 0,
            }
        changing = self.value == "1000" and not self.settle
        return {
            "has_select": True,
            "value": self.value,
            "has_all_option": self.has_all,
            "status_value": self.status,
            "has_status_select": True,
            "row_count": 25 + (self.polls if changing else (75 if self.value == "1000" else 0)),
            "html_len": 1000 + (self.polls if changing else (5000 if self.value == "1000" else 0)),
            "text_len": 500 + (self.polls if changing else (2500 if self.value == "1000" else 0)),
            "ajax_busy": 0,
        }


def test_force_show_all_selects_1000_and_all_statuses_before_accepting():
    driver = FakeOrderHistoryDriver()
    ok, state = safe._force_order_history_show_all(
        driver,
        timeout=1.0,
        poll_interval=0.01,
        stable_required=2,
    )

    assert ok is True
    assert driver.load_calls == 1
    assert state["value"] == "1000"
    assert state["status_value"] == "99"
    assert state["reason"] == "verified"


def test_force_show_all_rejects_page_without_all_option():
    driver = FakeOrderHistoryDriver(has_all=False)
    ok, state = safe._force_order_history_show_all(
        driver,
        timeout=0.2,
        poll_interval=0.01,
        stable_required=2,
    )

    assert ok is False
    assert state["reason"] == "missing_all_option_1000"
    assert driver.load_calls == 0


def test_force_show_all_rejects_dom_that_never_stabilizes():
    driver = FakeOrderHistoryDriver(settle=False)
    ok, state = safe._force_order_history_show_all(
        driver,
        timeout=0.35,
        poll_interval=0.01,
        stable_required=2,
    )

    assert ok is False
    assert state["reason"] == "show_all_not_stable_before_timeout"


def test_research_order_history_filters_unrelated_old_and_post_discharge_rows(monkeypatch):
    rows = [
        {"tg_ylenh": "08:00 01/01/2026", "ten_y_lenh": "quá cũ"},
        {"tg_ylenh": "23:00 28/02/2026", "ten_y_lenh": "trước nhập viện nhưng trong cửa sổ tiền nhập viện"},
        {"tg_ylenh": "10:00 05/03/2026", "ten_y_lenh": "trong đợt"},
        {"tg_ylenh": "08:00 11/03/2026", "ten_y_lenh": "sau ra viện"},
        {"tg_ylenh": "không rõ giờ", "ten_y_lenh": "không parse được, giữ để QA xử lý"},
    ]

    def fake_fetch(*_args, **_kwargs):
        safe._LAST_ORDER_HISTORY_SHOW_ALL_OK = True
        safe._LAST_ORDER_HISTORY_SHOW_ALL_STATE = {"reason": "verified", "value": "1000", "status_value": "99"}
        return {
            "_fetch_status": "ok",
            "rows": list(rows),
            "total": len(rows),
            "completed": len(rows),
            "incomplete": 0,
            "no_service": 0,
            "after_discharge": 1,
            "incomplete_rows": [],
            "after_discharge_rows": [rows[3]],
        }

    monkeypatch.setattr(safe, "_original_fetch_order_history", fake_fetch)
    result = safe._fetch_order_history_verified(
        object(),
        "BN_TEST",
        "02/03/2026",
        "10/03/2026",
        {},
        {"hchanh_order_history_selenium_first": True},
    )

    assert [r["ten_y_lenh"] for r in result["rows"]] == [
        "trước nhập viện nhưng trong cửa sổ tiền nhập viện",
        "trong đợt",
        "không parse được, giữ để QA xử lý",
    ]
    assert result["total"] == 3
    assert result["window_filter"]["input_rows"] == 5
    assert result["window_filter"]["dropped_before"] == 1
    assert result["window_filter"]["dropped_after"] == 1
    assert result["window_filter"]["unparsed_kept"] == 1
    assert result["window_filter"]["lookback_days"] == 3


def test_order_history_reads_main_medications_and_other_orders_as_two_sources():
    html = """
    <table><tbody><tr>
      <td>phiếu</td>
      <td>05:00 12/05/2026</td>
      <td>BS</td>
      <td><a data-content="Dự trù thuốc">DB</a></td>
      <td>KQ</td>
      <td><a data-content="(TT) Sismyodin 50mg 01v x 3 uống mỗi 8h">Y lệnh khác</a></td>
      <td>CĐCS</td>
      <td>CĐDD</td>
      <td>
        <a data-content="ANTIVIC 75 (Pregabalin) x 3 (Viên)&lt;br&gt;MAGNESI-B6 5mg+470mg x 2 (Viên)">Thuốc</a>
      </td>
      <td>DV</td>
    </tr></tbody></table>
    """
    tds = core._soup(html).find_all("td")
    fields = core._order_history_order_fields(tds, 1)
    assert "Sismyodin" in fields["y_lenh_khac"]
    assert "ANTIVIC" in fields["ten_y_lenh"]
    assert "MAGNESI-B6" in fields["ten_y_lenh"]
    assert fields["ten_y_lenh"] != fields["y_lenh_khac"]
