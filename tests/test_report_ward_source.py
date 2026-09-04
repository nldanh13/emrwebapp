# -*- coding: utf-8 -*-
"""Regression tests cho Báo cáo trực dùng chung nguồn dữ liệu Nhập bệnh phòng."""
from __future__ import annotations

import json
import subprocess
import sys
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run_node(script: str) -> dict:
    completed = subprocess.run(
        ["node", "--input-type=module", "-"],
        input=script,
        text=True,
        cwd=ROOT,
        check=True,
        capture_output=True,
    )
    return json.loads(completed.stdout.strip() or "{}")


def test_report_tab_scopes_each_patient_date_to_ward():
    source = (ROOT / "src/components/ReportTab.jsx").read_text(encoding="utf-8")
    assert "getPatientWorkflowDates(patient, [date], 'ward')" in source
    assert "scopePatientToDates(patient, dates)" in source
    assert "collectDrugRows(wardPatients, date)" in source
    assert "rows: routeFilteredRows" in source
    assert "source: 'ward'" in source


def test_shared_scope_patient_to_dates_matches_ward_logic(tmp_path):
    src = (ROOT / "src/utils/patientScope.js").read_text(encoding="utf-8")
    mod = tmp_path / "patientScope.mjs"
    mod.write_text(src, encoding="utf-8")
    script = textwrap.dedent(f"""
        import {{ getPatientWorkflowDates, scopePatientToDates }} from {json.dumps(mod.as_uri())};
        const ward = {{
          ma_bn: 'WARD',
          available_dates: ['24/08/2026', '25/08/2026'],
          day_map: {{
            '24/08/2026': {{ thoi_gian_vao_khoa: '10:00 23/08/2026', thuoc: {{ thuoc_tiem: [{{ ten_thuoc: 'A' }}] }} }},
            '25/08/2026': {{ thoi_gian_vao_khoa: '10:00 23/08/2026', thuoc: {{ thuoc_tiem: [{{ ten_thuoc: 'B' }}] }} }},
          }},
        }};
        const duty = {{
          ma_bn: 'DUTY',
          available_dates: ['24/08/2026'],
          day_map: {{
            '24/08/2026': {{ thoi_gian_vao_khoa: '18:00 24/08/2026', thuoc: {{ thuoc_tiem: [{{ ten_thuoc: 'X' }}] }} }},
          }},
        }};
        const wardDates = getPatientWorkflowDates(ward, ['24/08/2026'], 'ward');
        const dutyDates = getPatientWorkflowDates(duty, ['24/08/2026'], 'ward');
        const scoped = scopePatientToDates(ward, wardDates);
        console.log(JSON.stringify({{
          wardDates,
          dutyDates,
          scopedDates: scoped?.available_dates || [],
          activeDate: scoped?.ngay_lam || '',
          dayKeys: Object.keys(scoped?.day_map || {{}}),
        }}));
    """)
    result = run_node(script)
    assert result == {
        "wardDates": ["24/08/2026"],
        "dutyDates": [],
        "scopedDates": ["24/08/2026"],
        "activeDate": "24/08/2026",
        "dayKeys": ["24/08/2026"],
    }


def test_report_base_strict_date_empty_override_and_time_parser(tmp_path):
    src = (ROOT / "src/components/report/reportBaseUtils.js").read_text(encoding="utf-8")
    mod = tmp_path / "reportBaseUtils.mjs"
    mod.write_text(src, encoding="utf-8")
    script = textwrap.dedent(f"""
        import {{ parseDmy, getDaySchedule, extractTimes }} from {json.dumps(mod.as_uri())};
        const schedule = {{
          Monday: {{ admin: ['A'], work: ['B'], oncall: ['C'] }},
          Default: {{ admin: ['D'], work: [], oncall: [] }},
          days: {{ '2026-08-24': {{ admin: [], work: [], oncall: [] }} }},
        }};
        const parsed = extractTimes({{ gio_dung: '8 giờ, 1 viên; tốc độ 20 giọt/phút' }}, '24/08/2026');
        console.log(JSON.stringify({{
          invalidDateIsNull: parseDmy('31/02/2026') === null,
          override: getDaySchedule(schedule, '24/08/2026'),
          times: parsed.map(x => x.time),
        }}));
    """)
    result = run_node(script)
    assert result["invalidDateIsNull"] is True
    assert result["override"] == {"admin": [], "work": [], "oncall": []}
    assert result["times"] == ["08:00"]


