# -*- coding: utf-8 -*-
"""worker/clinic_reports.py — in tường trình thủ thuật / phẫu thuật BHYT trong ngày, gộp 1 file."""
import os
import sys
from datetime import date

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))
WORKER = os.path.join(ROOT, 'worker')
if WORKER not in sys.path:
    sys.path.insert(0, WORKER)

import clinic_reports as cr  # noqa: E402
import clinic_monitor as cm  # noqa: E402

DAY = date(2026, 10, 12)


def _row(stt, ma_bn, bhyt=True, tt=(0, 0), pt=(0, 0)):
    services = [{"code": "KB", "total": 1, "done": 1}]
    if tt[0]:
        services.append({"code": "TT", "total": tt[0], "done": tt[1]})
    if pt[0]:
        services.append({"code": "PT", "total": pt[0], "done": pt[1]})
    return {"stt": str(stt), "ma_bn": ma_bn, "ho_ten": f"BN {stt}", "has_bhyt": bhyt, "khambenhid": f"k{stt}", "services": services}


def test_only_bhyt_patients_with_finished_procedures_are_printed():
    rows = [
        _row(3, "300", tt=(1, 1)),
        _row(1, "100", tt=(2, 1), pt=(1, 1)),
        _row(2, "200", bhyt=False, tt=(1, 1)),   # viện phí: không in
        _row(4, "400", tt=(1, 0)),               # chưa làm xong: không in
        _row(5, "500"),                          # không có thủ thuật
    ]
    out = cr.report_patients(rows)
    assert [(p["ma_bn"], p["kinds"]) for p in out] == [("100", ["tt", "pt"]), ("300", ["tt"])]


def test_pick_report_link_prefers_the_name_the_user_clicks():
    texts = ["Phiếu chỉ định", "Phiếu kết quả thủ thuật", "Phiếu kết quả thủ thuật word"]
    assert cr.pick_report_link(texts, cr.KINDS["tt"]["links"]) == 2
    assert cr.pick_report_link(texts[:2], cr.KINDS["tt"]["links"]) == 1
    assert cr.pick_report_link(["Phiếu phẫu thuật", "Giấy chứng nhận PT"], cr.KINDS["pt"]["links"]) == 0
    assert cr.pick_report_link(["Phiếu chỉ định"], cr.KINDS["pt"]["links"]) == -1


LIST_HTML = """
<table><tbody>
<tr><td>1</td><td>08:10 12/10/2026</td><td>26088582</td><td><a href="home.aspx?wpid=thuthuatnewdraw&thuthuatid=111">NGUYEN A</a></td>
    <td><span class="badge">Hoàn tất</span></td></tr>
<tr><td>2</td><td>09:10 12/10/2026</td><td>26088582</td><td><a href="home.aspx?wpid=thuthuatnewdraw&thuthuatid=112">NGUYEN A</a></td>
    <td><span class="badge">Chờ thực hiện</span></td></tr>
<tr><td>3</td><td>10:10 11/10/2026</td><td>26088582</td><td><a href="home.aspx?wpid=thuthuatnewdraw&thuthuatid=113">NGUYEN A</a></td>
    <td><span class="badge">Hoàn tất</span></td></tr>
<tr><td>4</td><td>10:30 12/10/2026</td><td>126088582</td><td><a href="home.aspx?wpid=thuthuatnewdraw&thuthuatid=114">TRAN B</a></td>
    <td><span class="badge">Hoàn tất</span></td></tr>
</tbody></table>
"""


def test_done_rows_keeps_only_finished_rows_of_that_patient_and_day():
    out = cr.done_rows(LIST_HTML, "thuthuatid", "26088582", "12/10/2026")
    assert [r["id"] for r in out] == ["111"]


class FakePrinter:
    def __init__(self, pdf_dir, found, fail=()):
        self.pdf_dir, self.found, self.fail = pdf_dir, found, set(fail)
        self.opened = []

    def find(self, kind, patients, day):
        return {p["ma_bn"]: self.found.get((kind, p["ma_bn"]), []) for p in patients}

    def print_one(self, kind, href, out):
        self.opened.append(href)
        if href in self.fail:
            raise RuntimeError("EMR chưa tạo xong file PDF của phiếu")
        with open(out, "wb") as f:
            f.write(b"%PDF-1.4 " + href.encode())


