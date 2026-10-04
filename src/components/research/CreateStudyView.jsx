// Tạo nghiên cứu / xuất dữ liệu theo phiếu, từ dữ liệu đã có trong kho (không mở EMR), 4 bước:
//   1 Thông tin & phiếu: tên, mốc thời gian, dán nguyên các dòng biến của phiếu thu thập
//   2 Ghép biến: app tự ghép từng dòng phiếu với một biến trong kho (đổi được), thêm biến khác
//   3 Điều kiện chọn mẫu (không bắt buộc)
//   4 Kiểm tra & xuất: sàng lọc mẫu theo từng điều kiện, thống kê mô tả, Xuất CSV ngay;
//     "Lưu thành nghiên cứu" khi cần theo dõi tiếp hoặc lấy bổ sung từ EMR.
// Màn hình chỉ hiện thống kê, không hiện dữ liệu từng lượt.
import { useEffect, useMemo, useState } from 'react';
import { C, FS } from '../../tokens.js';
import { Btn, Spinner } from '../shared.jsx';
import { compactNumber, text } from './researchFormat.js';
import { inp, EmptyState } from './researchUi.jsx';
import { ANCHOR_AGGREGATIONS, VARIABLE_AGGREGATIONS, matchSurveyLines, operatorLabel, variableTypeLabel } from './variableCatalogModel.js';
import { CohortSummary, FillBar, VariableStatsTable } from './researchStats.jsx';

const STEPS = ['Thông tin & phiếu', 'Ghép biến', 'Điều kiện chọn mẫu', 'Kiểm tra & xuất dữ liệu'];
const FILL_OPTIONS = [['all', 'Mọi mức đầy đủ'], ['high', 'Có dữ liệu ≥ 80%'], ['medium', '30–79%'], ['low', 'Dưới 30%']];
// Bảng một dòng mỗi lượt: không cần chọn cách tổng hợp.
const SINGLE_ROW_TABLES = ['analysis_ready', 'encounters', 'patients', 'cohort', 'research_source'];

const card = { border: `1px solid ${C.border2}`, borderRadius: 8, background: C.surface, padding: '12px 14px' };
const label = { display: 'block', fontSize: FS.sm, fontWeight: 600, color: C.text, marginBottom: 5 };
const hint = { fontSize: FS.xs, color: C.text3, marginTop: 4, lineHeight: 1.45 };

function StepBar({ step, canOpen, onOpen }) {
  return (
    <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))', gap: 6 }}>
      {STEPS.map((title, i) => {
        const n = i + 1;
        const active = n === step;
        const done = n < step;
        const enabled = canOpen(n);
        return (
          <li key={title}>
            <button type="button" onClick={() => enabled && onOpen(n)} disabled={!enabled} aria-current={active ? 'step' : undefined}
              style={{
                width: '100%', display: 'flex', alignItems: 'center', gap: 8, textAlign: 'left',
                padding: '7px 9px', borderRadius: 7, fontFamily: 'inherit',
                cursor: enabled ? 'pointer' : 'not-allowed',
                border: `1px solid ${active ? C.blue : done ? C.greenBorder : C.border2}`,
                background: active ? C.blueBg : done ? C.greenBg : C.surface,
                opacity: enabled || active ? 1 : 0.6,
              }}>
              <span aria-hidden="true" style={{
                width: 22, height: 22, borderRadius: 999, display: 'grid', placeItems: 'center', flexShrink: 0,
                fontSize: FS.xs, fontWeight: 700,
                background: active ? C.blue : done ? C.green : C.surface2, color: active || done ? '#fff' : C.text2,
              }}>{done ? '✓' : n}</span>
              <span style={{ fontSize: FS.sm, fontWeight: active ? 700 : 600, color: active ? C.blue : C.text }}>{title}</span>
            </button>
          </li>
        );
      })}
    </ol>
  );
}

const ANCHOR_OPTIONS = [
  ['', 'Không dùng mốc'],
  ['admission', 'Ngày nhập viện'],
  ['surgery', 'Ngày phẫu thuật'],
  ['drug', 'Lần đầu dùng một thuốc trong đợt (vd. truyền Zoledronic Acid)'],
];

