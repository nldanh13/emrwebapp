// Nhập chứng từ lên Cổng BHYT (gdbhyt.baohiemxahoi.gov.vn) bằng tab cổng người dùng đã đăng nhập —
// cùng cách mở EMR: không chạy Chrome/Selenium, không cần start.bat.
//
// Người dùng mở cổng từ Data Hub (tab Nghỉ ốm), tự nhập CAPTCHA/OTP, rồi bấm nút dấu trang "Nhập BHYT"
// trên tab cổng. Nút đó nghe lệnh từ đúng cửa sổ Data Hub đã mở nó (postMessage), mở form tạo mới trong
// một khung cùng nguồn ngay trên tab cổng, điền bằng chính các control DevExpress của cổng, và chỉ bấm
// Lưu khi lệnh là "nhập thật". Điền thử và nhập thật dùng chung kế hoạch điền buildFillPlan().
//
// Ánh xạ field giữ đúng tools/bhyt_selenium_app (bhyt/emrwebapp_client.py, bhyt/portal.py, FIELD_MAP.md).

export const PORTAL_ORIGIN = 'https://gdbhyt.baohiemxahoi.gov.vn';
export const DOC_BHXH = 'BHXH07'; // Giấy chứng nhận nghỉ việc hưởng BHXH (mẫu 07) — ngoại trú
export const DOC_GRV = 'GRV03'; // Giấy ra viện (mẫu 03) — nội trú

export const DOC_LABELS = { [DOC_BHXH]: 'Giấy nghỉ (mẫu 07)', [DOC_GRV]: 'Giấy ra viện (mẫu 03)' };

// So tên bác sĩ: bỏ dấu, bỏ ký tự lạ, bỏ tiền tố học hàm (giống normalize_text của công cụ cũ).
export function normalizeDoctor(value) {
  const parts = String(value ?? '').normalize('NFD').replace(/[̀-ͯ]/g, '')
    .replace(/Đ/g, 'D').replace(/đ/g, 'd').toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ').trim().split(' ').filter(Boolean);
  const prefixes = new Set(['ths', 'th', 'ts', 'bs', 'cki', 'ckii', 'bscki', 'bsckii']);
  while (parts.length && prefixes.has(parts[0])) parts.shift();
  return parts.join(' ');
}

const val = (row, ...keys) => {
  for (const k of keys) {
    const v = row?.[k];
    if (v !== undefined && v !== null && v !== '') return String(v);
  }
  return '';
};

export function mapOutpatientRow(row) {
  return {
    ma_ct: val(row, 'ma_chung_tu'),
    so_seri: val(row, 'so_seri'),
    so_kcb: '', // File BHXH không có cột này — luôn bổ sung tay
    mau_so: val(row, 'mau_so') || '07',
    ma_bhxh: val(row, 'ma_so_bh'),
    ma_the: val(row, 'ma_the'),
    ho_ten: val(row, 'ho_ten'),
    ngay_sinh: val(row, 'ngay_sinh'),
    gioi_tinh: val(row, 'gioi_tinh'),
    ten_dv: val(row, 'don_vi'),
    ngay_kcb: '',
    chan_doan: val(row, 'chan_doan'),
    tu_ngay: val(row, 'dieu_tri_tu_ngay'),
    den_ngay: val(row, 'dieu_tri_den_ngay'),
    ho_ten_cha: val(row, 'ho_ten_cha'),
    ho_ten_me: val(row, 'ho_ten_me'),
    nguoi_dai_dien: val(row, 'thu_truong'),
    doctor_text: val(row, 'nguoi_hanh_nghe', 'bac_si_trong_danh_sach'),
    ngay_ct: val(row, 'ngay_chung_tu'),
  };
}