def test_route_counts_returns_ui_array(tmp_path):
    base_src = (ROOT / "src/components/report/reportBaseUtils.js").read_text(encoding="utf-8")
    route_src = (ROOT / "src/components/report/reportRouteUtils.js").read_text(encoding="utf-8")
    base = tmp_path / "reportBaseUtils.mjs"
    route = tmp_path / "reportRouteUtils.mjs"
    base.write_text(base_src, encoding="utf-8")
    route.write_text(route_src.replace("'./reportBaseUtils.js'", "'./reportBaseUtils.mjs'"), encoding="utf-8")
    script = textwrap.dedent(f"""
        import {{ routeCounts }} from {json.dumps(route.as_uri())};
        const result = routeCounts([{{ route: 'TTM' }}, {{ route: 'TMC' }}, {{ route: 'TTM' }}]);
        console.log(JSON.stringify({{
          isArray: Array.isArray(result),
          result,
        }}));
    """)
    result = run_node(script)
    assert result["isArray"] is True
    assert sorted(result["result"], key=lambda x: x["route"]) == [
        {"route": "TMC", "count": 1},
        {"route": "TTM", "count": 2},
    ]


def test_normalized_pdf_rows_do_not_merge_orders_and_keep_minutes(tmp_path):
    sys.path.insert(0, str(ROOT / "worker"))
    from generate_report import build_cards_from_rows, render_pdf

    rows = [
        {
            "room": "101", "patientName": "NGUYEN VAN A", "patientId": "P1",
            "drugName": "Ceftriaxone 1g", "route": "TMC", "time": "08:00",
            "date": "24/08/2026", "quantity": 1, "unit": "lọ",
        },
        {
            "room": "101", "patientName": "NGUYEN VAN A", "patientId": "P1",
            "drugName": "Ceftriaxone 1g", "route": "TMC", "time": "08:00",
            "date": "24/08/2026", "quantity": 2, "unit": "lọ",
        },
        {
            "room": "101", "patientName": "NGUYEN VAN A", "patientId": "P1",
            "drugName": "Dịch truyền B", "route": "TTM", "time": "08:30",
            "date": "24/08/2026", "quantity": 1, "unit": "túi",
        },
    ]
    cards = build_cards_from_rows(rows, report_date="24/08/2026")
    assert len(cards) == 1
    assert len(cards[0]["rows"]) == 3
    assert cards[0]["rows"][0]["so_lo_map"]["08:00"] == 1
    assert cards[0]["rows"][1]["so_lo_map"]["08:00"] == 2
    assert "08:30" in cards[0]["rows"][2]["hours"]

    out = tmp_path / "ward_report.pdf"
    render_pdf(cards, str(out), 0, 23, "24/08/2026 10:00", "24/08/2026")
    assert out.exists()
    assert out.read_bytes().startswith(b"%PDF")


def test_report_token_carries_normalized_snapshot_to_python():
    route_source = (ROOT / "server/routes/report.js").read_text(encoding="utf-8")
    api_source = (ROOT / "src/api.js").read_text(encoding="utf-8")
    worker_source = (ROOT / "worker/generate_report.py").read_text(encoding="utf-8")
    assert "sanitizeReportSnapshot(req.body?.report)" in route_source
    assert "req._ottReport = entry.report || null" in route_source
    assert "args.push('--rows-input', snapshotPath)" in route_source
    assert "post('/api/report-token', report ? { report } : {})" in api_source
    assert 'ap.add_argument("--rows-input"' in worker_source
    assert "build_cards_from_rows(rows" in worker_source


