// Nút dấu trang "Data Hub" — chạy TRONG tab EMR (máy bệnh viện).
//
// Bấm nút: mở trang cầu nối của Data Hub (/emr-bridge) và nghe yêu cầu từ trang đó qua postMessage.
// Mỗi yêu cầu là một đường dẫn CÙNG NGUỒN với EMR; tab EMR tự fetch() bằng phiên đăng nhập sẵn có
// rồi trả nội dung về. Chỉ nhận tin từ đúng cửa sổ Data Hub đã mở (kiểm nguồn + cửa sổ gửi), và tự
// chặn mọi địa chỉ khác nguồn EMR. Không có '%' trong mã (trình duyệt giải mã %XX trong javascript:).

export function bridgeBookmarkletSource(hubOrigin) {
  const H = JSON.stringify(String(hubOrigin || '').replace(/\/+$/, ''));
  return `(function(){var H=${H};
if(location.origin===H){alert('Bấm nút này trên tab EMR (sau khi đăng nhập EMR), không phải trên Data Hub.');return}
var W=window.__emrBridgeWin;if(W&&!W.closed){W.focus();return}
W=window.open(H+'/emr-bridge','emr_bridge');
if(!W){alert('Trình duyệt chặn cửa sổ mới. Cho phép cửa sổ bật lên cho trang EMR rồi bấm lại nút Data Hub.');return}
window.__emrBridgeWin=W;
function hi(){try{window.__emrBridgeWin.postMessage({type:'emr-hello',origin:location.origin,url:location.href},H)}catch(_){}}
if(!window.__emrBridgeOn){window.__emrBridgeOn=1;
window.addEventListener('message',function(e){
if(e.origin!==H||e.source!==window.__emrBridgeWin)return;
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
.then(function(){try{window.__emrBridgeWin.postMessage(r,H)}catch(_){}})
});
setInterval(hi,5000)}
hi();setTimeout(hi,800);setTimeout(hi,2500)})()`;
}

export function bridgeBookmarkletUrl(hubOrigin) {
  return `javascript:${bridgeBookmarkletSource(hubOrigin).replace(/\n/g, '')}`;
}

// Trang EMR trả về màn đăng nhập = phiên EMR đã hết.
export function looksLikeEmrLogin(html) {
  const low = String(html || '').toLowerCase();
  return /type=["']password["']/.test(low) || low.includes('txtloginname') || low.includes('txtpassword');
}