export function mapInpatientRow(row) {
  return {
    ma_ct: val(row, 'so_luu_tru'),
    so_seri: val(row, 'ma_y_te'),
    ma_bhxh: val(row, 'ma_so_bh'),
    ma_the: val(row, 'ma_the'),
    ho_ten: val(row, 'ho_ten'),
    ngay_sinh: val(row, 'ngay_sinh'),
    ho_ten_me: val(row, 'ho_ten_me'),
    ho_ten_cha: val(row, 'ho_ten_cha'),
    gioi_tinh: val(row, 'gioi_tinh'),
    nghe_nghiep: val(row, 'nghe_nghiep'),
    ma_khoa: val(row, 'khoa'),
    dan_toc: val(row, 'dan_toc'),
    dia_chi: val(row, 'dia_chi'),
    tu_ngay: val(row, 'ngay_vao_vien'),
    den_ngay: val(row, 'ngay_ra_vien'),
    dc_thainghen: val(row, 'dinh_chi_thai_nghen'),
    tuoi_thai: val(row, 'tuoi_thai'),
    chan_doan: val(row, 'chan_doan'),
    pp_dieutri: val(row, 'phuong_phap_dieu_tri'),
    ghi_chu: val(row, 'ghi_chu'),
    nguoi_dai_dien: val(row, 'thu_truong_don_vi'),
    doctor_text: val(row, 'truong_khoa', 'bac_si_trong_danh_sach'),
    ngay_ct: val(row, 'ngay_chung_tu'),
    ngoaitru_tungay: val(row, 'dieu_tri_ngoai_tru_tu_ngay'),
    ngoaitru_denngay: val(row, 'dieu_tri_ngoai_tru_den_ngay'),
    loai_giay_to: 'Không có giấy tờ',
  };
}

export const REQUIRED_FIELDS = {
  [DOC_BHXH]: {
    so_kcb: 'Số KCB', ma_bhxh: 'Mã số BHXH', ho_ten: 'Họ tên', ngay_sinh: 'Ngày sinh',
    chan_doan: 'Chẩn đoán và điều trị', tu_ngay: 'Ngày bắt đầu nghỉ', den_ngay: 'Ngày kết thúc nghỉ',
    doctor_text: 'Người hành nghề', ngay_ct: 'Ngày chứng từ',
  },
  [DOC_GRV]: {
    ma_bhxh: 'Mã số BHXH', ho_ten: 'Họ tên', ngay_sinh: 'Ngày sinh', gioi_tinh: 'Giới tính',
    ma_khoa: 'Khoa', dan_toc: 'Dân tộc', dia_chi: 'Địa chỉ', tu_ngay: 'Ngày vào viện',
    den_ngay: 'Ngày ra viện', chan_doan: 'Chẩn đoán', pp_dieutri: 'Phương pháp điều trị',
    doctor_text: 'Người hành nghề/trưởng khoa', ngay_ct: 'Ngày chứng từ',
  },
};

export function missingFields(docType, fields) {
  const req = REQUIRED_FIELDS[docType] || {};
  return Object.keys(req).filter(k => !String(fields?.[k] ?? '').trim());
}

export function compactCard(value) {
  return String(value ?? '').replace(/\s+/g, '').toUpperCase();
}

// Mã thẻ trên cổng tách 4 ô: 2 ký tự | 1 | 2 | phần còn lại; chỉ nhận thẻ 15 hoặc 17 ký tự.
export function cardParts(value) {
  const card = compactCard(value);
  if (!card) return null;
  if (card.length !== 15 && card.length !== 17) {
    throw new Error(`Mã thẻ phải có 15 hoặc 17 ký tự, hiện có ${card.length}.`);
  }
  return [card.slice(0, 2), card.slice(2, 3), card.slice(3, 5), card.slice(5)];
}

