import { useState } from 'react';
import { C, FONT_MONO } from '../../tokens.js';
import { Badge } from '../shared.jsx';
import { normalizeGio, parseCheDoAn } from './patientDetailUtils.js';

function SectionHead({ children }) {
  return (
    <div style={{
      fontSize: 10, fontWeight: 700, letterSpacing: '0.08em', color: C.text3,
      textTransform: 'uppercase', display: 'flex', alignItems: 'center', gap: 8,
      margin: '16px 0 8px',
    }}>
      {children}
      <div style={{ flex: 1, height: 1, background: C.border2 }} />
    </div>
  );
}

function ExpandableText({ text, maxLines = 6 }) {
  const [expanded, setExpanded] = useState(false);
  if (!text) return null;
  const lines  = text.split('\n').filter(l => l.trim());
  const shown  = expanded ? lines : lines.slice(0, maxLines);
  const hasMore = lines.length > maxLines;
  return (
    <div>
      <div style={{ fontSize: 11, color: C.text2, lineHeight: 1.75, whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
        {shown.join('\n')}
      </div>
      {hasMore && (
        <button type="button" onClick={() => setExpanded(!expanded)} style={{
          marginTop: 5, background: 'none', border: 'none',
          color: C.blue, fontSize: 11, cursor: 'pointer', padding: 0,
          fontFamily: 'inherit',
        }}>
          {expanded ? '▲ Thu gọn' : `▼ Xem thêm (${lines.length - maxLines} dòng nữa)`}
        </button>
      )}
    </div>
  );
}

export function CareSection({ ncs = {}, cs_extra = {} }) {
  const [showYLenh, setShowYLenh] = useState(false);
  const cheDoAn  = cs_extra.che_do_an || '';
  const { cap, diet_code, diet_name } = parseCheDoAn(cheDoAn);
  const dienBien   = (ncs.dien_bien   || '').replace(/^---\n?/, '').trim();
  const yLenh      = (ncs.y_lenh      || '').trim();
  const dieuDuong  = (ncs.dieu_duong  || '').trim();
  const canhBao    = cs_extra.canh_bao  || [];
  const thayBang   = cs_extra.thay_bang_cat_chi || [];
  const duongMau   = cs_extra.duong_mau_mao_mach || [];
  const vatLy      = cs_extra.vat_ly_tri_lieu || '';
  const truyenMau  = cs_extra.truyen_mau || {};

  if (!cap && !diet_code && !dienBien && !yLenh) {
    return <div style={{ fontSize: 12, color: C.text3 }}>Không có dữ liệu chăm sóc</div>;
  }

  return (
    <div style={{
      background: C.surface, border: `1px solid ${C.greenBorder}`,
      borderLeft: `3px solid ${C.green}`, borderRadius: 6, padding: '12px 14px',
    }}>
      <div style={{ display: 'flex', gap: 5, flexWrap: 'wrap', marginBottom: dieuDuong ? 8 : 10 }}>
        {cap       && <Badge text={cap}       bg={C.greenBg}  color={C.green}  />}
        {diet_code && <Badge text={diet_code} bg={C.surface2} color={C.text2}  />}
        {diet_name && <Badge text={diet_name} bg={C.surface2} color={C.text2}  />}
        {vatLy     && <Badge text="VLTL"      bg={C.blueBg}   color={C.blue}   />}
        {duongMau.length > 0 && <Badge text={`ĐMMM ×${duongMau.length}`} bg={C.amberBg} color={C.amber} />}
        {thayBang.length > 0 && <Badge text={`Thay băng ×${thayBang.length}`} bg={C.amberBg} color={C.amber} />}
        {truyenMau.co_truyen_mau && <Badge text="🩸 Truyền máu" bg="#3d1a1a" color="#f87171" />}
      </div>

      {dieuDuong && (
        <div style={{
          display: 'flex', alignItems: 'center', gap: 6,
          padding: '5px 8px', borderRadius: 4, marginBottom: 10,
          background: C.surface2, border: `1px solid ${C.border}`,
        }}>
          <span style={{ fontSize: 10, color: C.text3 }}>Điều dưỡng nhập:</span>
          <span style={{ fontSize: 12, color: C.green, fontWeight: 600 }}>{dieuDuong}</span>
        </div>
      )}

      {canhBao.map((w, i) => (
        <div key={i} style={{
          fontSize: 11, color: C.red, background: C.redBg,
          border: `1px solid ${C.redBorder}`, borderRadius: 4,
          padding: '4px 8px', marginBottom: 6,
        }}>⚠ {w}</div>
      ))}

      {dienBien && (
        <>
          <div style={{ fontSize: 10, color: C.text3, fontWeight: 600, letterSpacing: '0.06em', marginBottom: 5 }}>
            DIỄN BIẾN
          </div>
          <ExpandableText text={dienBien} maxLines={6} />
        </>
      )}

      {yLenh && (
        <div style={{ marginTop: 10, borderTop: `1px solid ${C.border2}`, paddingTop: 8 }}>
          <button type="button" onClick={() => setShowYLenh(!showYLenh)} style={{
            background: 'none', border: 'none', color: C.text3,
            fontSize: 11, cursor: 'pointer', padding: 0, fontFamily: 'inherit',
            display: 'flex', alignItems: 'center', gap: 5,
          }}>
            <span>{showYLenh ? '▲' : '▶'}</span>
            <span>Y lệnh đầy đủ (raw)</span>
          </button>
          {showYLenh && (
            <div style={{
              marginTop: 7, fontSize: 10, color: C.text3, lineHeight: 1.8,
              whiteSpace: 'pre-wrap', wordBreak: 'break-word',
              background: C.surface2, borderRadius: 4, padding: '8px 10px',
              maxHeight: 260, overflowY: 'auto',
            }}>{yLenh}</div>
          )}
        </div>
      )}
    </div>
  );
}

function PreviewLabel({ children }) {
  return (
    <div style={{ fontSize: 10, color: C.text3, fontWeight: 600, letterSpacing: '0.04em', textTransform: 'uppercase', marginBottom: 4 }}>
      {children}
    </div>
  );
}

function PreviewValue({ children, mono = false, accent = null }) {
  return (
    <div style={{
      fontSize: 12,
      color: accent || C.text,
      fontFamily: mono ? FONT_MONO : 'inherit',
      lineHeight: 1.7,
      whiteSpace: 'pre-wrap',
      wordBreak: 'break-word',
    }}>
      {children || <span style={{ color: C.text3 }}>—</span>}
    </div>
  );
}

function PreviewField({ label, value, mono = false, accent = null }) {
  return (
    <div>
      <PreviewLabel>{label}</PreviewLabel>
      <PreviewValue mono={mono} accent={accent}>{value}</PreviewValue>
    </div>
  );
}

function CarePreviewSection({ careItems = [] }) {
  if (!careItems.length) {
    return <div style={{ fontSize: 12, color: C.text3 }}>Không có dữ liệu xem trước cho nhập chăm sóc</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {careItems.map((item, i) => (
        <div key={`${item.time_full || item.time_label || 'care'}-${i}`} style={{
          background: C.surface,
          border: `1px solid ${C.greenBorder}`,
          borderLeft: `3px solid ${C.green}`,
          borderRadius: 5,
          padding: '9px 10px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 13, fontWeight: 700, color: C.green }}>
              {item.time_label || normalizeGio(item.time_full) || '—'}
            </span>
            {item.dieu_duong && <Badge text={item.dieu_duong} bg={C.greenBg} color={C.green} />}
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'minmax(150px, 180px) 1fr', gap: 12 }}>
            <PreviewField label="Thời gian" value={item.time_full || item.time_label || '—'} mono />
            <PreviewField label="Điều dưỡng" value={item.dieu_duong || '—'} accent={item.dieu_duong ? C.green : null} />
          </div>

          <div style={{ marginTop: 10 }}>
            <PreviewLabel>Diễn biến bệnh</PreviewLabel>
            {item.dien_bien ? <ExpandableText text={item.dien_bien} maxLines={10} /> : <PreviewValue>—</PreviewValue>}
          </div>

          <div style={{ marginTop: 10 }}>
            <PreviewField label="Chăm sóc" value={item.cham_soc || '—'} />
          </div>
        </div>
      ))}
    </div>
  );
}

function InfusionPreviewSection({ infusionItems = [] }) {
  if (!infusionItems.length) {
    return <div style={{ fontSize: 12, color: C.text3 }}>Không có dữ liệu xem trước cho nhập dịch truyền</div>;
  }

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
      {infusionItems.map((item, i) => (
        <div key={`${item.tg_bat_dau || item.ten_hien_thi || 'dt'}-${i}`} style={{
          background: C.surface,
          border: `1px solid ${C.blueBorder || C.border}`,
          borderLeft: `3px solid ${C.blue}`,
          borderRadius: 5,
          padding: '9px 10px',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 10, flexWrap: 'wrap' }}>
            <span style={{ fontFamily: FONT_MONO, fontSize: 13, fontWeight: 700, color: C.blue }}>
              {normalizeGio(item.tg_bat_dau) || '—'}
            </span>
          </div>

          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(2, minmax(0, 1fr))', gap: 12 }}>
            <PreviewField label="Bác sĩ" value={item.bac_si || '—'} />
            <PreviewField label="Điều dưỡng" value={item.dieu_duong || '—'} accent={item.dieu_duong ? C.green : null} />
            <PreviewField label="Chọn thuốc" value={item.chon_thuoc || '—'} />
            <PreviewField label="Tên thuốc/dịch truyền" value={item.ten_hien_thi || '—'} />
            <PreviewField label="Thể tích" value={item.the_tich ? `${item.the_tich} ml` : '—'} mono />
            <PreviewField label="Tốc độ" value={item.toc_do ? `${item.toc_do} gt/p` : '—'} mono />
            <PreviewField label="TG bắt đầu" value={item.tg_bat_dau || '—'} mono />
            <PreviewField label="TG kết thúc" value={item.tg_ket_thuc || '—'} mono />
          </div>
        </div>
      ))}
    </div>
  );
}

export default function PatientPreview({ patientDay }) {
  const preview = patientDay?.preview || {};
  const careItems = preview.care || [];
  const infusionItems = preview.infusions || [];

  return (
    <div>
      <SectionHead>Nhập chăm sóc ({careItems.length})</SectionHead>
      <CarePreviewSection careItems={careItems} />

      <SectionHead>Nhập dịch truyền ({infusionItems.length})</SectionHead>
      <InfusionPreviewSection infusionItems={infusionItems} />
    </div>
  );
}