function AnchorPicker({ anchor, setAnchor, drugNames }) {
  const kind = anchor?.kind || '';
  return (
    <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
      <legend style={label}>Mốc thời gian của nghiên cứu</legend>
      <div style={{ display: 'grid', gap: 6 }}>
        {ANCHOR_OPTIONS.map(([value, text_]) => (
          <label key={value || 'none'} style={{ display: 'flex', alignItems: 'center', gap: 7, fontSize: FS.sm, color: C.text2, cursor: 'pointer' }}>
            <input type="radio" name="study-anchor" checked={kind === value}
              onChange={() => setAnchor(value ? { kind: value, drug: value === 'drug' ? (anchor?.drug || '') : undefined } : null)} />
            {text_}
          </label>
        ))}
        {kind === 'drug' && (
          <div style={{ marginLeft: 24 }}>
            <input list="study-anchor-drugs" value={anchor?.drug || ''} aria-label="Tên thuốc làm mốc"
              onChange={e => setAnchor({ kind: 'drug', drug: e.target.value })}
              placeholder="Gõ tên thuốc, vd. Zoledronic" style={{ ...inp, width: 'min(100%, 420px)', height: 32 }} />
            <datalist id="study-anchor-drugs">{drugNames.slice(0, 300).map(n => <option key={n} value={n} />)}</datalist>
          </div>
        )}
      </div>
      <div style={hint}>
        Mốc là thời điểm can thiệp của đề tài. Ở bước sau có thể lấy biến "gần trước/sau mốc nhất" hoặc chỉ trong một số ngày quanh mốc
        (vd. xét nghiệm trong 14 ngày trước truyền, thuốc dùng trong 3 ngày sau truyền).
      </div>
    </fieldset>
  );
}

function StepInfo({ draft, setDraft, questionnaire, setQuestionnaire, surveyLineCount, anchor, setAnchor, drugNames }) {
  return (
    <div style={{ ...card, display: 'grid', gap: 14, maxWidth: 760 }}>
      <div>
        <label style={label} htmlFor="study-name">Tên nghiên cứu / bộ dữ liệu *</label>
        <input id="study-name" value={draft.name} autoFocus
          onChange={e => setDraft(p => ({ ...p, name: e.target.value }))}
          placeholder="VD: Gãy cổ xương đùi 2026" style={{ ...inp, width: '100%', height: 34 }} />
      </div>
      <div>
        <label style={label} htmlFor="study-desc">Mục tiêu / mô tả ngắn</label>
        <textarea id="study-desc" value={draft.description} rows={2}
          onChange={e => setDraft(p => ({ ...p, description: e.target.value }))}
          placeholder="VD: Khảo sát thời gian chờ mổ và biến chứng ở người bệnh trên 60 tuổi"
          style={{ ...inp, width: '100%', height: 'auto', padding: '7px 8px', resize: 'vertical', boxSizing: 'border-box' }} />
      </div>
      <AnchorPicker anchor={anchor} setAnchor={setAnchor} drugNames={drugNames} />
      <div>
        <label style={label} htmlFor="study-survey">Dán các dòng biến của phiếu thu thập</label>
        <textarea id="study-survey" value={questionnaire} rows={4}
          onChange={e => setQuestionnaire(e.target.value)}
          placeholder={'Dán nguyên các dòng từ phiếu, mỗi biến một dòng, ví dụ:\n1. Năm sinh: ……..\n2. Giới tính: ☐ 0. Nam ☐1. Nữ\nNồng độ Vitamin D [25(OH)D]: ........... (ng/mL)\nSố lượng Bạch cầu (WBC): ........... (G/L)'}
          style={{ ...inp, width: '100%', height: 'auto', padding: '7px 8px', resize: 'vertical', boxSizing: 'border-box' }} />
        <div style={hint}>
          {surveyLineCount
            ? `${surveyLineCount} dòng. Ở bước sau, app tự ghép từng dòng với biến trong kho và đặt tên cột theo phiếu.`
            : 'Không cần gõ lại: dán thẳng từ file Word/PDF của phiếu, phần chấm chấm và ô lựa chọn sẽ được bỏ qua. Không có phiếu thì chọn biến bằng tay ở bước sau.'}
        </div>
      </div>
    </div>
  );
}

// Tên cột lấy từ dòng trên phiếu: bỏ số thứ tự và phần điền sau dấu ":".
const surveyColumnLabel = (line) => String(line).replace(/^\s*\d+[.)]\s*/, '').split(':')[0].replace(/[.…_☐]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 120);

