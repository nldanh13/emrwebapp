// src/components/ClinicTab.jsx — tab Phòng khám đang được làm lại theo mô tả công việc mới.
import { C, FS } from '../tokens.js';

export default function ClinicTab() {
  return (
    <div style={{ padding: 24, maxWidth: 640, margin: '40px auto', textAlign: 'center', color: C.text2 }}>
      <div style={{ fontSize: FS.lg, fontWeight: 700, color: C.text, marginBottom: 8 }}>Phòng khám đang được làm lại</div>
      <div style={{ fontSize: FS.md, lineHeight: 1.6 }}>
        Chức năng cũ (nhập chăm sóc, nhập thủ thuật phòng khám) đã được gỡ để viết lại theo quy trình mới.
      </div>
    </div>
  );
}
