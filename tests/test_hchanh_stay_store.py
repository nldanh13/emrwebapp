# -*- coding: utf-8 -*-
"""Kho dùng chung các đợt nằm viện lấy ở Hành chánh / Kiểm hồ sơ — Kho nghiên cứu dùng lại, khỏi quét EMR."""
import json
import os
import subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


def run_node(tmp_path, body):
    script = "const s=require('./server/services/hchanh_stay_store.js');" + body
    env = {**os.environ, 'EMR_RUNTIME_ROOT': str(tmp_path)}
    out = subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True, env=env, check=True).stdout
    return json.loads(out.strip().splitlines()[-1])


def test_record_then_reuse_when_all_files_present(tmp_path):
    res = run_node(tmp_path, """
      const profile={ma_bn:'26039467',bhyt_code:'DN123',_fetch_status:'ok'};
      const discharge={ma_bn:'26039467',ngay_ra:'28/09/2026',raw_time:'13:00 28/09/2026',tong_so_ngay_dt:'12',_fetch_status:'ok'};
      const first=s.recordHchanhFetch('26039467',{profile,discharge},{admission:'15:00 21/09/2026',now:'2026-09-28T05:00:00Z'});
      const needSurgery=s.findStoredStay('26039467','2026-09-20',['profile','discharge','surgery']);
      const enough=s.findStoredStay('26039467','2026-09-20',['profile','discharge']);
      const outside=s.findStoredStay('26039467','2026-10-05',['profile','discharge']);
      // Lần sau (Kiểm hồ sơ) lấy thêm phẫu thuật cho cùng đợt → gộp vào đợt cũ.
      s.recordHchanhFetch('26039467',{surgery:{surgeries:[{noi_dung_phau_thuat:'Kết hợp xương'}],_fetch_status:'ok'},
        discharge},{admission:'17/09/2026',source:'kiem_ho_so'});
      const full=s.findStoredStay('26039467','2026-09-17',['profile','discharge','surgery']);
      console.log(JSON.stringify({first,needSurgery,enough:enough&&{from:enough.from,to:enough.to,keys:Object.keys(enough.output),src:enough.sourceKey},
        outside,full:full&&{keys:Object.keys(full.output).sort(),src:full.sourceKey},summary:s.storeSummary().stays}));
    """)
    assert res['first'] == {'saved': True, 'from': '2026-09-17', 'to': '2026-09-28', 'files': ['profile', 'discharge']}
    assert res['needSurgery'] is None
    assert res['enough'] == {'from': '2026-09-17', 'to': '2026-09-28', 'keys': ['profile', 'discharge'], 'src': 'kho_hanh_chanh:hanh_chanh'}
    assert res['outside'] is None
    assert res['full'] == {'keys': ['discharge', 'profile', 'surgery'], 'src': 'kho_hanh_chanh:hanh_chanh+kiem_ho_so'}
    assert res['summary'] == 1


def test_errors_and_open_stays_are_not_reused(tmp_path):
    res = run_node(tmp_path, """
      const bad=s.recordHchanhFetch('1',{profile:{_fetch_status:'no_url'},discharge:{_fetch_status:'error'}},{admission:'01/09/2026'});
      // Chỉ có thông tin nền (chưa ra viện) → lưu đợt đang mở nhưng không cho dùng lại.
      const open=s.recordHchanhFetch('2',{profile:{bhyt_code:'x',_fetch_status:'ok'}},{admission:'10:00 20/09/2026'});
      console.log(JSON.stringify({bad,open,reuse:s.findStoredStay('2','2026-09-20',['profile'])}));
    """)
    assert res['bad'] == {'saved': False}
    assert res['open']['saved'] is True and res['open']['to'] == ''
    assert res['reuse'] is None