const BHXH_VALUES = {
  ma_ct: 'ma_ct', so_seri: 'so_seri', so_kcb: 'so_kcb', mau_so: 'mau_so', ma_bhxh: 'ma_sobhxh',
  ho_ten: 'ho_ten', ngay_sinh: 'ngay_sinh', ten_dv: 'ten_dv', chan_doan: 'chan_doan',
  ho_ten_cha: 'ho_ten_cha', ho_ten_me: 'ho_ten_me', nguoi_dai_dien: 'nguoi_dai_dien',
};
const BHXH_TEXTS = { ngay_kcb: 'ngay_kcb', tu_ngay: 'tu_ngay', den_ngay: 'den_ngay', ngay_ct: 'ngay_ct' };
const GRV_VALUES = {
  ma_ct: 'ma_ct', so_seri: 'so_seri', ma_bhxh: 'ma_sobhxh', ho_ten: 'ho_ten', ngay_sinh: 'ngay_sinh',
  ho_ten_me: 'ho_ten_nnd', ho_ten_cha: 'ho_ten_cha', nghe_nghiep: 'nghe_nghiep', dia_chi: 'dia_chi',
  tuoi_thai: 'tuoi_thai', chan_doan: 'chan_doan', pp_dieutri: 'pp_dieutri', ghi_chu: 'ghi_chu',
  nguoi_dai_dien: 'nguoi_dai_dien',
};
const GRV_TEXTS = {
  tu_ngay: 'tu_ngay', den_ngay: 'den_ngay', ngay_ct: 'ngay_ct',
  ngoaitru_tungay: 'ngoaitru_tungay', ngoaitru_denngay: 'ngoaitru_denngay',
};

// Kế hoạch điền một hồ sơ: trang form, tên form chờ, các bước đặt giá trị, hàm lưu.
// Dùng chung cho Điền thử (save=false) và Nhập thật (save=true).
export function buildFillPlan(docType, fields) {
  const f = fields || {};
  const ops = [];
  const pushValues = (map, method) => {
    for (const [field, control] of Object.entries(map)) {
      const v = String(f[field] ?? '').trim();
      if (v) ops.push({ op: method, name: control, value: v });
    }
  };
  const pushCard = () => {
    const parts = cardParts(f.ma_the);
    if (parts) parts.forEach((p, i) => ops.push({ op: 'value', name: `ma_theSub${i + 1}`, value: p }));
  };
  const combo = (name, value, required = true) => {
    const v = String(value ?? '').trim();
    if (!v) {
      if (required) throw new Error(`Thiếu giá trị cho danh sách ${name}.`);
      return;
    }
    ops.push({ op: 'combo', name, value: v });
  };

  if (docType === DOC_BHXH) {
    pushValues(BHXH_VALUES, 'value');
    pushValues(BHXH_TEXTS, 'text');
    pushCard();
    combo('gioi_tinh', f.gioi_tinh);
    combo('bs_id', f.doctor_text);
    return { path: '/PhuLuc07/CreateNew', form: 'frmCreatenew07', save: 'SavePhuLuc7', ops };
  }
  if (docType === DOC_GRV) {
    pushValues(GRV_VALUES, 'value');
    pushValues(GRV_TEXTS, 'text');
    pushCard();
    combo('gioi_tinh', f.gioi_tinh);
    combo('ma_khoa', f.ma_khoa);
    combo('dan_toc', f.dan_toc);
    combo('loai_giay_to', f.loai_giay_to || 'Không có giấy tờ');
    combo('bs_id', f.doctor_text);
    ops.push({ op: 'check', name: 'dc_thainghen', value: ['1', 'true', 'co', 'có', 'yes', 'x'].includes(String(f.dc_thainghen || '').trim().toLowerCase()) });
    return { path: '/PhuLuc3/CreateNew', form: 'frmCreatenew03', save: 'SavePhuLuc3', ops };
  }
  throw new Error(`Loại hồ sơ không hỗ trợ: ${docType}`);
}

// Danh sách hồ sơ để nhập: từ danh sách BHXH đã nhập ở tab Nghỉ ốm (đã có key trạng thái), bỏ ca
// "cần sửa" và ca đã tick "Đã nộp", chỉ giữ bác sĩ của khoa. Số liệu bổ sung tay (vd. Số KCB) lưu
// trong trạng thái nghỉ ốm (entry.bhyt_fields) nên không mất khi tải lại.
export function buildPortalRecords({ outpatient = [], inpatient = [], entries = {}, doctors = [], hasIssue = () => false }) {
  const allowed = new Set(doctors.map(normalizeDoctor).filter(Boolean));
  const records = [];
  const stats = { flagged: 0, submitted: 0, other_doctor: 0 };
  const add = (row, docType, mapFn) => {
    const entry = entries[row.key] || {};
    if (entry.submitted) { stats.submitted += 1; return; }
    if (hasIssue(row)) { stats.flagged += 1; return; }
    const base = mapFn(row);
    const fields = { ...base, ...(entry.bhyt_fields || {}) };
    if (allowed.size && !allowed.has(normalizeDoctor(fields.doctor_text))) { stats.other_doctor += 1; return; }
    records.push({
      key: row.key,
      doc_type: docType,
      patient_name: fields.ho_ten,
      doctor_name: fields.doctor_text,
      fields,
      missing: missingFields(docType, fields),
      // Ô thiếu trong dữ liệu BHXH: giữ ô nhập kể cả khi đã bổ sung, để sửa lại được.
      editable: missingFields(docType, base),
      status: entry.bhyt_status || '',
      message: entry.bhyt_message || '',
    });
  };
  for (const row of outpatient) add(row, DOC_BHXH, mapOutpatientRow);
  for (const row of inpatient) add(row, DOC_GRV, mapInpatientRow);
  return { records, stats };
}

