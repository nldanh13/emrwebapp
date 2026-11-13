// Ca còn thiếu dữ liệu: mỗi lượt thiếu biến một dòng (Mã NC và tên biến thiếu, không có giá trị
// hay định danh), để biết cần bổ sung ca nào trước khi đem số liệu đi xử lý.
import { useState } from 'react';
import { C, FS } from '../../tokens.js';
import { Btn } from '../shared.jsx';
import { compactNumber, saveBlob } from './researchFormat.js';
import { rowsToCsvText } from './missingByCase.js';

const PAGE = 20;

export function MissingByCaseList({ cases = [], total = 0, encounters = 0, fileBase = 'ca_thieu_du_lieu' }) {
  const [shown, setShown] = useState(PAGE);
  if (!encounters) return null;
  if (!total) {
    return (
      <div style={{ fontSize: FS.sm, color: C.green, fontWeight: 600 }}>
        Mọi lượt đều có đủ dữ liệu cho các biến đã chọn.
      </div>
    );
  }
  const list = cases.slice(0, shown);
  const download = () => {
    const blob = new Blob([`﻿${rowsToCsvText(cases)}`], { type: 'text/csv;charset=utf-8' });
    saveBlob(`${fileBase}.csv`, blob);
  };
  return (
    <div style={{ display: 'grid', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <span style={{ fontSize: FS.sm, color: C.text2 }}>
          <b style={{ color: C.amber }}>{compactNumber(total)}</b> / {compactNumber(encounters)} lượt còn thiếu ít nhất một biến. Ca thiếu nhiều biến ở trên.
        </span>
        <Btn onClick={download} style={{ height: 28, marginLeft: 'auto' }} title="Danh sách Mã NC và biến còn thiếu, không có giá trị hay định danh">
          Xuất danh sách ca thiếu
        </Btn>
      </div>
      {cases.length < total && (
        <div style={{ fontSize: FS.xs, color: C.text3 }}>Đang hiện {compactNumber(cases.length)} ca thiếu nhiều nhất.</div>
      )}
      <div style={{ border: `1px solid ${C.border2}`, borderRadius: 8, overflow: 'auto', background: C.surface }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.sm, minWidth: 480 }}>
          <thead style={{ background: C.surface2 }}>
            <tr>
              {[['Mã NC', 130], ['Thiếu', 70], ['Biến còn thiếu', undefined]].map(([label, width]) => (
                <th key={label} style={{ width, textAlign: 'left', padding: '7px 10px', fontSize: FS.xs, color: C.text2, fontWeight: 700, borderBottom: `1px solid ${C.border2}` }}>{label}</th>
              ))}
            </tr>
          </thead>
          <tbody>
            {list.map((c, i) => (
              <tr key={`${c.research_code}_${i}`} style={{ borderBottom: `1px solid ${C.border2}`, verticalAlign: 'top' }}>
                <td style={{ padding: '7px 10px', fontWeight: 700, color: C.text, fontVariantNumeric: 'tabular-nums' }}>
                  {c.research_code || '(chưa có Mã NC)'}
                  {c.needs_review && <div style={{ fontSize: FS.xs, color: C.red, fontWeight: 600 }}>Cần xem lại</div>}
                </td>
                <td style={{ padding: '7px 10px', color: C.text2, fontVariantNumeric: 'tabular-nums' }}>{compactNumber(c.missing_count)}</td>
                <td style={{ padding: '7px 10px', color: C.text2, lineHeight: 1.45 }}>{(c.missing || []).join(' · ')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {shown < cases.length && (
        <Btn onClick={() => setShown(n => n + PAGE * 5)} style={{ height: 28, justifySelf: 'start' }}>
          Xem thêm ({compactNumber(cases.length - shown)} ca)
        </Btn>
      )}
    </div>
  );
}
