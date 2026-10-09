// Nút dấu trang "Data Hub" — chạy TRONG tab EMR (máy bệnh viện).
//
// Bấm nút: mở trang cầu nối của Data Hub (/emr-bridge) và nghe yêu cầu từ trang đó qua postMessage.
// Mỗi yêu cầu là một đường dẫn CÙNG NGUỒN với EMR; tab EMR tự fetch() bằng phiên đăng nhập sẵn có
// rồi trả nội dung về. Chỉ nhận tin từ đúng cửa sổ Data Hub đã mở (kiểm nguồn + cửa sổ gửi), và tự
// chặn mọi địa chỉ khác nguồn EMR. Không có '%' trong mã (trình duyệt giải mã %XX trong javascript:).

// helper=true: nút "Góp sức lấy dữ liệu" — mở trang cầu nối ở vai máy góp sức (nhiều máy cùng nối được,
// mỗi người dùng phiên EMR của chính họ). Dùng biến/cửa sổ riêng nên có thể chạy cạnh nút "Data Hub".
export function bridgeBookmarkletSource(hubOrigin, { helper = false } = {}) {
  const H = JSON.stringify(String(hubOrigin || '').replace(/\/+$/, ''));
  const win = helper ? '__emrHelperWin' : '__emrBridgeWin';
  const on = helper ? '__emrHelperOn' : '__emrBridgeOn';
  const page = helper ? '/emr-bridge?vai=gop-suc' : '/emr-bridge';
  const name = helper ? 'emr_helper' : 'emr_bridge';
  const button = helper ? 'Góp sức lấy dữ liệu' : 'Data Hub';
  return `(function(){var H=${H};
if(location.origin===H){alert('Bấm nút này trên tab EMR (sau khi đăng nhập EMR), không phải trên Data Hub.');return}
var W=window.${win};if(W&&!W.closed){W.focus();return}
W=window.open(H+'${page}','${name}');
if(!W){alert('Trình duyệt chặn cửa sổ mới. Cho phép cửa sổ bật lên cho trang EMR rồi bấm lại nút ${button}.');return}
window.${win}=W;
function hi(){try{window.${win}.postMessage({type:'emr-hello',origin:location.origin,url:location.href},H)}catch(_){}}
if(!window.${on}){window.${on}=1;
window.addEventListener('message',function(e){
if(e.origin!==H||e.source!==window.${win})return;
var m=e.data||{};if(m.type!=='emr-fetch')return;
var r={type:'emr-result',id:m.id};
Promise.resolve().then(function(){
var u=new URL(m.path,location.origin);if(u.origin!==location.origin)throw new Error('Khác nguồn EMR');
var h={};var x=m.headers||{};for(var k in x){h[k]=x[k]}
if(m.content_type)h['Content-Type']=m.content_type;
var o={method:m.method||'GET',headers:h,credentials:'include',cache:'no-store'};
if(m.body!=null&&o.method!=='GET')o.body=m.body;
if(m.referrer)o.referrer=new URL(m.referrer,location.origin).href;
return fetch(u.href,o)
}).then(function(x){r.status=x.status;r.url=x.url;return x.text()})
.then(function(t){r.ok=true;r.text=t},function(err){r.ok=false;r.error=String(err&&err.message||err)})
.then(function(){try{window.${win}.postMessage(r,H)}catch(_){}})
});
setInterval(hi,5000)}
hi();setTimeout(hi,800);setTimeout(hi,2500)})()`;
}

export function bridgeBookmarkletUrl(hubOrigin, options = {}) {
  return `javascript:${bridgeBookmarkletSource(hubOrigin, options).replace(/\n/g, '')}`;
}

// Trang EMR trả về màn đăng nhập = phiên EMR đã hết.
export function looksLikeEmrLogin(html) {
  const low = String(html || '').toLowerCase();
  return /type=["']password["']/.test(low) || low.includes('txtloginname') || low.includes('txtpassword');
}
