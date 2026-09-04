import json
import subprocess
import textwrap
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run_node(script: str):
    completed = subprocess.run(
        ["node", "-e", script],
        cwd=ROOT,
        text=True,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=True,
    )
    return json.loads(completed.stdout or "{}")


def test_study_variable_selection_filters_cohort_from_long_table():
    script = textwrap.dedent(
        r"""
        const assert = require('assert');
        const vs = require('./server/research/variable_selection');
        const cohort = [
          {'Mã BN': 'P001', 'Họ tên': 'A', 'Ngày ra viện': '2026-06-01'},
          {'Mã BN': 'P002', 'Họ tên': 'B', 'Ngày ra viện': '2026-06-02'},
          {'Mã BN': 'P003', 'Họ tên': 'C', 'Ngày ra viện': '2026-06-03'},
        ];
        const selection = {
          selected_variables: [{
            id: 'lab_results.hb', table: 'lab_results', name: 'lab:Hb', label: 'Hb',
            virtual_kind: 'lab_item', source_filter: { test_name_norm: 'hb' }
          }],
          conditions: [{
            variable_id: 'lab_results.hb', table: 'lab_results', name: 'lab:Hb',
            virtual_kind: 'lab_item', source_filter: { test_name_norm: 'hb' }, operator: 'not_empty'
          }]
        };
        const result = vs.filterCohortRowsByVariableSelection(cohort, selection, {
          lab_results: [
            { patient_code: 'P001', test_name_norm: 'hb', result_num: '12.1' },
            { patient_code: 'P002', test_name_norm: 'wbc', result_num: '8.0' },
          ],
        });
        assert.deepStrictEqual(result.rows.map(r => r['Mã BN']), ['P001']);
        console.log(JSON.stringify({ ok: true, count: result.rows.length }));
        """
    )
    out = run_node(script)
    assert out["ok"] is True
    assert out["count"] == 1


def test_normalize_projection_builds_selected_analysis_dataset():
    script = textwrap.dedent(
        r"""
        const assert = require('assert');
        const vs = require('./server/research/variable_selection');
        const selection = {
          selected_variables: [
            { id: 'analysis_ready.age', table: 'analysis_ready', name: 'age', label: 'Tuổi', type: 'number' },
            { id: 'lab_results.hb', table: 'lab_results', name: 'lab:Hb', label: 'Hb', virtual_kind: 'lab_item', source_filter: { test_name_norm: 'hb' } },
          ],
        };
        const built = vs.buildSelectedAnalysisDataset([
          { research_code: 'NC0001', patient_code: 'P001', patient_name: 'A', age: '68', diagnosis_raw: 'Dx' },
          { research_code: 'NC0002', patient_code: 'P002', patient_name: 'B', age: '70', diagnosis_raw: 'Dx2' },
        ], selection, {
          lab_results: [
            { patient_code: 'P001', research_code: 'NC0001', test_name_norm: 'hb', result_num: '12.1' },
            { patient_code: 'P001', research_code: 'NC0001', test_name_norm: 'hb', result_num: '11.8' },
            { patient_code: 'P002', research_code: 'NC0002', test_name_norm: 'wbc', result_num: '8.1' },
          ],
        });
        assert.strictEqual(built.rows.length, 2);
        assert(built.columns.includes('var_analysis_ready_age'));
        assert(built.columns.includes('var_lab_results_hb'));
        assert.strictEqual(built.rows[0].var_analysis_ready_age, '68');
        assert.strictEqual(built.rows[0].var_lab_results_hb, '12.1; 11.8');
        assert.strictEqual(built.rows[1].var_lab_results_hb, '');
        console.log(JSON.stringify({ ok: true, columns: built.columns.length }));
        """
    )
    out = run_node(script)
    assert out["ok"] is True
    assert out["columns"] >= 17


def test_export_redaction_removes_identity_and_admin_fields():
    script = textwrap.dedent(
        r"""
        const assert = require('assert');
        const { redactCsvTable } = require('./server/research/export_utils');
        const result = redactCsvTable(
          ['research_code', 'patient_code', 'patient_name', 'birth_date', 'address', 'insurance_card', 'diagnosis_raw', 'hb'],
          [{ research_code: 'NC1', patient_code: 'P001', patient_name: 'A', birth_date: '1950-01-01', address: 'X', insurance_card: 'BT123', diagnosis_raw: 'Dx', hb: '12' }]
        );
        assert.deepStrictEqual(result.columns, ['research_code', 'diagnosis_raw', 'hb']);
        assert.deepStrictEqual(result.rows[0], { research_code: 'NC1', diagnosis_raw: 'Dx', hb: '12' });
        console.log(JSON.stringify({ ok: true, removed: result.removed_columns.length }));
        """
    )
    out = run_node(script)
    assert out["ok"] is True
    assert out["removed"] == 5