// Ghép từng dòng của phiếu với một biến trong kho. Tự chọn biến khớp nhất; người dùng đổi được.
function SurveyMapping({ surveyMatches, addVariables, setVariableSurveyLabels, selectedVariableIds }) {
  const { rows, choice, setChoice } = surveyMatches;
  const chosen = rows.map(r => ({ r, v: r.candidates.find(c => c.id === choice[r.line]) || null }));
  const matched = chosen.filter(x => x.v);
  const missing = chosen.filter(x => !x.v);
  const applied = matched.length > 0 && matched.every(x => selectedVariableIds.has(x.v.id));
  const apply = () => {
    addVariables(matched.map(x => x.v));
    setVariableSurveyLabels(prev => ({ ...prev, ...Object.fromEntries(matched.map(x => [x.v.id, surveyColumnLabel(x.r.line) || x.v.display_label])) }));
  };
  return (
    <section style={{ ...card, flex: '1 1 100%', display: 'grid', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
        <div style={{ flex: '1 1 300px' }}>
          <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Ghép phiếu với dữ liệu trong kho</div>
          <div style={{ fontSize: FS.xs, color: C.text3 }}>
            <b style={{ color: C.green }}>{matched.length}</b>/{rows.length} dòng của phiếu có biến tương ứng trong kho. Kiểm tra lại ô "Biến trong kho" nếu ghép chưa đúng.
          </div>
        </div>
        <Btn variant={applied ? 'default' : 'solidPrimary'} onClick={apply} disabled={!matched.length} style={{ height: 32 }}>
          {applied ? 'Đã chọn các biến đã ghép' : `Chọn ${matched.length} biến đã ghép`}
        </Btn>
      </div>
      <div style={{ maxHeight: 340, overflow: 'auto', border: `1px solid ${C.border2}`, borderRadius: 7 }}>
        <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.sm, minWidth: 640 }}>
          <thead style={{ position: 'sticky', top: 0, background: C.surface2 }}><tr>
            {[['Dòng trên phiếu', '38%'], ['Biến trong kho', '42%'], ['Có dữ liệu', undefined]].map(([h, w]) => (
              <th key={h} style={{ width: w, textAlign: 'left', padding: '6px 10px', fontSize: FS.xs, color: C.text2, borderBottom: `1px solid ${C.border2}` }}>{h}</th>
            ))}
          </tr></thead>
          <tbody>
            {chosen.map(({ r, v }) => (
              <tr key={r.line} style={{ borderBottom: `1px solid ${C.border2}` }}>
                <td style={{ padding: '5px 10px', color: C.text }} title={r.line}>{surveyColumnLabel(r.line) || r.line}</td>
                <td style={{ padding: '4px 10px' }}>
                  <select value={choice[r.line] || ''} onChange={e => setChoice(r.line, e.target.value)} aria-label={`Biến cho ${surveyColumnLabel(r.line)}`}
                    style={{ ...inp, width: '100%', height: 30, color: v ? C.text : C.amber }}>
                    <option value="">— Không có trong kho</option>
                    {r.candidates.map(c => <option key={c.id} value={c.id}>{c.display_label} · {c.fill_rate}% có dữ liệu</option>)}
                  </select>
                </td>
                <td style={{ padding: '5px 10px' }}>{v ? <FillBar rate={v.fill_rate} /> : <span style={{ fontSize: FS.xs, color: C.amber }}>cần nguồn khác</span>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {!!missing.length && (
        <div style={{ fontSize: FS.xs, color: C.text3, lineHeight: 1.5 }}>
          <b style={{ color: C.amber }}>{missing.length} dòng không có trong kho</b> (EMR không ghi hoặc kho chưa lấy): {missing.map(x => surveyColumnLabel(x.r.line)).slice(0, 25).join(' · ')}{missing.length > 25 ? ' …' : ''}
        </div>
      )}
    </section>
  );
}

function StepVariables(props) {
  const {
    variableCatalog, variableCatalogLoading, variableCatalogError,
    catalogGroupOptions, filteredCatalogVariables, surveyMatches,
    variableQuery, setVariableQuery, variableGroupFilter, setVariableGroupFilter, variableFillFilter, setVariableFillFilter,
    selectedVariableIds, selectedVariables, toggleVariable, addVariables, addCoreVariables,
    variableAggregations, setVariableAggregations, variableSurveyLabels, setVariableSurveyLabels,
    variableAnchor, variableWindows, setVariableWindows,
  } = props;
  const aggregationOptions = VARIABLE_AGGREGATIONS.filter(([key]) => variableAnchor || !ANCHOR_AGGREGATIONS.has(key));
  const setWindow = (id, patch) => setVariableWindows(prev => ({ ...prev, [id]: { ...(prev[id] || {}), ...patch } }));
  if (variableCatalogLoading) return <div style={{ ...card, color: C.text2 }}><Spinner size={11} /> Đang lập danh mục biến...</div>;
  if (!variableCatalog) {
    return <div style={card}><EmptyState
      title={variableCatalogError ? 'Chưa tải được danh mục biến' : 'Kho chưa có biến để chọn'}
      hint={variableCatalogError ? `${variableCatalogError}. Bấm Tải lại ở trên sau vài giây.` : 'Cần quét danh sách và thu thập dữ liệu ở Kho dữ liệu gốc trước.'}
    /></div>;
  }
  const chip = (active) => ({
    height: 30, padding: '0 10px', borderRadius: 999, cursor: 'pointer', fontFamily: 'inherit',
    border: `1px solid ${active ? C.blue : C.border2}`, background: active ? C.blueBg : C.surface,
    color: active ? C.blue : C.text2, fontSize: FS.sm, fontWeight: active ? 700 : 500, whiteSpace: 'nowrap',
  });
  return (
    <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', alignItems: 'flex-start' }}>
      {!!surveyMatches?.rows.length && <SurveyMapping {...props} />}
      <div style={{ ...card, flex: '1 1 560px', minWidth: 0, display: 'grid', gap: 10 }}>
        <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>{surveyMatches?.rows.length ? 'Thêm biến khác từ kho' : 'Chọn biến từ kho'}</div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <input value={variableQuery} onChange={e => setVariableQuery(e.target.value)} aria-label="Tìm biến"
            placeholder="Tìm biến: tuổi, Hb, creatinine, X-quang, kháng sinh..." style={{ ...inp, flex: '1 1 240px', height: 32 }} />
          <select value={variableFillFilter} onChange={e => setVariableFillFilter(e.target.value)} aria-label="Lọc theo mức đầy đủ" style={{ ...inp, height: 32 }}>
            {FILL_OPTIONS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
          </select>
        </div>
        <div className="emr-hscroll" style={{ display: 'flex', gap: 6, overflowX: 'auto', paddingBottom: 2 }}>
          <button type="button" style={chip(variableGroupFilter === 'all')} onClick={() => setVariableGroupFilter('all')}>
            Tất cả {catalogGroupOptions.reduce((sum, g) => sum + Number(g.count || 0), 0)}
          </button>
          {catalogGroupOptions.map(g => (
            <button key={g.key} type="button" style={chip(variableGroupFilter === g.key)} onClick={() => setVariableGroupFilter(g.key)}>
              {g.label} {g.count}
            </button>
          ))}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', fontSize: FS.xs, color: C.text3 }}>
          <span>{compactNumber(filteredCatalogVariables.length)} biến</span>
          <Btn onClick={addCoreVariables} style={{ height: 28, fontSize: FS.xs, marginLeft: 'auto' }}>+ Biến nền (tuổi, giới, ngày vào/ra, chẩn đoán)</Btn>
        </div>
        {!filteredCatalogVariables.length
          ? <EmptyState title="Không có biến phù hợp" hint="Thử từ khóa khác, chọn nhóm Tất cả hoặc bỏ lọc mức đầy đủ." />
          : (
            <div role="list" style={{ maxHeight: 'calc(100vh - 380px)', minHeight: 240, overflow: 'auto', border: `1px solid ${C.border2}`, borderRadius: 7 }}>
              {filteredCatalogVariables.slice(0, 400).map(v => {
                const selected = selectedVariableIds.has(v.id);
                return (
                  <label key={v.id} role="listitem" style={{
                    display: 'grid', gridTemplateColumns: '20px minmax(0,1fr) 150px', gap: 10, alignItems: 'center',
                    padding: '8px 10px', borderBottom: `1px solid ${C.border2}`, cursor: 'pointer',
                    background: selected ? C.blueBg : C.surface,
                  }}>
                    <input type="checkbox" checked={selected} onChange={() => toggleVariable(v.id)} />
                    <span style={{ minWidth: 0 }}>
                      <span style={{ display: 'block', fontSize: FS.sm, fontWeight: 700, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.display_label}</span>
                      <span style={{ display: 'block', fontSize: FS.xs, color: C.text3, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {variableTypeLabel(v.type)} · {v.clinical_group_label} · {compactNumber(v.distinct_count)} giá trị khác nhau
                      </span>
                    </span>
                    <span title="Tỉ lệ lượt có dữ liệu cho biến này"><FillBar rate={v.fill_rate} /></span>
                  </label>
                );
              })}
              {filteredCatalogVariables.length > 400 && <div style={{ padding: 8, fontSize: FS.xs, color: C.text3 }}>Hiện 400 biến đầu. Dùng ô tìm kiếm để thu hẹp.</div>}
            </div>
          )}
      </div>

      <aside style={{ ...card, flex: '0 1 340px', minWidth: 280, position: 'sticky', top: 10, display: 'grid', gap: 8 }}>
        <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Biến đã chọn ({selectedVariables.length})</div>
        {!selectedVariables.length && <div style={{ fontSize: FS.xs, color: C.text3, lineHeight: 1.5 }}>Chưa chọn biến nào. Đánh dấu biến ở danh sách bên trái.</div>}
        <div style={{ display: 'grid', gap: 6, maxHeight: 'calc(100vh - 330px)', overflow: 'auto' }}>
          {selectedVariables.map(v => {
            const repeated = !SINGLE_ROW_TABLES.includes(String(v.table || ''));
            return (
              <div key={v.id} style={{ border: `1px solid ${C.border2}`, borderRadius: 7, padding: '7px 8px', display: 'grid', gap: 5 }}>
                <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                  <span style={{ flex: 1, minWidth: 0, fontSize: FS.sm, fontWeight: 700, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.display_label}</span>
                  <button type="button" aria-label={`Bỏ biến ${v.display_label}`} onClick={() => toggleVariable(v.id)}
                    style={{ border: 0, background: 'transparent', color: C.text3, cursor: 'pointer', fontSize: FS.md, padding: '0 4px' }}>✕</button>
                </div>
                <input value={variableSurveyLabels[v.id] ?? v.display_label ?? v.name}
                  onChange={e => setVariableSurveyLabels(prev => ({ ...prev, [v.id]: e.target.value }))}
                  aria-label="Tên cột khi xuất" title="Tên cột khi xuất dữ liệu (theo phiếu khảo sát)"
                  style={{ ...inp, height: 28, fontSize: FS.xs }} />
                {repeated && (
                  <select value={variableAggregations[v.id] || 'list'} aria-label="Cách lấy khi một lượt có nhiều giá trị"
                    title="Một lượt điều trị có nhiều giá trị: chọn cách lấy"
                    onChange={e => setVariableAggregations(prev => ({ ...prev, [v.id]: e.target.value }))}
                    style={{ ...inp, height: 28, fontSize: FS.xs }}>
                    {aggregationOptions.map(([key, l]) => <option key={key} value={key}>{l}</option>)}
                  </select>
                )}
                {repeated && variableAnchor && (
                  <div style={{ display: 'flex', alignItems: 'center', gap: 5, fontSize: FS.xs, color: C.text2, flexWrap: 'wrap' }}
                    title="Để trống = không giới hạn. Số âm là trước mốc, 0 là ngày mốc, số dương là sau mốc.">
                    <span>Chỉ lấy từ ngày</span>
                    <input type="number" value={variableWindows[v.id]?.from ?? ''} onChange={e => setWindow(v.id, { from: e.target.value })}
                      aria-label="Từ ngày so với mốc" placeholder="-14" style={{ ...inp, width: 58, height: 26, fontSize: FS.xs }} />
                    <span>đến</span>
                    <input type="number" value={variableWindows[v.id]?.to ?? ''} onChange={e => setWindow(v.id, { to: e.target.value })}
                      aria-label="Đến ngày so với mốc" placeholder="0" style={{ ...inp, width: 58, height: 26, fontSize: FS.xs }} />
                    <span>so với mốc</span>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </aside>
    </div>
  );
}

function StepConditions({ allCatalogVariables, selectedVariables, variableConditions, setVariableConditions, addConditionForVariable }) {
  const pickable = allCatalogVariables.filter(v => !v.technical_or_identity);
  const selectedIds = new Set(selectedVariables.map(v => v.id));
  const others = pickable.filter(v => !selectedIds.has(v.id));
  const update = (i, patch) => setVariableConditions(prev => prev.map((x, j) => (j === i ? { ...x, ...patch } : x)));
  return (
    <div style={{ ...card, display: 'grid', gap: 12, maxWidth: 900 }}>
      <div style={{ fontSize: FS.sm, color: C.text2, lineHeight: 1.5 }}>
        Điều kiện quyết định lượt điều trị nào được đưa vào nghiên cứu (ví dụ tuổi ≥ 60, có phẫu thuật).
        <b> Không đặt điều kiện thì lấy toàn bộ lượt trong kho.</b>
      </div>
      {variableConditions.map((cond, i) => {
        const variable = allCatalogVariables.find(v => v.id === cond.variable_id);
        return (
          <div key={cond.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(160px,1.3fr) minmax(130px,1fr) minmax(120px,1fr) auto', gap: 8, alignItems: 'center', border: `1px solid ${C.border2}`, borderRadius: 7, padding: '8px 10px' }}>
            <span style={{ fontSize: FS.sm, fontWeight: 700, color: C.text, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{variable?.display_label || cond.label}</span>
            <select value={cond.operator} onChange={e => update(i, { operator: e.target.value })} aria-label="Phép so sánh" style={{ ...inp, height: 30 }}>
              {(variable?.operators || ['contains', '=']).map(op => <option key={op} value={op}>{operatorLabel(op)}</option>)}
            </select>
            {['not_empty', 'empty'].includes(cond.operator)
              ? <span />
              : <span style={{ display: 'flex', gap: 6 }}>
                  <input value={cond.value} onChange={e => update(i, { value: e.target.value })} placeholder="Giá trị" aria-label="Giá trị" style={{ ...inp, height: 30, flex: 1, minWidth: 0 }} />
                  {cond.operator === 'between' && <input value={cond.value2} onChange={e => update(i, { value2: e.target.value })} placeholder="đến" aria-label="Giá trị đến" style={{ ...inp, height: 30, flex: 1, minWidth: 0 }} />}
                </span>}
            <button type="button" aria-label="Xóa điều kiện" onClick={() => setVariableConditions(prev => prev.filter((_, j) => j !== i))}
              style={{ border: 0, background: 'transparent', color: C.red, cursor: 'pointer', fontSize: FS.md }}>✕</button>
          </div>
        );
      })}
      <select value="" aria-label="Thêm điều kiện theo biến"
        onChange={e => { const v = pickable.find(x => x.id === e.target.value); if (v) addConditionForVariable(v); }}
        style={{ ...inp, height: 34, maxWidth: 420 }}>
        <option value="">+ Thêm điều kiện theo biến…</option>
        {!!selectedVariables.length && <optgroup label="Biến đã chọn">
          {selectedVariables.map(v => <option key={v.id} value={v.id}>{v.display_label}</option>)}
        </optgroup>}
        <optgroup label="Biến khác trong kho">
          {others.slice(0, 500).map(v => <option key={v.id} value={v.id}>{v.clinical_group_label} · {v.display_label}</option>)}
        </optgroup>
      </select>
    </div>
  );
}

function StepReview({ draft, selectedVariables, variableConditions, variablePreview, variablePreviewLoading, variablePreviewError, loadVariablePreview }) {
  const summary = variablePreview?.summary || null;
  return (
    <div style={{ display: 'grid', gap: 12 }}>
      <div style={{ ...card, display: 'flex', gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
        <div style={{ flex: '1 1 300px', fontSize: FS.sm, color: C.text2 }}>
          <b style={{ color: C.text }}>{draft.name}</b> · {selectedVariables.length} biến · {variableConditions.length ? `${variableConditions.length} điều kiện` : 'không có điều kiện (toàn bộ kho)'}
        </div>
        <Btn onClick={loadVariablePreview} disabled={variablePreviewLoading} loading={variablePreviewLoading} style={{ height: 30 }}>Tính lại thống kê</Btn>
      </div>
      {variablePreviewError && <div role="alert" style={{ ...card, color: C.red, background: C.redBg, borderColor: C.redBorder }}>{variablePreviewError}</div>}
      {variablePreviewLoading && !summary && <div style={{ ...card, color: C.text2 }}><Spinner size={11} /> Đang tính thống kê trên kho...</div>}
      {summary && (
        <>
          {summary.funnel?.length > 1 && (
            <section style={card}>
              <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text, marginBottom: 8 }}>Sàng lọc mẫu theo điều kiện</div>
              <ol style={{ listStyle: 'none', margin: 0, padding: 0, display: 'grid', gap: 6 }}>
                {summary.funnel.map((f, i) => {
                  const first = summary.funnel[0].encounters || 1;
                  const removed = i ? summary.funnel[i - 1].encounters - f.encounters : 0;
                  return (
                    <li key={i} style={{ display: 'grid', gridTemplateColumns: 'minmax(180px, 1.4fr) minmax(120px, 2fr) auto', gap: 10, alignItems: 'center', fontSize: FS.sm }}>
                      <span style={{ color: C.text, fontWeight: i ? 500 : 700 }}>{i ? `+ ${f.label}` : f.label}</span>
                      <span style={{ height: 8, background: C.surface2, borderRadius: 4, overflow: 'hidden' }}>
                        <span style={{ display: 'block', height: '100%', width: `${Math.max(1, (f.encounters / first) * 100)}%`, background: i === summary.funnel.length - 1 ? C.green : C.blue }} />
                      </span>
                      <span style={{ color: C.text2, fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                        <b style={{ color: C.text }}>{compactNumber(f.encounters)}</b> lượt · {compactNumber(f.patients)} người bệnh{removed ? <span style={{ color: C.text3 }}> (loại {compactNumber(removed)})</span> : null}
                      </span>
                    </li>
                  );
                })}
              </ol>
            </section>
          )}
          <section style={card}>
            <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text, marginBottom: 8 }}>Mẫu nghiên cứu</div>
            <CohortSummary summary={summary} />
            {summary.anchor && (
              <div style={{ marginTop: 8, fontSize: FS.xs, color: summary.anchor.missing ? C.amber : C.text2 }}>
                Mốc thời gian: tìm thấy ở <b>{summary.anchor.found}</b> lượt
                {summary.anchor.missing ? <>, <b>không tìm thấy ở {summary.anchor.missing} lượt</b> (các biến theo mốc của những lượt này để trống; có thể thêm điều kiện "Dùng thuốc" ở bước 3 để loại)</> : ''}.
              </div>
            )}
            {variablePreview.source_limited && <div style={{ ...hint, color: C.amber }}>Kho lớn: thống kê tính trên phần đầu của kho; số chính xác có sau khi tạo và thu thập.</div>}
          </section>
          <section>
            <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text, margin: '2px 0 8px' }}>Đo lường từng biến</div>
            <VariableStatsTable variables={summary.variables || []} />
          </section>
        </>
      )}
    </div>
  );
}

export function CreateStudyView(props) {
  const {
    variableStudyDraft, setVariableStudyDraft, questionnaireVariables, setQuestionnaireVariables,
    selectedVariables, variablePreview, variablePreviewLoading, loadVariablePreview,
    createStudyFromVariableSelection, busy,
  } = props;
  const [step, setStep] = useState(1);
  // Dòng của phiếu (giữ nguyên chữ để làm tên cột) và biến ghép cho từng dòng.
  const surveyLines = useMemo(() => [...new Set(String(questionnaireVariables || '').split(/\n+/).map(x => x.trim()).filter(x => x.length >= 2))], [questionnaireVariables]);
  const surveyRows = useMemo(() => matchSurveyLines(surveyLines, props.browseCatalogVariables || []), [surveyLines, props.browseCatalogVariables]);
  const [surveyOverrides, setSurveyOverrides] = useState({});
  const surveyMatches = useMemo(() => ({
    rows: surveyRows,
    choice: Object.fromEntries(surveyRows.map(r => [r.line, surveyOverrides[r.line] ?? (r.best?.id || '')])),
    setChoice: (line, id) => setSurveyOverrides(prev => ({ ...prev, [line]: id })),
  }), [surveyRows, surveyOverrides]);
  // Mốc "dùng thuốc" phải có tên thuốc (≥ 3 ký tự) thì mới sang bước sau.
  const anchorReady = props.variableAnchor?.kind !== 'drug' || text(props.variableAnchor?.drug).length >= 3;
  const hasName = Boolean(text(variableStudyDraft.name)) && anchorReady;
  const drugNames = useMemo(() => [...new Set((props.allCatalogVariables || [])
    .filter(v => v.virtual_kind === 'drug_item')
    .map(v => String(v.name || '').replace(/^drug:/, '').trim())
    .filter(Boolean))].sort((a, b) => a.localeCompare(b)), [props.allCatalogVariables]);
  const hasVariables = selectedVariables.length > 0;
  // Điều kiện để trống giá trị sẽ loại hết mẫu: phải nhập xong mới sang bước kiểm tra.
  const conditionsReady = props.variableConditions.every(c => ['not_empty', 'empty'].includes(c.operator)
    || (text(c.value) && (c.operator !== 'between' || text(c.value2))));
  const canOpen = (n) => n === 1 || (n === 2 && hasName) || (n === 3 && hasName && hasVariables)
    || (n === 4 && hasName && hasVariables && conditionsReady);
  const canNext = step === 1 ? hasName : step === 2 ? hasVariables : step === 3 ? conditionsReady : true;

  // Vào bước Kiểm tra thì tự tính thống kê nếu chưa có (lựa chọn đổi thì preview bị xóa).
  useEffect(() => {
    if (step === 4 && !variablePreview && !variablePreviewLoading && hasVariables) loadVariablePreview();
  }, [step, variablePreview, variablePreviewLoading, hasVariables, loadVariablePreview]);

  return (
    <div style={{ padding: '10px 12px 16px', display: 'grid', gap: 12 }}>
      <StepBar step={step} canOpen={canOpen} onOpen={setStep} />

      {step === 1 && <StepInfo draft={variableStudyDraft} setDraft={setVariableStudyDraft}
        questionnaire={questionnaireVariables} setQuestionnaire={setQuestionnaireVariables} surveyLineCount={surveyLines.length}
        anchor={props.variableAnchor} setAnchor={props.setVariableAnchor} drugNames={drugNames} />}
      {step === 2 && <StepVariables {...props} surveyMatches={surveyMatches} />}
      {step === 3 && <StepConditions {...props} />}
      {step === 4 && <StepReview draft={variableStudyDraft} {...props} />}

      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap', borderTop: `1px solid ${C.border2}`, paddingTop: 10 }}>
        {step > 1 && <Btn onClick={() => setStep(step - 1)} style={{ height: 34 }}>← Quay lại</Btn>}
        <span style={{ fontSize: FS.xs, color: C.text3, flex: '1 1 200px' }}>
          {step === 1 && !hasName && (anchorReady ? 'Nhập tên nghiên cứu để tiếp tục.' : 'Nhập tên thuốc làm mốc (ít nhất 3 ký tự).')}
          {step === 2 && !hasVariables && 'Chọn ít nhất 1 biến để tiếp tục.'}
          {step === 3 && !conditionsReady && 'Nhập giá trị cho mọi điều kiện, hoặc xóa điều kiện không dùng.'}
          {step === 4 && 'Xuất ngay từ dữ liệu đã có trong kho, đã ẩn định danh. "Lưu thành nghiên cứu" khi cần theo dõi tiếp hoặc lấy bổ sung từ EMR.'}
        </span>
        {step < 4
          ? <Btn variant="solidPrimary" onClick={() => setStep(step + 1)} disabled={!canNext} style={{ height: 34, padding: '0 18px' }}>Tiếp tục →</Btn>
          : <>
              <Btn onClick={createStudyFromVariableSelection}
                disabled={busy || !variablePreview?.summary || !hasName || !hasVariables} loading={busy} style={{ height: 34 }}>
                Lưu thành nghiên cứu
              </Btn>
              <Btn variant="solidSuccess" onClick={props.exportVariableDataset}
                disabled={props.variableExporting || !variablePreview?.summary || !hasName || !hasVariables} loading={props.variableExporting} style={{ height: 34, padding: '0 18px' }}>
                Xuất dữ liệu (CSV) · {compactNumber(variablePreview?.summary?.total || 0)} lượt
              </Btn>
            </>}
      </div>
    </div>
  );
}
