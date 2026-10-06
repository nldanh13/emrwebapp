// Kiến thức thuốc sẵn có (config/medication_builtin.json) → các mục hiện ở "Sẵn có" trong Danh mục
// thuốc, mỗi dòng chép được thành thuốc trong danh mục (mẫu điền sẵn) để người dùng sửa.
// Thuốc trong danh mục luôn được ưu tiên hơn mục sẵn có.

const noMeta = obj => Object.entries(obj || {}).filter(([k]) => !String(k).startsWith('__'));
const nameOf = key => String(key || '').replace(/_/g, ' ').trim();

export function builtinSections(builtin) {
  const b = builtin || {};
  const tt = b.the_tich_mac_dinh || {};
  const lp = b.luat_pha || {};
  const volumeRow = ([key, ml]) => ({
    label: nameOf(key), detail: `${ml} ml`,
    prefill: { canonical: nameOf(key), default_volume_ml: String(ml) },
  });
  const nacl = (name, ml, apply = 'always', note = '') => ({
    canonical: name,
    dilution_solvent: 'NACL_0.9', dilution_volume_ml: ml == null ? '' : String(ml), dilution_apply: apply, dilution_note: note,
  });
  return [
    {
      id: 'luat_pha', title: 'Quy tắc pha sẵn có', desc: lp.__mo_ta || '',
      rows: [
        ...(lp.theo_hoat_chat || []).map(r => {
          const apply = r.hoat_chat === 'TRAMADOL' ? 'infusion_only' : 'always';
          return {
            label: r.hoat_chat, detail: `${r.dung_moi || 'Natri clorid 0.9%'} ${r.the_tich_sau_pha_ml ?? ''} ml${r.ghi_chu ? ` — ${r.ghi_chu}` : ''}`,
            prefill: nacl(r.hoat_chat, r.the_tich_sau_pha_ml, apply, r.ghi_chu || ''),
          };
        }),
        ...noMeta(lp.the_tich_theo_tu_khoa).map(([kw, ml]) => ({
          label: kw, detail: `Natri clorid 0.9% ${ml} ml (theo từ khoá tên)`, prefill: nacl(kw, ml),
        })),
      ],
    },
    {
      id: 'the_tich', title: 'Thể tích mặc định sẵn có', desc: tt.__mo_ta || '',
      rows: [...noMeta(tt.theo_ten), ...noMeta(tt.theo_tu_khoa)].map(volumeRow),
    },
    {
      id: 'hoat_chat', title: 'Hoạt chất của tên thương mại', desc: (b.hoat_chat_theo_ten_thuong_mai || {}).__mo_ta || '',
      rows: noMeta(b.hoat_chat_theo_ten_thuong_mai).map(([brand, active]) => ({
        label: brand, detail: `Hoạt chất: ${active}`, prefill: { canonical: brand, active_ingredients: active },
      })),
    },
    {
      id: 'dung_moi_di_kem', title: 'Thuốc có dung môi đi kèm', desc: (b.co_dung_moi_di_kem || {}).__mo_ta || '',
      rows: ((b.co_dung_moi_di_kem || {}).tu_khoa || []).map(kw => ({
        label: kw, detail: 'Không ghi "+ Pha nước cất"', prefill: { canonical: kw, co_dung_moi_di_kem: true },
      })),
    },
    {
      id: 'ten_hien_thi', title: 'Tên hiển thị chuẩn', desc: (b.ten_hien_thi_chuan || {}).__mo_ta || '',
      rows: ((b.ten_hien_thi_chuan || {}).nhom || []).map(g => ({
        label: g.ten, detail: `Khớp: ${(g.aliases || []).join(', ')}${g.ham_luong_mac_dinh ? ` · hàm lượng mặc định ${g.ham_luong_mac_dinh}` : ''}`,
        prefill: { canonical: g.ten, aliases: (g.aliases || []).join(', '), ten_hien_thi: g.ten },
      })),
    },
  ].filter(s => s.rows.length);
}

// Bổ sung mẫu sẵn có vào form thuốc đã có: CHỈ điền ô đang trống, không ghi đè điều người dùng đã nhập.
export function fillEmptyFields(form, prefill) {
  const out = { ...form };
  for (const [key, value] of Object.entries(prefill || {})) {
    if (key === 'canonical') continue;
    const cur = out[key];
    const empty = cur === '' || cur == null || cur === false;
    if (key.startsWith('dilution_') && key !== 'dilution_solvent' && form.dilution_solvent) continue;
    if (empty) out[key] = value;
  }
  return out;
}