def test_numeric_comparison_never_treats_decimal_as_date():
    script = textwrap.dedent(
        r"""
        const assert = require('assert');
        const vs = require('./server/research/variable_selection');
        assert.strictEqual(vs.compareScalar('5.6', '>', '5.10', '', 'number'), true);
        assert.strictEqual(vs.compareScalar('5.60', '=', '5.6', '', 'number'), true);
        assert.strictEqual(vs.compareScalar('31/02/2026', '>', '01/02/2026', '', 'date'), false);
        console.log(JSON.stringify({ ok: true }));
        """
    )
    out = run_node(script)
    assert out["ok"] is True


def test_last_aggregation_ignores_undated_rows_when_dated_rows_exist():
    script = textwrap.dedent(
        r"""
        const assert = require('assert');
        const vs = require('./server/research/variable_selection');
        const built = vs.buildSelectedAnalysisDataset([
          { research_code: 'NC1', patient_code: 'P1' },
        ], {
          selected_variables: [{
            id: 'lab_results.hb', table: 'lab_results', name: 'result_num',
            label: 'Hb cuối', type: 'number', aggregation: 'last'
          }],
        }, {
          lab_results: [
            { patient_code: 'P1', research_code: 'NC1', lab_datetime: '2026-06-01 08:00', result_num: '11.0' },
            { patient_code: 'P1', research_code: 'NC1', lab_datetime: '', result_num: '99.0' },
            { patient_code: 'P1', research_code: 'NC1', lab_datetime: '2026-06-02 08:00', result_num: '12.0' },
          ],
        });
        assert.strictEqual(built.rows[0].var_lab_results_hb, '12.0');
        console.log(JSON.stringify({ ok: true }));
        """
    )
    out = run_node(script)
    assert out["ok"] is True


def test_custom_fields_normalize_vietnamese_regex_and_block_reserved_columns():
    script = textwrap.dedent(
        r"""
        const assert = require('assert');
        const cfg = require('./server/research/analysis_config');
        const fields = cfg.sanitizeCustomFields([
          { name: 'diabetes', pattern: 'đái tháo đường|type 2' },
        ], { reservedColumns: ['patient_code'] });
        assert.strictEqual(fields[0].normalized_pattern, 'dai thao duong|type 2');
        const values = cfg.evaluateCustomFields(fields, 'benh nhan dai thao duong type 2');
        assert.deepStrictEqual(values, { diabetes: '1' });
        assert.deepStrictEqual(cfg.evaluateCustomFields(fields, 'khong ghi nhan'), { diabetes: '0' });
        assert.throws(() => cfg.sanitizeCustomFields([
          { name: 'patient_code', pattern: 'x' },
        ], { reservedColumns: ['patient_code'] }), /trung voi cot he thong|trùng với cột hệ thống/i);
        console.log(JSON.stringify({ ok: true }));
        """
    )
    out = run_node(script)
    assert out["ok"] is True


def test_medication_surgery_linkage_never_falls_back_to_patient_level():
    script = textwrap.dedent(
        r"""
        const assert = require('assert');
        const link = require('./server/research/encounter_linkage');
        const surgeries = [
          { patient_code: 'P1', encounter_id: 'E1', surgery_date: '2026-06-01' },
          { patient_code: 'P1', encounter_id: 'E2', surgery_date: '2026-07-01' },
          { patient_code: 'P2', encounter_id: '', surgery_date: '2026-08-01' },
        ];
        const byEncounter = link.firstSurgeryByEncounter(surgeries);
        assert.strictEqual(link.surgeryForMedicationContext(byEncounter, { patient_code: 'P1', encounter_id: 'E2' }).surgery_date, '2026-07-01');
        assert.strictEqual(link.surgeryForMedicationContext(byEncounter, { patient_code: 'P1', encounter_id: '' }), null);
        assert.strictEqual(link.surgeryForMedicationContext(byEncounter, { patient_code: 'P2', encounter_id: '' }), null);
        console.log(JSON.stringify({ ok: true }));
        """
    )
    out = run_node(script)
    assert out["ok"] is True


def test_strict_research_date_rejects_calendar_rollover():
    script = textwrap.dedent(
        r"""
        const assert = require('assert');
        const { strictLocalDate } = require('./server/research/date_utils');
        assert.strictEqual(strictLocalDate(2026, 2, 31), null);
        assert.strictEqual(strictLocalDate(2026, 13, 1), null);
        assert.strictEqual(strictLocalDate(2024, 2, 29).getDate(), 29);
        console.log(JSON.stringify({ ok: true }));
        """
    )
    out = run_node(script)
    assert out["ok"] is True
