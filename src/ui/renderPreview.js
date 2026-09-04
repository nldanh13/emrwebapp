function escapeHtml(value) {
  return String(value ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function renderPreviewText(plan) {
  const lines = [];
  lines.push('=== XEM TRƯỚC ĐIỀU DƯỠNG HÀNH CHÁNH / VTYT ===');
  lines.push(`Người bệnh: ${plan.patient?.display_name || '[Ẩn tên]'} | ${plan.patient?.ma_bn || '[Ẩn mã]'}`);
  lines.push(`Trạng thái: ${plan.is_exit_case ? 'Ra viện/chuyển khoa' : 'Đang điều trị'}`);
  lines.push(`Khoảng kiểm tra VTYT: ${plan.time_range?.from || '?'} → ${plan.time_range?.to || '?'}`);
  lines.push(`Lý do: ${plan.time_range?.reason || ''}`);
  lines.push('');
  lines.push('[VẬT TƯ CẦN KIỂM]');

  for (const item of plan.vtyt?.comparison || []) {
    const status = item.status === 'ok' ? 'Đủ' : `Thiếu ${item.missing_quantity}`;
    lines.push(`- ${item.name}: cần ${item.required_quantity}, đã có ${item.existing_quantity} → ${status}`);
    for (const reason of item.reasons || []) lines.push(`  + ${reason}`);
  }

  lines.push('');
  lines.push('[HÀNH ĐỘNG DỰ KIẾN]');
  if (!plan.planned_actions?.length) lines.push('- Không cần thêm vật tư.');
  for (const action of plan.planned_actions || []) lines.push(`- ${action.label}`);
  return lines.join('\n');
}

export function renderPreviewHTML(plan) {
  const rows = (plan.vtyt?.comparison || []).map((item) => `
    <tr class="${item.status === 'missing' ? 'is-missing' : 'is-ok'}">
      <td>${escapeHtml(item.code)}</td>
      <td>${escapeHtml(item.name)}</td>
      <td style="text-align:right">${escapeHtml(item.required_quantity)}</td>
      <td style="text-align:right">${escapeHtml(item.existing_quantity)}</td>
      <td style="text-align:right">${escapeHtml(item.missing_quantity)}</td>
      <td>${escapeHtml((item.reasons || []).join('; '))}</td>
    </tr>`).join('');

  const actions = (plan.planned_actions || []).map((a) => `<li>${escapeHtml(a.label)}</li>`).join('') || '<li>Không cần thêm vật tư.</li>';

  return `
    <section class="admin-nurse-preview">
      <h3>Xem trước Điều dưỡng hành chánh / VTYT</h3>
      <div><b>Người bệnh:</b> ${escapeHtml(plan.patient?.display_name || '[Ẩn tên]')} | ${escapeHtml(plan.patient?.ma_bn || '[Ẩn mã]')}</div>
      <div><b>Trạng thái:</b> ${plan.is_exit_case ? 'Ra viện/chuyển khoa' : 'Đang điều trị'}</div>
      <div><b>Khoảng kiểm tra:</b> ${escapeHtml(plan.time_range?.from || '?')} → ${escapeHtml(plan.time_range?.to || '?')}</div>
      <div><b>Lý do:</b> ${escapeHtml(plan.time_range?.reason || '')}</div>
      <table class="preview-vtyt-table" style="width:100%;border-collapse:collapse;margin-top:12px">
        <thead><tr><th>Mã</th><th>Vật tư</th><th>Cần</th><th>Đã có</th><th>Thiếu</th><th>Lý do</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <h4>Hành động dự kiến</h4>
      <ol>${actions}</ol>
    </section>`;
}
