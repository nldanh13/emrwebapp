import { useState } from 'react';
import { IconEye, IconEyeOff, IconPlus, IconTrash, IconUpload, IconX } from '@tabler/icons-react';
import { C, FS } from '../../tokens.js';
import { Btn, SectionLabel } from '../shared.jsx';

const EMR_INPUT_STYLE = {
  width: '100%',
  background: C.surface,
  border: `1px solid ${C.border}`,
  borderRadius: 5,
  height: 30,
  padding: '0 8px',
  color: C.text,
  fontSize: FS.sm,
  fontFamily: 'inherit',
  outline: 'none',
  boxSizing: 'border-box',
};

const MAX_SIGNATURE_BYTES = 2 * 1024 * 1024;

function readFileAsDataUrl(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result || ''));
    reader.onerror = () => reject(reader.error || new Error('Không đọc được file.'));
    reader.readAsDataURL(file);
  });
}

function NurseSignatureField({ name, account, onUploadSignature, onRemoveSignature }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const inputId = `sig-upload-${name}`;
  const dataUrl = account?.signature_data_url || '';

  const handleFile = async (e) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!/^image\/(png|jpe?g)$/i.test(file.type)) {
      setError('Chỉ nhận ảnh PNG hoặc JPEG.');
      return;
    }
    if (file.size > MAX_SIGNATURE_BYTES) {
      setError('Ảnh quá lớn (tối đa 2MB).');
      return;
    }
    setError('');
    setBusy(true);
    try {
      const imageDataUrl = await readFileAsDataUrl(file);
      await onUploadSignature(name, imageDataUrl);
    } catch (err) {
      setError(String(err?.message || err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
      <div style={{
        width: 64, height: 30, border: `1px dashed ${C.border}`, borderRadius: 5,
        display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
        background: C.surface, flexShrink: 0,
      }}>
        {dataUrl
          ? <img src={dataUrl} alt={`Chữ ký ${name}`} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          : <span style={{ fontSize: FS.xs, color: C.text2 }}>Chưa có</span>}
      </div>
      <label
        htmlFor={inputId}
        style={{
          display: 'inline-flex', alignItems: 'center', gap: 4,
          fontSize: FS.sm, fontWeight: 600, color: C.blue, cursor: busy ? 'default' : 'pointer', opacity: busy ? 0.5 : 1,
        }}
      >
        <IconUpload size={14} stroke={1.9} aria-hidden="true" />
        {busy ? 'Đang tải…' : (dataUrl ? 'Đổi chữ ký' : 'Tải chữ ký')}
      </label>
      <input
        id={inputId}
        type="file"
        accept="image/png,image/jpeg"
        onChange={handleFile}
        disabled={busy}
        className="emr-sr-only"
      />
      {dataUrl && (
        <button
          type="button"
          className="emr-icon-btn"
          onClick={() => onRemoveSignature(name)}
          disabled={busy}
          aria-label={`Xóa chữ ký ${name}`}
          title="Xóa chữ ký"
          style={{ width: 28, height: 28 }}
        ><IconX size={15} stroke={1.75} /></button>
      )}
      {error && <span role="alert" style={{ fontSize: FS.xs, color: C.red }}>{error}</span>}
    </div>
  );
}

function NurseEmrAccountFields({ name, account, onChangeEmrAccount }) {
  const [revealed, setRevealed] = useState(false);
  const username = account?.emr_username || '';
  const password = account?.emr_password || '';
  return (
    <div style={{ marginTop: 6, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <input
        value={username}
        onChange={e => onChangeEmrAccount(name, 'emr_username', e.target.value)}
        placeholder="Tài khoản EMR"
        aria-label={`Tài khoản EMR của ${name}`}
        autoComplete="off"
        style={EMR_INPUT_STYLE}
      />
      <div style={{ position: 'relative' }}>
        <input
          type={revealed ? 'text' : 'password'}
          value={password}
          onChange={e => onChangeEmrAccount(name, 'emr_password', e.target.value)}
          placeholder="Mật khẩu EMR"
          aria-label={`Mật khẩu EMR của ${name}`}
          autoComplete="new-password"
          style={{ ...EMR_INPUT_STYLE, paddingRight: 32 }}
        />
        <button
          type="button"
          onClick={() => setRevealed(v => !v)}
          aria-label={revealed ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
          title={revealed ? 'Ẩn mật khẩu' : 'Hiện mật khẩu'}
          className="emr-icon-btn"
          style={{ position: 'absolute', right: 1, top: 1, width: 28, height: 28 }}
        >{revealed ? <IconEyeOff size={15} stroke={1.75} /> : <IconEye size={15} stroke={1.75} />}</button>
      </div>
    </div>
  );
}

export default function NurseRosterPanel({
  roster = [],
  newName = '',
  setNewName,
  onAddNurse,
  onRemoveNurse,
  emrAccounts = {},
  onChangeEmrAccount,
  onUploadSignature,
  onRemoveSignature,
  canEditEmrAccounts = false,
}) {
  const removeNurse = (name) => {
    if (window.confirm(`Xoá ${name} khỏi danh sách? Tên cũng bị gỡ khỏi mọi ca đã phân công.`)) onRemoveNurse(name);
  };
  return (
    <div>
      <SectionLabel>Điều dưỡng ({roster.length})</SectionLabel>
      <form onSubmit={e => { e.preventDefault(); onAddNurse(); }} style={{ padding: '4px 12px 10px', borderBottom: `1px solid ${C.border2}`, display: 'flex', gap: 6 }}>
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          placeholder="Tên điều dưỡng"
          aria-label="Tên điều dưỡng mới"
          style={{ flex: 1, minWidth: 0, height: 32, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 5, padding: '0 8px', color: C.text, fontSize: FS.md, fontFamily: 'inherit' }}
        />
        <Btn type="submit" variant="primary" icon={IconPlus} disabled={!newName.trim()}>Thêm</Btn>
      </form>
      {canEditEmrAccounts && roster.length > 0 && (
        <div style={{ padding: '8px 12px 0', fontSize: FS.xs, color: C.text2, lineHeight: 1.5 }}>
          Tài khoản EMR riêng giúp ca làm/ca trực đăng nhập đúng người khi nhập chăm sóc; bỏ trống thì dùng tài khoản mặc định.
          {' '}Ảnh chữ ký dùng để chèn vào bộ phiếu "In ra viện" (màn Chữ ký ra viện).
        </div>
      )}
      {roster.map(name => (
        <div key={name} style={{ padding: '10px 12px', borderBottom: `1px solid ${C.border2}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
            <span style={{ fontSize: FS.md, fontWeight: 600, color: C.text }}>{name}</span>
            <button type="button" className="emr-icon-btn emr-icon-btn--danger" onClick={() => removeNurse(name)} aria-label={`Xoá ${name}`} title="Xoá điều dưỡng" style={{ width: 30, height: 30 }}>
              <IconTrash size={16} stroke={1.75} />
            </button>
          </div>
          {canEditEmrAccounts && (
            <NurseEmrAccountFields
              name={name}
              account={emrAccounts[name]}
              onChangeEmrAccount={onChangeEmrAccount}
            />
          )}
          {canEditEmrAccounts && (
            <NurseSignatureField
              name={name}
              account={emrAccounts[name]}
              onUploadSignature={onUploadSignature}
              onRemoveSignature={onRemoveSignature}
            />
          )}
        </div>
      ))}
      {roster.length === 0 && <div style={{ padding: 12, fontSize: FS.sm, color: C.text2 }}>Chưa có điều dưỡng.</div>}
    </div>
  );
}
