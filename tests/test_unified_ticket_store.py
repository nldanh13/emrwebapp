# -*- coding: utf-8 -*-
import json
import os
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]


def run_node(js: str):
    env = os.environ.copy()
    proc = subprocess.run(
        ['node', '-e', js],
        cwd=str(ROOT),
        text=True,
        capture_output=True,
        env=env,
        timeout=20,
    )
    assert proc.returncode == 0, proc.stderr + proc.stdout
    return json.loads(proc.stdout)


def test_unified_ticket_store_migrates_legacy_admin_and_keeps_scoped_views(tmp_path: Path):
    runtime = tmp_path / 'runtime'
    (runtime / 'admin_workflow').mkdir(parents=True)
    (runtime / 'admin_workflow' / 'ticket_store.json').write_text(json.dumps({
        'version': 2,
        'tickets': [{
            'ticketId': 'AW-001',
            'patientId': 'BN001',
            'patientName': 'Nguyen Van A',
            'room': 'P1',
            'status': 'OPEN',
            'issues': [{'title': 'Thiếu giấy ra viện', 'severity': 'error'}],
        }],
    }, ensure_ascii=False), encoding='utf-8')

    js = f"""
    const fs = require('fs');
    const path = require('path');
    const ctx = {{ dir: {json.dumps(str(runtime))}, sid: 'pytest' }};
    const unified = require('./server/services/unified_ticket_store');
    const hchanh = require('./server/services/hchanh/ticket_store');
    const admin = require('./server/services/adminWorkflow/repair_ticket');
    hchanh.upsertTicket(ctx, 'BN002', {{ ho_ten: 'Tran Thi B', phong: 'P2', scope_default: 'discharge' }}, {{}}, {{ issues: [{{ title: 'Sai ngày giường', severity: 'warn' }}] }});
    const all = unified.readUnifiedTicketStore(ctx);
    const hc = hchanh.readTicketStore(ctx);
    const aw = admin.readTicketStore(ctx);
    const canonicalExists = fs.existsSync(unified.canonicalTicketPath(ctx));
    console.log(JSON.stringify({{
      all: all.tickets.map(t => [t.ticketId, t.source_scope, t.patientId, t.ma_bn]).sort(),
      hc: hc.tickets.map(t => t.ticketId),
      aw: aw.tickets.map(t => t.ticketId),
      canonicalExists,
    }}));
    """
    out = run_node(js)
    assert out['canonicalExists'] is True
    assert ['AW-001', 'admin_workflow', 'BN001', 'BN001'] in out['all']
    assert any(row[1] == 'hchanh' and row[2] == 'BN002' for row in out['all'])
    assert out['aw'] == ['AW-001']
    assert len(out['hc']) == 1


def test_patients_route_syntax_after_v2_fallback_patch():
    proc = subprocess.run(
        ['node', '--check', 'server/routes/patients.js'],
        cwd=str(ROOT),
        text=True,
        capture_output=True,
        timeout=20,
    )
    assert proc.returncode == 0, proc.stderr + proc.stdout