def test_discharge_time_cuts_evening_and_next_day_medication_rows(tmp_path):
    module_names = [
        "reportBaseUtils", "reportRouteUtils", "reportMedicationBasics",
        "reportMedicationFlags", "reportMedicationCollect",
    ]
    for name in module_names:
        src = (ROOT / f"src/components/report/{name}.js").read_text(encoding="utf-8")
        for dep in module_names:
            src = src.replace(f"'./{dep}.js'", f"'./{dep}.mjs'")
        (tmp_path / f"{name}.mjs").write_text(src, encoding="utf-8")

    collect_uri = (tmp_path / "reportMedicationCollect.mjs").as_uri()
    script = textwrap.dedent(f"""
        import {{ collectDrugRows, collectOralDispenseData, dischargeCutoffMinutes }} from {json.dumps(collect_uri)};
        const day = {{
          date: '24/08/2026',
          ngay_ra_vien_date: '24/08/2026',
          gio_ra_vien: '13:00',
          ra_vien_hom_nay: true,
          thuoc: {{
            thuoc_uong: [
              {{ ten_thuoc: 'PARATRAMOL', duong_dung: 'Uống', gio_dung: '08:00, 16:00, 23:00', so_luong_moi_lan: 1 }},
            ],
            thuoc_tiem: [
              {{ ten_thuoc: 'PARACETAMOL 10MG/ML', duong_dung: 'TTM', gio_dung: '12:00, 20:00, 22:00', so_luong_moi_lan: 1 }},
              {{ ten_thuoc: 'THUOC RANG SANG', duong_dung: 'TMC', tg_bat_dau: '03:00 25/08/2026', so_luong_moi_lan: 1 }},
              {{ ten_thuoc: 'CHUA RO GIO', duong_dung: 'TMC', ghi_chu: 'Bơm tiêm', so_luong_moi_lan: 1 }},
            ],
          }},
        }};
        const patient = {{
          ma_bn: 'P1', ho_ten: 'NGUYEN VAN A', so_phong: 'P09',
          ngay_lam: '24/08/2026', available_dates: ['24/08/2026'],
          day_map: {{ '24/08/2026': day }},
        }};
        const rows = collectDrugRows([patient], '24/08/2026');
        const oral = collectOralDispenseData([patient], '24/08/2026');
        console.log(JSON.stringify({{
          cutoff: dischargeCutoffMinutes(patient, day, '24/08/2026'),
          rows: rows.map(r => ({{ drug: r.drugName, time: r.time, date: r.date, noTime: r.noTime }})),
          oral: oral.flatMap(p => [...p.drugs.values()]).map(d => ({{ drug: d.drugName, times: d.times, totalQty: d.totalQty }})),
        }}));
    """)
    result = run_node(script)
    assert result["cutoff"] == 13 * 60
    timed = {(row["drug"], row["time"], row["date"]) for row in result["rows"] if not row["noTime"]}
    assert ("PARATRAMOL", "08:00", "24/08/2026") in timed
    assert ("PARACETAMOL 10MG/ML", "12:00", "24/08/2026") in timed
    assert not any(time in {"16:00", "20:00", "22:00", "23:00", "03:00"} for _, time, _ in timed)
    assert result["oral"] == [{"drug": "PARATRAMOL", "times": ["08:00"], "totalQty": 1}]


def test_discharge_day_unknown_time_not_sent_to_night_prep():
    source = (ROOT / "src/components/report/DutyReport.jsx").read_text(encoding="utf-8")
    assert "row?.noTime && row?.dischargeCutoffMinutes != null" in source


def test_discharge_cutoff_hides_unknown_current_task_after_patient_left():
    source = (ROOT / "src/components/report/DutyReport.jsx").read_text(encoding="utf-8")
    assert "currentMinutes > cutoff" in source
    assert "row?.dischargeCutoffMinutes" in source