// ── Nút dấu trang "Nhập BHYT" (chạy TRONG tab Cổng BHYT) ───────────────────────────────────────
// Không có ký tự phần trăm trong mã (trình duyệt giải mã %XX trong javascript:).
export function portalBookmarkletSource(hubOrigin) {
  const H = JSON.stringify(String(hubOrigin || '').replace(/\/+$/, ''));
  return `(function(){var H=${H};
if(!/(^|\\.)gdbhyt\\.baohiemxahoi\\.gov\\.vn$/.test(location.hostname)){alert('Bấm nút này trên tab Cổng BHYT (gdbhyt.baohiemxahoi.gov.vn) sau khi đăng nhập, không phải trên Data Hub.');return}
var O=window.opener;
if(!O||O.closed){alert('Tab này không được mở từ Data Hub. Vào Data Hub, tab Nghỉ ốm, bấm "Mở cổng BHYT", đăng nhập trên tab đó rồi bấm lại nút Nhập BHYT.');return}
function logged(d){d=d||document;var form=!!d.getElementById('login1')||(!!d.getElementById('username')&&!!d.getElementById('password'));var out=!!d.querySelector('a[href*="/Account/LogOff"],a[href*="/Account/Logout"],a[href*="DangXuat"]');return out||(!form&&!/\\/Account\\/(Index|Login)?\\/?$/i.test(location.pathname))}
function hi(){try{O.postMessage({type:'bhyt-hello',url:location.href,logged_in:logged()},H)}catch(_){}}
function wait(fn,ms,msg){return new Promise(function(ok,no){var t0=Date.now();(function go(){var v;try{v=fn()}catch(_){v=null}if(v)return ok(v);if(Date.now()-t0>ms)return no(new Error(msg));setTimeout(go,300)})()})}
function box(){var f=document.getElementById('__bhytFrame');if(f)return f;var w=document.createElement('div');w.id='__bhytWrap';w.style.cssText='position:fixed;inset:0;z-index:2147483000;background:#fff;display:flex;flex-direction:column';var b=document.createElement('div');b.style.cssText='padding:8px 12px;background:#e8f0fe;font:14px sans-serif;display:flex;gap:12px;align-items:center';b.innerHTML='<b>Data Hub đang điền hồ sơ</b><span id="__bhytMsg"></span>';var c=document.createElement('button');c.textContent='Đóng khung';c.style.marginLeft='auto';c.onclick=function(){w.style.display='none'};b.appendChild(c);f=document.createElement('iframe');f.id='__bhytFrame';f.style.cssText='flex:1;border:0;align-self:stretch';w.appendChild(b);w.appendChild(f);document.body.appendChild(w);return f}
function say(t){var s=document.getElementById('__bhytMsg');if(s)s.textContent=t}
function norm(v){var p=String(v==null?'':v).normalize('NFD').replace(/[\\u0300-\\u036f]/g,'').replace(/Đ/g,'D').replace(/đ/g,'d').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim().split(' ');var x={ths:1,th:1,ts:1,bs:1,cki:1,ckii:1,bscki:1,bsckii:1};while(p.length&&x[p[0]])p.shift();return p.join(' ')}
function ready(w){var d=w.document;if(d.readyState!=='complete')return false;if(w.jQuery&&w.jQuery.active)return false;var ps=d.querySelectorAll('.dxlp-loadingPanel,.dx-loading-panel,[id$="_LP"]');for(var i=0;i<ps.length;i++){var s=w.getComputedStyle(ps[i]);if(s.display!=='none'&&s.visibility!=='hidden'&&ps[i].offsetParent!==null)return false}return true}
function open(p){var f=box();document.getElementById('__bhytWrap').style.display='flex';return new Promise(function(ok,no){var t=setTimeout(function(){no(new Error('Cổng BHYT không mở được form sau 40 giây.'))},40000);f.onload=function(){clearTimeout(t);var w;try{w=f.contentWindow;w.document.body}catch(_){return no(new Error('Cổng BHYT không cho mở form trong khung trên trang này. Báo lại để chuyển sang cách mở cửa sổ riêng.'))}ok(w)};f.src=p+(p.indexOf('?')<0?'?':'&')+'_dh='+Date.now()})}
function ctl(w,n){return wait(function(){return w[n]},40000,'Không thấy ô '+n+' trên form cổng BHYT.')}
function step(w,o){return ctl(w,o.name).then(function(c){if(o.op==='check'){c.SetChecked(!!o.value);return}if(o.op==='combo'){var n=typeof c.GetItemCount==='function'?c.GetItemCount():0,it=[],k=norm(o.value);for(var i=0;i<n;i++){var g=c.GetItem(i),t='';if(g){t=g.texts&&g.texts.length?Array.prototype.join.call(g.texts,' '):String(g.text==null?'':g.text)}it.push({i:i,t:t,n:norm(t)})}var m=it.filter(function(a){return a.n===k});if(!m.length)m=it.filter(function(a){return k&&a.n.indexOf(k)>=0});if(!m.length)m=it.filter(function(a){return a.n&&k.indexOf(a.n)>=0});if(!m.length)throw new Error('Không tìm thấy "'+o.value+'" trong danh sách '+o.name+'. Ví dụ có: '+it.slice(0,5).map(function(a){return a.t}).join(', '));c.SetSelectedIndex(m[0].i);if(typeof c.RaiseSelectedIndexChanged==='function')c.RaiseSelectedIndexChanged();return}var f=o.op==='text'?'SetText':'SetValue';if(typeof c[f]!=='function')throw new Error('Ô '+o.name+' không nhận '+f+'.');c[f](String(o.value));if(typeof c.RaiseValueChangedEvent==='function')c.RaiseValueChangedEvent()})}
function save(w,fn){var u=w.location.href;if(typeof w[fn]!=='function')throw new Error('Không thấy nút lưu '+fn+' trên form cổng BHYT.');w[fn](false);return wait(function(){var e=w.document.getElementById('MessAlert'),pp=w.document.getElementById('popupAlertMessage_PW-1');if(e&&(!pp||(w.getComputedStyle(pp).display!=='none'&&w.getComputedStyle(pp).visibility!=='hidden'))){var t=(e.innerText||e.textContent||'').trim();if(t)return {msg:t}}if(w.location.href!==u||w.location.href.indexOf('/CreateNew')<0)return {done:1};return null},40000,'Đã bấm Lưu nhưng không rõ kết quả sau 40 giây. Kiểm tra trực tiếp trên cổng BHYT trước khi nhập lại hồ sơ này.').then(function(r){if(r.msg)throw new Error(r.msg);return 'Đã lưu lên cổng BHYT.'})}
function run(m){var p=m.plan;say((m.save?'Nhập thật: ':'Điền thử: ')+(m.name||''));return open(p.path).then(function(w){if(/\\/Account\\//i.test(w.location.pathname)||!logged(w.document))throw new Error('Phiên đăng nhập cổng BHYT đã hết. Đăng nhập lại trên tab cổng rồi bấm lại nút Nhập BHYT.');return wait(function(){return w.document.getElementById(p.form)&&ready(w)},40000,'Form cổng BHYT chưa sẵn sàng sau 40 giây.').then(function(){var q=Promise.resolve();p.ops.forEach(function(o){q=q.then(function(){return step(w,o)})});return q}).then(function(){return wait(function(){return ready(w)},40000,'Cổng BHYT chưa xử lý xong sau khi điền.')}).then(function(){if(!m.save){say('Điền thử xong, chưa bấm Lưu. Kiểm tra từng ô trên form này.');return 'Đã điền thử, chưa bấm Lưu.'}return save(w,p.save).then(function(t){say(t);return t})})})}
if(!window.__bhytOn){window.__bhytOn=1;var busy=0;
window.addEventListener('message',function(e){if(e.origin!==H||e.source!==O)return;var m=e.data||{};if(m.type!=='bhyt-fill')return;var r={type:'bhyt-result',id:m.id};if(busy){r.ok=false;r.message='Tab cổng đang điền hồ sơ khác.';O.postMessage(r,H);return}busy=1;Promise.resolve().then(function(){return run(m)}).then(function(t){r.ok=true;r.message=t},function(err){r.ok=false;r.message=String(err&&err.message||err)}).then(function(){busy=0;try{O.postMessage(r,H)}catch(_){}})});
setInterval(hi,5000)}
hi();setTimeout(hi,800)})()`;
}

