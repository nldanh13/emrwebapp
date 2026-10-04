// "Còn thiếu gì?" trước khi xuất dữ liệu, và từ điển biến (codebook) đi kèm file dữ liệu.
import { C, FS } from '../../tokens.js';
import { Btn } from '../shared.jsx';
import { compactNumber, saveBlob } from './researchFormat.js';
import { describeStats } from './researchStats.jsx';
import { VARIABLE_ROLE_OPTIONS, sortByRole } from './studyRoles.js';
import { VARIABLE_AGGREGATIONS } from './variableCatalogModel.js';
import { computeSampleSize } from './sampleSize.js';
import { availableForSampleSize } from './SampleSizePanel.jsx';

const TONE = {
  ok: [C.green, '✓'],
  warn: [C.amber, '!'],
  bad: [C.red, '✗'],
  info: [C.text3, 'i'],
};

// Danh sách kiểm tra theo thứ tự quan trọng. Mỗi mục: { status, text, step? } (step: bước để sửa).
// presenceVariables: biến "có/không" đã chọn ở bước 2 (vd. Dùng hoạt chất: X), để gợi ý dùng làm tiêu chuẩn chọn vào.
export function readinessItems({ summary, roleOf, conditions = [], period = {}, onePerPatient = false, sampleSize = {}, anchor = null, presenceVariables = [] }) {
  const items = [];
  const variables = summary?.variables || [];
  const primary = variables.filter(v => roleOf(v) === 'primary_outcome');
  const exposure = variables.filter(v => roleOf(v) === 'exposure');
  const unassigned = variables.filter(v => !roleOf(v));
  const include = conditions.filter(c => !c.exclude);
  const exclude = conditions.filter(c => c.exclude);
  const total = Number(summary?.total || 0);

  if (!primary.length) items.push({ status: 'bad', step: 2, text: 'Chưa có biến kết cục chính. Ở bước 2, chọn vai trò "Kết cục chính" cho biến trả lời câu hỏi nghiên cứu.' });
  else {
    for (const v of primary) {
      const rate = Number(v.fill_rate || 0);
      items.push(rate >= 80
        ? { status: 'ok', text: `Kết cục chính "${v.survey_label}" có dữ liệu ở ${rate}% lượt.` }
        : { status: rate >= 50 ? 'warn' : 'bad', step: 2, text: `Kết cục chính "${v.survey_label}" chỉ có dữ liệu ở ${rate}% lượt (thiếu ${compactNumber(v.missing)}). Kiểm tra cách lấy/cửa sổ ngày, thêm tiêu chuẩn "có dữ liệu" cho biến này, hoặc nhập bổ sung qua phiếu nhập tay.` });
    }
  }
  const comparative = ['two_props', 'two_means', 'correlation'].includes(sampleSize.design);
  if (comparative && !exposure.length) items.push({ status: 'warn', step: 2, text: 'Thiết kế so sánh cần ít nhất một "Biến độc lập / yếu tố nguy cơ" để chia nhóm.' });

  if (!include.length && !period.from && !period.to) {
    items.push({ status: 'bad', step: 3, text: `Chưa có tiêu chuẩn chọn vào: đang lấy toàn bộ ${compactNumber(total)} lượt trong kho.` });
    // Chọn "Dùng hoạt chất: X" ở bước 2 chỉ thêm một cột; muốn mẫu là người bệnh dùng X thì phải là tiêu chuẩn chọn vào.
    for (const v of presenceVariables.slice(0, 3)) {
      const name = v.display_label || v.label || v.name;
      items.push({
        status: 'bad',
        text: `"${name}" đang là một biến (cột Có/Không), chưa dùng để chọn mẫu. Nếu nghiên cứu chỉ gồm người bệnh ${String(name).replace(/^Dùng /, 'dùng ').replace(/^Có /, 'có ')}, dùng nó làm tiêu chuẩn chọn vào.`,
        fix: { kind: 'include_condition', variable: v, label: 'Dùng làm tiêu chuẩn chọn vào' },
      });
    }
  }
  else items.push({ status: 'ok', text: `Chọn mẫu: ${include.length} tiêu chuẩn chọn vào${period.from || period.to ? ', có giới hạn thời gian' : ''}.` });
  if (!exclude.length) items.push({ status: 'info', step: 3, text: 'Chưa có tiêu chuẩn loại trừ (không bắt buộc, nhưng đề cương thường có).' });

  const patients = Number(summary?.cohort?.patients || 0);
  if (!onePerPatient && patients && patients < total) {
    items.push({ status: 'warn', step: 3, text: `${compactNumber(total - patients)} lượt là lượt nhập viện lặp lại của cùng người bệnh (${compactNumber(patients)} người / ${compactNumber(total)} lượt). Nếu phân tích theo người bệnh, bật "Mỗi người bệnh chỉ lấy một lượt".` });
  }

  if (anchor && summary?.anchor?.missing) {
    items.push({ status: 'warn', step: 3, text: `Không tìm thấy mốc thời gian ở ${compactNumber(summary.anchor.missing)} lượt: biến theo mốc của các lượt này sẽ trống. Có thể thêm tiêu chuẩn chọn vào "dùng thuốc" tương ứng.` });
  }

  const sparse = variables.filter(v => Number(v.fill_rate || 0) < 10 && roleOf(v) !== 'primary_outcome');
  if (sparse.length) items.push({ status: 'warn', step: 2, text: `${sparse.length} biến có dữ liệu dưới 10%: ${sparse.slice(0, 6).map(v => v.survey_label).join(', ')}${sparse.length > 6 ? '…' : ''}.` });
  if (unassigned.length) items.push({ status: 'info', step: 2, text: `${unassigned.length} biến chưa xếp vai trò.` });

  if (!sampleSize.design) items.push({ status: 'warn', text: 'Chưa tính cỡ mẫu (mục "Cỡ mẫu" bên dưới).' });
  else {
    const r = computeSampleSize(sampleSize);
    if (r.n) {
      const { usable } = availableForSampleSize(summary, roleOf);
      items.push(usable >= r.n
        ? { status: 'ok', text: `Đủ cỡ mẫu: cần ${compactNumber(r.n)}, hiện có ${compactNumber(usable)}.` }
        : { status: 'bad', text: `Chưa đủ cỡ mẫu: cần ${compactNumber(r.n)}, hiện có ${compactNumber(usable)}.` });
    } else items.push({ status: 'warn', text: `Cỡ mẫu: ${r.error}` });
  }
  if (summary?.review) items.push({ status: 'info', text: `${compactNumber(summary.review)} lượt được đánh dấu cần rà soát (giá trị bất thường hoặc thiếu mã lượt). Vẫn xuất, nên kiểm tra trước khi phân tích.` });
  return items;
}