def test_collect_orders_files_by_patient_and_reuses_downloaded_reports(tmp_path):
    patients = cr.report_patients([_row(1, "100", tt=(1, 1), pt=(1, 1)), _row(2, "200", tt=(2, 2))])
    found = {("tt", "100"): [{"id": "a1", "href": "tt-a1"}], ("pt", "100"): [{"id": "p1", "href": "pt-p1"}],
             ("tt", "200"): [{"id": "b1", "href": "tt-b1"}, {"id": "b2", "href": "tt-b2"}]}
    (tmp_path / "clinic_tt_b1.pdf").write_bytes(b"%PDF-1.4 old")  # đã tải lần trước
    printer = FakePrinter(str(tmp_path), found, fail={"tt-b2"})
    files, results = cr.collect_reports(printer, patients, DAY)
    assert [os.path.basename(f) for f in files] == ["clinic_tt_a1.pdf", "clinic_pt_p1.pdf", "clinic_tt_b1.pdf"]
    assert "tt-b1" not in printer.opened  # không mở EMR lấy lại phiếu đã có
    by = {r["ma_bn"]: r for r in results}
    assert by["100"]["files"] == 2 and not by["100"]["errors"]
    assert by["200"]["files"] == 1 and "chưa tạo xong" in by["200"]["errors"][0]


def test_collect_stops_when_emr_session_is_lost(tmp_path):
    patients = cr.report_patients([_row(1, "100", tt=(2, 2))])
    found = {("tt", "100"): [{"id": "a1", "href": "tt-a1"}, {"id": "a2", "href": "tt-a2"}]}
    printer = FakePrinter(str(tmp_path), found, fail={"tt-a1"})
    files, _ = cr.collect_reports(printer, patients, DAY, on_error=lambda: True)
    assert files == [] and printer.opened == ["tt-a1"]


def test_patient_without_finished_row_on_list_is_reported(tmp_path):
    patients = cr.report_patients([_row(1, "100", tt=(1, 1))])
    files, results = cr.collect_reports(FakePrinter(str(tmp_path), {}), patients, DAY)
    assert files == [] and "Chưa thấy thủ thuật" in results[0]["errors"][0]


class _Mon:
    def __init__(self):
        self.driver = type("D", (), {"current_url": "http://emr/home.aspx"})()
        self.reopened = 0

    def _open_list(self):
        self.reopened += 1

    def close(self):
        self.driver = None


def test_run_print_reports_merges_into_one_day_file(tmp_path, monkeypatch):
    merged = {}
    monkeypatch.setattr(cm.clinic_bbhc, "merge_pdfs", lambda paths, out: merged.update(paths=paths, out=out) or out)
    rows = [_row(1, "100", tt=(1, 1)), _row(2, "200", tt=(1, 1))]
    printer = FakePrinter(str(tmp_path / "clinic_tuongtrinh"), {("tt", "100"): [{"id": "a1", "href": "tt-a1"}]})
    mon = _Mon()
    info = cm.run_print_reports(mon, rows, str(tmp_path), DAY, printer=printer)
    assert info["file"] == "clinic_tuongtrinh_20261012.pdf" and info["count"] == 1
    assert os.path.basename(merged["out"]) == "clinic_tuongtrinh_20261012.pdf"
    assert [p["ma_bn"] for p in info["problems"]] == ["200"]
    assert mon.reopened == 1  # quay về Danh sách Khám bệnh


def test_run_print_reports_without_candidates_does_not_touch_emr(tmp_path):
    mon = _Mon()
    info = cm.run_print_reports(mon, [_row(1, "100", bhyt=False, tt=(1, 1))], str(tmp_path), DAY, printer=object())
    assert info["file"] == "" and info["count"] == 0 and mon.reopened == 0
