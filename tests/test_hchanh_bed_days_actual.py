# -*- coding: utf-8 -*-
"""Ngày giường: so_ngay_thuc không được lấy từ khoảng ngày lọc trên màn hình.

Trước đây worker tính so_ngay_thuc = date_to - date_from + 1 (khoảng lọc, thường 1 ngày) nên gần như mọi ca
bị báo "Tính tiền N ngày giường nhưng thực tế chỉ nằm 1 ngày". Máy chủ phải bỏ các giá trị cũ đó.
"""
import json
import os
import subprocess

ROOT = os.path.abspath(os.path.join(os.path.dirname(__file__), '..'))


def test_worker_no_longer_uses_filter_range_as_stay():
    src = open(os.path.join(ROOT, 'worker', 'hchanh_fetch.py'), encoding='utf-8').read()
    start = src.index('def fetch_bed_days(')
    body = src[start:src.index('\ndef ', start + 10)]
    assert 'base["so_ngay_thuc"] = max(0, (d_to - d_from).days + 1)' not in body


def test_server_ignores_stale_actual_days_and_warning():
    script = (
        "const qa=require('./server/services/hchanh/discharge_qa.js');"
        "const s=qa.sanitizeBedDays({so_ngay_tinh:7,so_ngay_thuc:1,rows:[],"
        "warnings:['Tính tiền 7 ngày giường nhưng thực tế chỉ nằm 1 ngày (dư 6 ngày).','Giường trùng giờ 10:00']});"
        "console.log(JSON.stringify(s));"
    )
    out = json.loads(subprocess.run(['node', '-e', script], cwd=ROOT, capture_output=True, text=True, check=True).stdout)
    assert out['so_ngay_thuc'] == 0 and out['so_ngay_tinh'] == 7
    assert out['warnings'] == ['Giường trùng giờ 10:00']