export function ReadinessChecklist({ items, onGoStep, onFix }) {
  const blocking = items.filter(i => i.status === 'bad').length;
  const warnings = items.filter(i => i.status === 'warn').length;
  return (
    <section style={{ border: `1px solid ${blocking ? C.redBorder : warnings ? C.amberBorder : C.greenBorder}`, borderRadius: 8, background: C.surface, padding: '12px 14px', display: 'grid', gap: 8 }}>
      <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>
        Còn thiếu gì?{' '}
        <span style={{ fontSize: FS.sm, fontWeight: 600, color: blocking ? C.red : warnings ? C.amber : C.green }}>
          {blocking ? `${blocking} việc nên sửa trước khi xuất` : warnings ? `${warnings} điểm cần xem lại` : 'Đã sẵn sàng'}
        </span>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 5 }}>
        {items.map((item, i) => {
          const [color, mark] = TONE[item.status] || TONE.info;
          return (
            <li key={i} style={{ display: 'grid', gridTemplateColumns: '18px minmax(0,1fr) auto', gap: 8, alignItems: 'start', fontSize: FS.sm, color: C.text2, lineHeight: 1.45 }}>
              <span aria-hidden="true" style={{ width: 18, height: 18, borderRadius: 999, display: 'grid', placeItems: 'center', fontSize: FS.xs, fontWeight: 700, color: '#fff', background: color }}>{mark}</span>
              <span>{item.text}</span>
              {item.fix && onFix
                ? <Btn variant="solidPrimary" onClick={() => onFix(item.fix)} style={{ height: 24, fontSize: FS.xs }}>{item.fix.label}</Btn>
                : item.step && item.status !== 'ok' && onGoStep
                  ? <Btn onClick={() => onGoStep(item.step)} style={{ height: 24, fontSize: FS.xs }}>Sửa ở bước {item.step}</Btn>
                  : <span />}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

const ROLE_TEXT = Object.fromEntries(VARIABLE_ROLE_OPTIONS);
const AGG_TEXT = Object.fromEntries(VARIABLE_AGGREGATIONS);
const csvCell = (v) => {
  const s = String(v ?? '');
  return /[",\n;]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

// Từ điển biến: mỗi cột của file dữ liệu một dòng (tên cột, vai trò, nguồn, cách lấy, độ đầy đủ, mô tả).
// extra(v, i) trả thêm thông tin của biến theo thứ tự đã chọn (vd. cửa sổ ngày quanh mốc).
export function buildCodebookCsv(summary, roleOf, extra = () => ({})) {
  const header = ['STT', 'Tên cột trong file dữ liệu', 'Vai trò', 'Biến nguồn trong kho', 'Cách lấy', 'Cửa sổ ngày so với mốc', 'Có dữ liệu (%)', 'Thiếu (lượt)', 'Mô tả thống kê'];
  const indexed = (summary?.variables || []).map((v, i) => ({ ...v, _extra: extra(v, i) }));
  const rows = sortByRole(indexed, roleOf).map((v, i) => [
    i + 1,
    v.survey_label,
    ROLE_TEXT[roleOf(v) || ''] || '',
    v.source_label,
    AGG_TEXT[v.aggregation] || v.aggregation || '',
    v._extra.window || '',
    v.fill_rate,
    v.missing,
    describeStats(v.stats, v),
  ]);
  return '﻿' + [header, ...rows].map(r => r.map(csvCell).join(',')).join('\r\n') + '\r\n';
}

export function downloadCodebook(filename, summary, roleOf, extra) {
  saveBlob(filename, new Blob([buildCodebookCsv(summary, roleOf, extra)], { type: 'text/csv;charset=utf-8' }));
}
