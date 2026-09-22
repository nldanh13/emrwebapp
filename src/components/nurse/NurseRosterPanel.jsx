import { useState } from 'react';
import { C } from '../../tokens.js';
import { Btn, SectionLabel } from '../shared.jsx';

const EMR_INPUT_STYLE = {
  width: '100%',
  background: C.surface,
  border: `1px solid ${C.border}`,
  borderRadius: 4,
  padding: '4px 6px',
  color: C.text,
  fontSize: 11,
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
    <div style={{ marginTop: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
      <div style={{
        width: 60, height: 28, border: `1px dashed ${C.border}`, borderRadius: 4,
        display: 'flex', alignItems: 'center', justifyContent: 'center', overflow: 'hidden',
        background: C.surface, flexShrink: 0,
      }}>
        {dataUrl
          ? <img src={dataUrl} alt={`Chữ ký ${name}`} style={{ maxWidth: '100%', maxHeight: '100%', objectFit: 'contain' }} />
          : <span style={{ fontSize: 9, color: C.text3 }}>Chưa có</span>}
      </div>
      <label
        htmlFor={inputId}
        style={{
          fontSize: 11, color: C.blue, cursor: busy ? 'default' : 'pointer',
          textDecoration: 'underline', opacity: busy ? 0.5 : 1,
        }}
      >
        {busy ? 'Đang tải...' : (dataUrl ? 'Đổi chữ ký' : 'Tải chữ ký lên')}
      </label>
      <input
        id={inputId}
        type="file"
        accept="image/png,image/jpeg"
        onChange={handleFile}
        disabled={busy}
        style={{ display: 'none' }}
      />
      {dataUrl && (
        <button
          type="button"
          onClick={() => onRemoveSignature(name)}
          disabled={busy}
          title="Xóa chữ ký"
          style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.text3, fontSize: 11, padding: 0 }}
        >✕</button>
      )}
      {error && <span style={{ fontSize: 10, color: C.red }}>{error}</span>}
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
        style={EMR_INPUT_STYLE}
      />
      <div style={{ position: 'relative' }}>
        <input
          type={revealed ? 'text' : 'password'}
          value={password}
          onChange={e => onChangeEmrAccount(name, 'emr_password', e.target.value)}
          placeholder="Mật khẩu EMR"
          style={{ ...EMR_INPUT_STYLE, paddingRight: 24 }}
        />
        <button
          type="button"
          onClick={() => setRevealed(v => !v)}
          title={revealed ? 'Ẩn' : 'Hiện'}
          style={{ position: 'absolute', right: 2, top: '50%', transform: 'translateY(-50%)', background: 'none', border: 'none', cursor: 'pointer', fontSize: 11, padding: 2 }}
        >{revealed ? '🙈' : '👁'}</button>
      </div>
    </div>
  );
}

export default function NurseRosterPanel({
  isMobile = false,
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
  return (
    <div style={isMobile ? { padding: '0 0 24px' } : {}}>
      <SectionLabel>Điều dưỡng</SectionLabel>
      <div style={{ padding: '8px 12px', borderBottom: `1px solid ${C.border2}`, display: 'flex', gap: 6 }}>
        <input
          value={newName}
          onChange={e => setNewName(e.target.value)}
          onKeyDown={e => e.key === 'Enter' && onAddNurse()}
          placeholder="Tên điều dưỡng..."
          style={{ flex: 1, background: C.surface, border: `1px solid ${C.border}`, borderRadius: 4, padding: '6px 8px', color: C.text, fontSize: 13, fontFamily: 'inherit', outline: 'none' }}
        />
        <Btn variant="primary" onClick={onAddNurse}>+</Btn>
      </div>
      {canEditEmrAccounts && roster.length > 0 && (
        <div style={{ padding: '6px 12px 0', fontSize: 11, color: C.text3, lineHeight: 1.5 }}>
          Tài khoản EMR riêng cho từng điều dưỡng — dùng khi nhập chăm sóc để ca làm/ca trực đăng nhập đúng tài khoản của người phụ trách. Bỏ trống thì dùng tài khoản EMR mặc định.
          {' '}Ảnh chữ ký dùng để tự động chèn vào bộ phiếu "IN RA VIỆN" ở tab Chữ ký ra viện — bỏ trống thì không chèn cho người đó.
        </div>
      )}
      {roster.map(name => (
        <div key={name} style={{ padding: '10px 12px', borderBottom: `1px solid ${C.border2}` }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <span style={{ fontSize: 13, color: C.text }}>{name}</span>
            <button type="button" onClick={() => onRemoveNurse(name)} style={{ background: 'none', border: 'none', cursor: 'pointer', color: C.text3, fontSize: 16, padding: '0 4px', minWidth: 32, minHeight: 32 }}>✕</button>
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
      {roster.length === 0 && <div style={{ padding: 12, fontSize: 12, color: C.text3 }}>Chưa có điều dưỡng</div>}
    </div>
  );
}
