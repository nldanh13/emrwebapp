// Tạo nghiên cứu từ biến: đối chiếu phiếu khảo sát, chọn biến trong kho, điều kiện lọc, xem trước và tạo nghiên cứu.
import { C, FS } from '../../tokens.js';
import { variableTypeTone, variableCompletenessTone, variableTypeLabel, variableRoleLabel, variableCompletenessLabel, VARIABLE_AGGREGATIONS, operatorLabel } from './variableCatalogModel.js';
import { compactNumber, sampleText, text } from './researchFormat.js';
import { inp, EmptyState, StatBadge } from './researchUi.jsx';
import { Btn, Spinner } from '../shared.jsx';

export function VariableCatalogView({
  addConditionForVariable, addCoreVariables, addVariables, allCatalogVariables, busy,
  catalogGroupOptions, createStudyFromVariableSelection, exportVariableSpec,
  filteredCatalogVariables, filteredVariableSections, loadVariableCatalog, loadVariablePreview,
  questionnaireTerms, questionnaireVariables, selectedCoverage, selectedVariableIds,
  selectedVariables, selectedVariablesByGroup, setQuestionnaireVariables, setSelectedVariableIds,
  setShowTechnicalVariables, setVariableAggregations, setVariableConditions, setVariableFillFilter,
  setVariableGroupFilter, setVariablePreviewConfirmed, setVariableQuery, setVariableStudyDraft,
  setVariableSurveyLabels, setVariableTypeFilter, showTechnicalVariables, toggleVariable,
  variableAggregations, variableCatalog, variableCatalogError, variableCatalogLoading,
  variableConditions, variableFillFilter, variableGroupFilter, variablePreview,
  variablePreviewConfirmed, variablePreviewError, variablePreviewLoading, variableQuery,
  variableStudyDraft, variableSurveyLabels, variableTypeFilter,
}) {
  const activeGroup = catalogGroupOptions.find(g => g.key === variableGroupFilter);
  const totalVisible = filteredCatalogVariables.length;
  const typeOptions = [
    ['all', 'Tất cả loại'], ['number', 'Số'], ['date', 'Ngày/giờ'], ['category', 'Phân loại'], ['text', 'Văn bản'],
  ];
  const fillOptions = [
    ['all', 'Tất cả mức đủ'], ['high', '≥ 80% đủ'], ['medium', '30–79% đủ'], ['low', '< 30% đủ'],
  ];
  const groupButtonStyle = (active) => ({
    height: 30, borderRadius: 5, border: 0,
    borderBottom: `2px solid ${active ? C.blue : 'transparent'}`,
    background: 'transparent', color: active ? C.text : C.text3,
    padding: '0 8px', fontSize: FS.xs, fontWeight: active ? 700 : 600, cursor: 'pointer',
    display: 'inline-flex', alignItems: 'center', gap: 5,
  });
  const pill = (label, tone = 'neutral') => {
    const map = {
      ok: { bg: C.greenBg, color: C.green, border: C.greenBorder },
      info: { bg: C.blueBg, color: C.blue, border: C.blueBorder },
      warn: { bg: C.amberBg, color: C.amber, border: C.amberBorder },
      danger: { bg: C.redBg, color: C.red, border: C.redBorder },
      neutral: { bg: C.surface2, color: C.text2, border: C.border2 },
    };
    const c = map[tone] || map.neutral;
    return <span style={{ display: 'inline-flex', alignItems: 'center', border: `1px solid ${c.border}`, background: c.bg, color: c.color, borderRadius: 999, padding: '1px 7px', fontSize: FS.xs, fontWeight: 700 }}>{label}</span>;
  };
  const renderVariableCard = (v) => {
    const typeTone = variableTypeTone(v.type);
    const selected = selectedVariableIds.has(v.id);
    const completenessTone = variableCompletenessTone(v.fill_rate);
    return (
      <div key={v.id} style={{ borderBottom: `1px solid ${C.border2}`, background: selected ? C.blueBg : C.surface, padding: '9px 8px', display: 'grid', gridTemplateColumns: '22px minmax(0, 1fr) auto', gap: 9, alignItems: 'start' }}>
        <input type="checkbox" checked={selected} onChange={() => toggleVariable(v.id)} style={{ marginTop: 3 }} />
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'center', gap: 6 }}>
            <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>{v.display_label}</div>
            <span style={{ border: `1px solid ${typeTone.border}`, background: typeTone.bg, color: typeTone.color, borderRadius: 999, padding: '1px 7px', fontSize: FS.xs, fontWeight: 700 }}>{variableTypeLabel(v.type)}</span>
            {pill(variableRoleLabel(v.role), v.role === 'identity' || v.role === 'technical' ? 'warn' : 'neutral')}
            {!v.recommended && pill('Ít dùng', 'warn')}
          </div>
          <div style={{ marginTop: 4, color: C.text3, fontSize: FS.xs }}>
            <span style={{ fontWeight: 700 }}>{v.clinical_group_label}</span>
            <span> · nguồn: {v.source_group_label}{v.also_in?.length ? ` (cũng có ở ${v.also_in.join(', ')})` : ''}</span>
            <span> · cột gốc: </span>
            <code style={{ fontSize: FS.xs, color: C.text2 }}>{v.raw_name}</code>
          </div>
          <div style={{ marginTop: 7, color: C.text2, fontSize: FS.xs, lineHeight: 1.45 }}>{v.description}</div>
          <div style={{ marginTop: 8, display: 'flex', flexWrap: 'wrap', gap: 6, alignItems: 'center' }}>
            {pill(`${v.fill_rate}% có dữ liệu · ${variableCompletenessLabel(v.fill_rate)}`, completenessTone)}
            {pill(`${compactNumber(v.distinct_count)} giá trị khác nhau`, 'neutral')}
            <span style={{ color: C.text3, fontSize: FS.xs }}>Mẫu: {sampleText(v.sample_values)}</span>
          </div>
        </div>
        <Btn onClick={() => addConditionForVariable(v)} style={{ height: 26, padding: '0 9px', fontSize: FS.xs }}>+ Điều kiện</Btn>
      </div>
    );
  };
  const workflowSteps = [
    ['1', 'Nhập biến phiếu khảo sát', questionnaireTerms.length ? `${questionnaireTerms.length} mục` : 'Có thể bỏ qua'],
    ['2', 'Chọn biến trong kho', selectedVariables.length ? `${selectedVariables.length} biến` : 'Chưa chọn'],
    ['3', 'Đặt điều kiện lọc', variableConditions.length ? `${variableConditions.length} điều kiện` : 'Không bắt buộc'],
    ['4', 'Xem trước và tạo', variablePreviewConfirmed ? 'Đã xác nhận' : 'Chưa xác nhận'],
  ];
  return (
    <div style={{ padding: '10px 12px 16px' }}>
      <div style={{ marginBottom: 12, border: `1px solid ${C.border2}`, borderRadius: 9, background: C.surface, overflow: 'hidden' }}>
        <div style={{ padding: '11px 12px 9px', borderBottom: `1px solid ${C.border2}` }}>
          <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>Thiết kế bộ dữ liệu từ phiếu khảo sát</div>
          <div style={{ marginTop: 4, fontSize: FS.xs, lineHeight: 1.45, color: C.text3 }}>
            Dùng dữ liệu đã có trong Kho nghiên cứu; bước này không mở EMR và không cần kết nối Wi-Fi bệnh viện.
          </div>
        </div>
        <div style={{ padding: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(155px, 1fr))', gap: 8 }}>
          {workflowSteps.map(([number, label, sub], index) => {
            const done = index === 0 ? questionnaireTerms.length > 0 : index === 1 ? selectedVariables.length > 0 : index === 2 ? variableConditions.length > 0 : variablePreviewConfirmed;
            return (
              <div key={number} style={{ display: 'grid', gridTemplateColumns: '27px minmax(0,1fr)', gap: 8, alignItems: 'center', padding: '7px 8px', borderRadius: 7, background: done ? C.greenBg : C.surface2, border: `1px solid ${done ? C.greenBorder : C.border2}` }}>
                <span style={{ width: 27, height: 27, borderRadius: 999, display: 'grid', placeItems: 'center', background: done ? C.green : C.surface, color: done ? '#fff' : C.text2, border: `1px solid ${done ? C.green : C.border2}`, fontWeight: 700 }}>{done ? '✓' : number}</span>
                <span style={{ minWidth: 0 }}>
                  <span style={{ display: 'block', fontSize: FS.xs, fontWeight: 700, color: C.text }}>{label}</span>
                  <span style={{ display: 'block', marginTop: 2, fontSize: FS.xs, color: done ? C.green : C.text3 }}>{sub}</span>
                </span>
              </div>
            );
          })}
        </div>
      </div>

      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, alignItems: 'flex-start' }}>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 10, minWidth: 0, flex: '1 1 720px' }}>
        <div style={{ background: C.surface, overflow: 'hidden' }}>
          <div style={{ padding: '4px 0 10px', borderBottom: `1px solid ${C.border2}` }}>
            <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
              <div>
                <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text }}>Đối chiếu biến trong kho</div>
                <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 4, lineHeight: 1.45 }}>
                  Dán danh sách biến của phiếu khảo sát, kiểm tra gợi ý rồi chủ động chọn biến phù hợp.
                </div>
              </div>
              <Btn onClick={() => loadVariableCatalog()} disabled={variableCatalogLoading} style={{ height: 30 }}>{variableCatalogLoading ? <><Spinner size={9} /> Đang tải</> : 'Tải lại danh mục'}</Btn>
            </div>
            <div style={{ marginTop: 10, padding: 10, border: `1px solid ${C.blueBorder}`, background: C.blueBg, borderRadius: 7 }}>
              <div style={{ fontSize: FS.xs, fontWeight: 700, color: C.blue }}>Biến trên phiếu khảo sát</div>
              <div style={{ marginTop: 3, fontSize: FS.xs, color: C.text2 }}>Mỗi biến một dòng, ví dụ: Tuổi, giới, ngày vào viện, Hb trước mổ, phương pháp phẫu thuật.</div>
              <textarea
                value={questionnaireVariables}
                onChange={e => { setQuestionnaireVariables(e.target.value); if (e.target.value.trim()) setVariableGroupFilter('all'); }}
                placeholder={'Tuổi\nGiới\nChẩn đoán\nHb trước mổ\nPhương pháp phẫu thuật'}
                rows={4}
                style={{ ...inp, display: 'block', width: '100%', boxSizing: 'border-box', height: 'auto', marginTop: 8, paddingTop: 7, paddingBottom: 7, resize: 'vertical', background: C.surface }}
              />
              <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
                <Btn onClick={() => addVariables(filteredCatalogVariables.filter(v => v.recommended && Number(v.fill_rate || 0) >= 30))} disabled={!questionnaireTerms.length || !filteredCatalogVariables.length} style={{ height: 27, fontSize: FS.xs }}>＋ Chọn gợi ý phù hợp</Btn>
                <Btn onClick={addCoreVariables} style={{ height: 27, fontSize: FS.xs }}>＋ Bộ biến nền thường dùng</Btn>
                {!!questionnaireTerms.length && <span style={{ fontSize: FS.xs, color: C.text2 }}>{questionnaireTerms.length} mục khảo sát · tìm thấy {filteredCatalogVariables.length} biến gợi ý</span>}
              </div>
            </div>
            <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 7 }}>
              <input value={variableQuery} onChange={e => setVariableQuery(e.target.value)} placeholder="Tìm biến: tuổi, giới, ngày nhập viện, Hb, creatinine, X-quang, CT, MRI, kháng sinh..." style={inp} />
              <select value={variableTypeFilter} onChange={e => setVariableTypeFilter(e.target.value)} style={inp}>
                {typeOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
              <select value={variableFillFilter} onChange={e => setVariableFillFilter(e.target.value)} style={inp}>
                {fillOptions.map(([value, label]) => <option key={value} value={value}>{label}</option>)}
              </select>
            </div>
            <label style={{ marginTop: 9, display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: FS.xs, color: C.text2 }}>
              <input type="checkbox" checked={showTechnicalVariables} onChange={e => setShowTechnicalVariables(e.target.checked)} />
              Hiện cả biến định danh/kỹ thuật
            </label>
            <div style={{ marginTop: 8, display: 'flex', alignItems: 'center', gap: 7, flexWrap: 'wrap' }}>
              <Btn onClick={() => addVariables(filteredCatalogVariables)} disabled={!filteredCatalogVariables.length} style={{ height: 26, fontSize: FS.xs }}>Chọn tất cả đang hiển thị</Btn>
              <Btn onClick={() => setSelectedVariableIds(prev => {
                const next = new Set(prev);
                for (const variable of filteredCatalogVariables) next.delete(variable.id);
                return next;
              })} disabled={!filteredCatalogVariables.some(v => selectedVariableIds.has(v.id))} style={{ height: 26, fontSize: FS.xs }}>Bỏ chọn đang hiển thị</Btn>
            </div>
          </div>

          {variableCatalogLoading && <div style={{ padding: 20, color: C.text2 }}><Spinner size={12} /> Đang lập danh mục biến...</div>}
          {!variableCatalogLoading && !variableCatalog && (
            <EmptyState
              title={variableCatalogError ? 'Chưa tải được danh mục biến' : 'Chưa có danh mục biến'}
              hint={variableCatalogError ? `${variableCatalogError}. Bấm Tải lại danh mục sau vài giây nếu vừa chuyển tab/tải lại trang.` : 'Bấm Chuẩn hóa trước, sau đó vào lại mục này để xem biến.'}
            />
          )}
          {!variableCatalogLoading && variableCatalog && (
            <div style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
              <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                <button type="button" onClick={() => setVariableGroupFilter('all')} style={groupButtonStyle(variableGroupFilter === 'all')}>Tất cả <span style={{ color: C.text3 }}>{catalogGroupOptions.reduce((sum, g) => sum + Number(g.count || 0), 0)}</span></button>
                {catalogGroupOptions.map(g => (
                  <button key={g.key} type="button" onClick={() => setVariableGroupFilter(g.key)} style={groupButtonStyle(variableGroupFilter === g.key)}>
                    {g.label} <span style={{ color: C.text3 }}>{g.count}</span>
                  </button>
                ))}
              </div>

              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, flexWrap: 'wrap', alignItems: 'baseline', padding: '2px 0' }}>
                <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>{variableGroupFilter === 'all' ? 'Biến phù hợp' : activeGroup?.label || 'Nhóm biến'}</div>
                <div style={{ fontSize: FS.xs, color: C.text3 }}>
                  {compactNumber(totalVisible)} biến{!showTechnicalVariables ? ' · đã ẩn định danh/kỹ thuật' : ''}
                </div>
              </div>

              {!filteredCatalogVariables.length && <EmptyState title="Không có biến phù hợp" hint="Thử bỏ lọc loại biến/mức đầy đủ hoặc bật hiển thị biến định danh/kỹ thuật." />}
              {!!filteredCatalogVariables.length && (
                <div style={{ maxHeight: 'calc(100vh - 385px)', overflow: 'auto', display: 'grid', gap: 10, paddingRight: 3 }}>
                  {filteredVariableSections.map(section => (
                    <div key={section.label} style={{ background: C.surface, overflow: 'hidden', borderTop: `1px solid ${C.border2}` }}>
                      <div style={{ padding: '9px 11px', borderBottom: `1px solid ${C.border2}`, display: 'flex', justifyContent: 'space-between', gap: 8, alignItems: 'center' }}>
                        <div style={{ fontSize: FS.sm, fontWeight: 700, color: C.text }}>{section.label}</div>
                        {pill(`${section.variables.length} biến`, 'neutral')}
                      </div>
                      <div style={{ display: 'grid', gap: 0 }}>
                        {section.variables.map(renderVariableCard)}
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      <div style={{ background: C.surface, padding: '4px 0 12px 14px', position: 'sticky', top: 10, flex: '0 1 330px', minWidth: 300, borderLeft: `1px solid ${C.border2}` }}>
        <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Tạo nghiên cứu từ biến đã chọn</div>
        <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 4 }}>{selectedVariables.length} biến · {variableConditions.length} điều kiện</div>

        {!!selectedVariables.length && (
          <div style={{ marginTop: 10, padding: 9, borderRadius: 7, background: selectedCoverage.low ? C.amberBg : C.greenBg, border: `1px solid ${selectedCoverage.low ? C.amberBorder : C.greenBorder}` }}>
            <div style={{ fontSize: FS.xs, fontWeight: 700, color: selectedCoverage.low ? C.amber : C.green }}>Kiểm tra độ phủ biến đã chọn</div>
            <div style={{ marginTop: 6, display: 'grid', gridTemplateColumns: 'repeat(3, minmax(0,1fr))', gap: 5 }}>
              <StatBadge label="≥80%" value={selectedCoverage.high} tone="ok" />
              <StatBadge label="30–79%" value={selectedCoverage.medium} tone="info" />
              <StatBadge label="<30%" value={selectedCoverage.low} tone={selectedCoverage.low ? 'warn' : 'neutral'} />
            </div>
            <div style={{ marginTop: 7, fontSize: FS.xs, lineHeight: 1.4, color: C.text2 }}>
              Độ phủ thấp nhất: <b>{selectedCoverage.lowest}%</b>. Đây là độ phủ từng biến, chưa phải số hồ sơ hoàn chỉnh cuối cùng.
            </div>
          </div>
        )}

        <div style={{ marginTop: 10, padding: '10px 0', display: 'grid', gap: 8, borderTop: `1px solid ${C.border2}`, borderBottom: `1px solid ${C.border2}` }}>
          <div style={{ fontSize: FS.xs, fontWeight: 700, color: C.text }}>Thông tin nghiên cứu</div>
          <input value={variableStudyDraft.name} onChange={e => setVariableStudyDraft(p => ({ ...p, name: e.target.value }))} placeholder="Tên nghiên cứu, VD: Gãy cổ xương đùi 2026" style={inp} />
          <textarea value={variableStudyDraft.description} onChange={e => setVariableStudyDraft(p => ({ ...p, description: e.target.value }))} placeholder="Mô tả ngắn / mục tiêu nghiên cứu" rows={2} style={{ ...inp, height: 'auto', paddingTop: 7, paddingBottom: 7, resize: 'vertical' }} />
          <Btn onClick={loadVariablePreview} disabled={variablePreviewLoading || !selectedVariables.length} style={{ height: 30 }}>
            {variablePreviewLoading ? <><Spinner size={9} /> Đang kiểm tra</> : 'Xem trước 20 lượt'}
          </Btn>
          <Btn variant="primary" onClick={createStudyFromVariableSelection} disabled={busy || !selectedVariables.length || !text(variableStudyDraft.name) || !variablePreviewConfirmed} style={{ height: 30 }}>
            {busy ? <><Spinner size={9} /> Đang tạo</> : '＋ Tạo nghiên cứu'}
          </Btn>
          <div style={{ fontSize: FS.xs, color: C.text3, lineHeight: 1.4 }}>Phải xem trước và xác nhận dữ liệu trước khi tạo nghiên cứu.</div>
        </div>

        <div style={{ marginTop: 12, fontSize: FS.sm, fontWeight: 700, color: C.text }}>Biến sẽ lấy</div>
        <div style={{ marginTop: 8, maxHeight: 190, overflow: 'auto', display: 'flex', flexDirection: 'column', gap: 8 }}>
          {!selectedVariables.length && <div style={{ border: `1px dashed ${C.border}`, borderRadius: 6, padding: 10, fontSize: FS.xs, color: C.text3, lineHeight: 1.45 }}>Chưa chọn biến. Nên bắt đầu từ <b>Hành chánh</b> và <b>Đợt điều trị</b>, sau đó thêm Xét nghiệm/CĐHA/Phẫu thuật theo mục tiêu nghiên cứu.</div>}
          {selectedVariablesByGroup.map(group => (
            <div key={group.label} style={{ border: `1px solid ${C.border2}`, borderRadius: 6, overflow: 'hidden' }}>
              <div style={{ padding: '6px 8px', background: C.surface2, fontSize: FS.xs, fontWeight: 700, color: C.text2 }}>{group.label}</div>
              {group.variables.map(v => {
                const isRepeatedTable = !['analysis_ready', 'encounters', 'patients', 'cohort', 'research_source'].includes(String(v.table || ''));
                return (
                <div key={v.id} style={{ padding: '7px 8px', borderTop: `1px solid ${C.border2}`, display: 'grid', gridTemplateColumns: 'minmax(0,1fr) auto', gap: 8, alignItems: 'center' }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: FS.xs, fontWeight: 700, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{v.display_label}</div>
                    <div style={{ fontSize: FS.xs, color: C.text3 }}>{v.raw_name}</div>
                    <input
                      value={variableSurveyLabels[v.id] ?? v.display_label ?? v.name}
                      onChange={e => setVariableSurveyLabels(prev => ({ ...prev, [v.id]: e.target.value }))}
                      placeholder="Tên biến trên phiếu khảo sát"
                      title="Tên cột muốn xuất theo phiếu khảo sát"
                      style={{ ...inp, height: 26, marginTop: 5, fontSize: FS.xs, padding: '2px 6px' }}
                    />
                    {isRepeatedTable && (
                      <select
                        value={variableAggregations[v.id] || 'list'}
                        onChange={e => setVariableAggregations(prev => ({ ...prev, [v.id]: e.target.value }))}
                        title="Cách tổng hợp khi một lượt có nhiều dòng dữ liệu"
                        style={{ ...inp, height: 26, marginTop: 5, fontSize: FS.xs, padding: '2px 6px' }}
                      >
                        {VARIABLE_AGGREGATIONS.map(([key, label]) => <option key={key} value={key}>{label}</option>)}
                      </select>
                    )}
                  </div>
                  <button type="button" onClick={() => toggleVariable(v.id)} style={{ border: 0, background: 'transparent', color: C.red, cursor: 'pointer', fontSize: FS.md }}>✕</button>
                </div>
                );
              })}
            </div>
          ))}
        </div>

        <div style={{ marginTop: 14, fontSize: FS.md, fontWeight: 700, color: C.text }}>Điều kiện lọc</div>
        <div style={{ fontSize: FS.xs, color: C.text3, marginTop: 3 }}>Điều kiện dùng để lọc đối tượng nghiên cứu, ví dụ: tuổi ≥ 60, Hb &lt; 90, có phẫu thuật.</div>
        <div style={{ marginTop: 8, display: 'flex', flexDirection: 'column', gap: 8, maxHeight: 300, overflow: 'auto' }}>
          {!variableConditions.length && <div style={{ border: `1px dashed ${C.border}`, borderRadius: 6, padding: 10, fontSize: FS.xs, color: C.text3 }}>Bấm <b>+ Điều kiện</b> ở biến cần ràng buộc.</div>}
          {variableConditions.map((cond, i) => {
            const variable = allCatalogVariables.find(v => v.id === cond.variable_id);
            return (
              <div key={cond.id} style={{ border: `1px solid ${C.border2}`, borderRadius: 6, padding: 9, display: 'grid', gap: 7 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
                  <div style={{ minWidth: 0 }}>
                    <div style={{ fontSize: FS.xs, fontWeight: 700, color: C.text, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{variable?.display_label || cond.label}</div>
                    <div style={{ fontSize: FS.xs, color: C.text3 }}>{variable?.clinical_group_label || variable?.group_label || ''}</div>
                  </div>
                  <button type="button" onClick={() => setVariableConditions(prev => prev.filter((_, j) => j !== i))} style={{ border: 0, background: 'transparent', color: C.red, cursor: 'pointer' }}>✕</button>
                </div>
                <select value={cond.operator} onChange={e => setVariableConditions(prev => prev.map((x, j) => j === i ? { ...x, operator: e.target.value } : x))} style={inp}>
                  {(variable?.operators || ['contains', '=']).map(op => <option key={op} value={op}>{operatorLabel(op)}</option>)}
                </select>
                <input value={cond.value} onChange={e => setVariableConditions(prev => prev.map((x, j) => j === i ? { ...x, value: e.target.value } : x))} placeholder="Giá trị điều kiện" style={inp} />
                {cond.operator === 'between' && <input value={cond.value2} onChange={e => setVariableConditions(prev => prev.map((x, j) => j === i ? { ...x, value2: e.target.value } : x))} placeholder="Giá trị đến" style={inp} />}
              </div>
            );
          })}
        </div>
        <div style={{ display: 'flex', gap: 8, marginTop: 12, flexWrap: 'wrap' }}>
          <Btn variant="success" onClick={exportVariableSpec} disabled={!selectedVariables.length && !variableConditions.length} style={{ height: 28 }}>Tải cấu hình JSON</Btn>
          <Btn onClick={() => { setSelectedVariableIds(new Set()); setVariableAggregations({}); setVariableSurveyLabels({}); setVariableConditions([]); }} style={{ height: 28 }}>Xóa chọn</Btn>
        </div>
      </div>
      {(variablePreview || variablePreviewError) && (
        <div style={{ flex: '1 0 100%', minWidth: 0, borderTop: `1px solid ${C.border2}`, paddingTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 10, alignItems: 'flex-start', flexWrap: 'wrap' }}>
            <div>
              <div style={{ fontSize: FS.md, fontWeight: 700, color: C.text }}>Kiểm tra dữ liệu trước khi tạo nghiên cứu</div>
              <div style={{ marginTop: 3, fontSize: FS.xs, color: C.text3 }}>Hiển thị tối đa 20 lượt; thông tin định danh được ẩn mặc định.</div>
            </div>
            <Btn onClick={loadVariablePreview} disabled={variablePreviewLoading} style={{ height: 28 }}>↻ Kiểm tra lại</Btn>
          </div>
          {variablePreviewError && <div style={{ marginTop: 10, color: C.red, background: C.redBg, border: `1px solid ${C.redBorder}`, borderRadius: 7, padding: 9 }}>{variablePreviewError}</div>}
          {variablePreview && (
            <>
              <div style={{ marginTop: 10, display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(125px, 1fr))', gap: 7 }}>
                <StatBadge label="Tổng lượt" value={compactNumber(variablePreview.summary?.total || 0)} tone="info" />
                <StatBadge label="Đủ tất cả biến" value={compactNumber(variablePreview.summary?.complete || 0)} tone="ok" />
                <StatBadge label="Thiếu một phần" value={compactNumber(variablePreview.summary?.partial || 0)} tone="warn" />
                <StatBadge label="Trống toàn bộ" value={compactNumber(variablePreview.summary?.empty || 0)} tone="warn" />
                <StatBadge label="Cần rà soát" value={compactNumber(variablePreview.summary?.review || 0)} tone="warn" />
              </div>
              <div style={{ marginTop: 10, overflow: 'auto', border: `1px solid ${C.border2}`, borderRadius: 7, maxHeight: 390 }}>
                <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: FS.xs, whiteSpace: 'nowrap' }}>
                  <thead style={{ position: 'sticky', top: 0, background: C.surface2, zIndex: 1 }}><tr>
                    {(variablePreview.columns || []).map(column => <th key={column} style={{ textAlign: 'left', padding: '7px 8px', borderBottom: `1px solid ${C.border2}` }}>{variablePreview.variables?.find(v => v.output_column === column)?.survey_label || column}</th>)}
                  </tr></thead>
                  <tbody>{(variablePreview.rows || []).map((row, index) => <tr key={row.encounter_id || row.research_code || index}>
                    {(variablePreview.columns || []).map(column => <td key={column} style={{ padding: '6px 8px', borderBottom: `1px solid ${C.border2}`, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis' }}>{text(row[column]) || '—'}</td>)}
                  </tr>)}</tbody>
                </table>
              </div>
              <div style={{ marginTop: 10, display: 'grid', gap: 5 }}>
                <div style={{ fontSize: FS.xs, fontWeight: 700, color: C.text }}>Độ đầy đủ theo từng biến</div>
                {(variablePreview.summary?.variables || []).map(variable => (
                  <div key={variable.id} style={{ display: 'grid', gridTemplateColumns: 'minmax(150px,1fr) auto auto', gap: 10, fontSize: FS.xs, color: C.text2 }}>
                    <span>{variable.survey_label}</span><span>{variable.fill_rate}% có dữ liệu</span><span>thiếu {compactNumber(variable.missing)}</span>
                  </div>
                ))}
              </div>
              <label style={{ marginTop: 12, padding: 10, display: 'flex', gap: 8, alignItems: 'flex-start', border: `1px solid ${variablePreviewConfirmed ? C.greenBorder : C.amberBorder}`, background: variablePreviewConfirmed ? C.greenBg : C.amberBg, borderRadius: 7, color: C.text, cursor: 'pointer' }}>
                <input type="checkbox" checked={variablePreviewConfirmed} onChange={e => setVariablePreviewConfirmed(e.target.checked)} />
                <span><b>Tôi đã kiểm tra bảng ánh xạ và dữ liệu xem trước.</b><br/><span style={{ fontSize: FS.xs, color: C.text2 }}>Sau khi xác nhận, nút Tạo nghiên cứu sẽ được mở.</span></span>
              </label>
            </>
          )}
        </div>
      )}
      </div>
    </div>
  );
}