export function portalBookmarkletUrl(hubOrigin) {
  return `javascript:${portalBookmarkletSource(hubOrigin).replace(/\n/g, '')}`;
}

// ── Phía Data Hub: mở tab cổng, nghe tab cổng chào, gửi lệnh điền từng hồ sơ ──────────────────────
export function createPortalLink({ openWindow, onState, now = () => Date.now(), timeoutMs = 4 * 60 * 1000 } = {}) {
  let portal = null;
  let state = { phase: 'closed', logged_in: false, url: '', last_hello: 0 };
  const pending = new Map();
  let seq = 0;
  const emit = (patch) => { state = { ...state, ...patch }; onState?.(state); };

  return {
    getState: () => state,
    open() {
      if (portal && !portal.closed) { portal.focus?.(); return true; }
      portal = openWindow(`${PORTAL_ORIGIN}/Home`, 'bhyt_portal');
      if (!portal) return false;
      emit({ phase: 'waiting', logged_in: false, last_hello: 0 });
      return true;
    },
    onMessage(e) {
      if (e?.origin !== PORTAL_ORIGIN || !e.source || (portal && e.source !== portal)) return;
      portal = e.source;
      const m = e.data || {};
      if (m.type === 'bhyt-hello') {
        emit({ phase: m.logged_in ? 'ready' : 'logged_out', logged_in: Boolean(m.logged_in), url: String(m.url || ''), last_hello: now() });
      } else if (m.type === 'bhyt-result' && pending.has(m.id)) {
        const p = pending.get(m.id);
        pending.delete(m.id);
        clearTimeout(p.timer);
        if (m.ok) p.resolve(String(m.message || ''));
        else p.reject(new Error(String(m.message || 'Cổng BHYT báo lỗi không rõ.')));
      }
    },
    // Tab cổng chào mỗi 5 giây; quá 15 giây im lặng là mất nối (đóng tab, chuyển trang, đăng xuất).
    tick() {
      if (portal?.closed) { portal = null; emit({ phase: 'closed', logged_in: false }); return; }
      if ((state.phase === 'ready' || state.phase === 'logged_out') && now() - state.last_hello > 15000) emit({ phase: 'lost' });
    },
    fill(record, { save = false } = {}) {
      if (!portal || portal.closed || state.phase !== 'ready') {
        return Promise.reject(new Error('Chưa nối tab Cổng BHYT. Mở cổng, đăng nhập rồi bấm nút Nhập BHYT trên tab cổng.'));
      }
      let plan;
      try { plan = buildFillPlan(record.doc_type, record.fields); } catch (e) { return Promise.reject(e); }
      const id = `f${++seq}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          reject(new Error('Tab cổng BHYT không trả lời. Kiểm tra trên cổng xem hồ sơ đã lưu chưa trước khi nhập lại.'));
        }, timeoutMs);
        pending.set(id, { resolve, reject, timer });
        portal.postMessage({ type: 'bhyt-fill', id, save: Boolean(save), name: record.patient_name || '', plan }, PORTAL_ORIGIN);
      });
    },
  };
}
