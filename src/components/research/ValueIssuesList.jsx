// Giá trị cần kiểm lại trước khi xuất CSV: tuổi/ngày vô lý, ô không phải số, giá trị khác xa phần
// còn lại (thường do nhầm đơn vị hoặc gõ thừa số). Chỉ báo để người dùng xem lại hồ sơ; app không
// tự sửa hay bỏ giá trị nào. Hiện Mã NC (giả danh) và giá trị, không có Mã BN hay họ tên.
import { useState } from 'react';
import { C, FS } from '../../tokens.js';
import { Btn } from '../shared.jsx';
import { compactNumber, saveBlob } from './researchFormat.js';
import { valueIssuesToCsvText } from './missingByCase.js';

const PAGE = 20;

export function ValueIssuesList({ summary, fileBase = 'gia_tri_can_kiem_lai' }) {
  const [shown, setShown] = useState(PAGE);
  const [filter, setFilter] = useState('');
  if (!summary || !Number(summary.total || 0)) return null;
  const total = Number(summary.value_issues_total || 0);
  if (!total) {
    return (
      <div style={{ fontSize: FS.sm, color: C.green, fontWeight: 600 }}>
        Không thấy giá trị bất thường (tuổi, ngày, số liệu khác xa phần còn lại).
      </div>
    );
  }
  const all = summary.value_issues || [];
  const issues = filter ? all.filter(i => i.label === filter) : all;
  const list = issues.slice(0, shown);
  const download = () => {
    const blob = new Blob([`﻿${valueIssuesToCsvText(all)}`], { type: 'text/csv;charset=utf-8' });
    saveBlob(`${fileBase}.csv`, blob);
  };
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: FS.sm, color: C.text2 }}>
          <b style={{ color: C.amber }}>{compactNumber(total)}</b> giá trị ở {compactNumber(summary.value_issues_cases || 0)} lượt cần xem lại hồ sơ trước khi phân tích. App không tự sửa giá trị nào.
        </span>
        <Btn onClick={download} style={{ height: 28, marginLeft: 'auto' }} title="Mã NC, biến, giá trị và lý do; không có Mã BN hay họ tên">
          Xuất danh sách cần kiểm
        </Btn>
      </div>
      {(summary.value_issues_by_variable || []).length > 1 && (
        <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap' }}>
          <Btn variant={filter ? 'default' : 'primary'} onClick={() => { setFilter(''); setShown(PAGE); }} style={{ height: 26, fontSize: FS.xs }}>Tất cả</Btn>
          {summary.value_issues_by_variable.map(v => (
            <Btn key={v.label} variant={filter === v.label ? 'primary' : 'default'} onClick={() => { setFilter(v.label); setShown(PAGE); }} style={{ height: 26, fontSize: FS.xs }}>
              {v.label} · {compactNumber(v.count)}
            </Btn>
          ))}
        </div>
      )}
      {all.length < total && (
        <div style={{ fontSize: FS.xs, color: C.text3 }}>Đang hiện {compactNumber(all.length)} giá trị đầu tiên.</div>
      )}
      <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, overflow: 'auto', background: C.surface }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.sm, minWidth: 560 }}>
          <thead style={{ background: C.surface2 }}>
            <tr>
              {[['Mã NC', 120], ['Biến', '26%'], ['Giá trị', 130], ['Lý do', undefined]].map(([label, width]) => (
                <th key={label} style={{ width, textAlign: 'left', padding: '7px 10px', fontSize: FS.xs, color: C.text2, fontWeight: 700, borderBottom: `1px solid ${C.border2}` }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((i, idx) => (
              <tr key={`${i.research_code}_${i.column}_${idx}`} style={{ borderBottom: `1px solid ${C.border2}`, verticalAlign: 'top' }}>
                <td style={{ padding: '7px 10px', fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>{i.research_code || '(chưa có Mã NC)'}</td>
                <td style={{ padding: '7px 10px', color: C.text }}>{i.label}</td>
                <td style={{ padding: '7px 10px', color: C.text, fontWeight: 600, fontVariantNumeric: 'tabular-nums', wordBreak: 'break-word' }}>{i.value}</td>
                <td style={{ padding: '7px 10px', color: C.text2, lineHeight: 1.45 }}>{i.reason}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown < issues.length && (
        <Btn onClick={() => setShown(n => n + PAGE * 5)} style={{ height: 28, justifySelf: 'start' }}>
          Xem thêm ({compactNumber(issues.length - shown)} giá trị)
        </Btn>
      )}
    </div>
  );
}
