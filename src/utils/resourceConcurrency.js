const PROTECTED = new Set([
  '/api/data',
  '/api/nurse-settings',
  '/api/admin-nurse-state',
  '/api/sick-leave-state',
  '/api/sick-leave-import',
  '/api/medication-catalog',
  '/api/routes',
  '/api/vtyt-catalog',
  '/api/vtyt-combos',
  '/api/hchanh/vtyt-draft',
]);

const MUTATION_ALIAS = new Map([
  ['/api/save', '/api/data'],
  ['/api/sick-leave-import/delete-row', '/api/sick-leave-import'],
  ['/api/medication-catalog/assign-ingredient', '/api/medication-catalog'],
  ['/api/routes/custom', '/api/routes'],
]);

const versions = new Map();
let installed = false;

function pathnameOf(input) {
  try {
    if (input instanceof Request) return new URL(input.url, window.location.origin).pathname;
    return new URL(String(input), window.location.origin).pathname;
  } catch {
    return '';
  }
}

function resourceKeyFor(pathname) {
  const exact = MUTATION_ALIAS.get(pathname) || (PROTECTED.has(pathname) ? pathname : '');
  if (exact) return exact;
  if (pathname.startsWith('/api/medication-catalog/')) return '/api/medication-catalog';
  if (pathname.startsWith('/api/vtyt-catalog/')) return '/api/vtyt-catalog';
  if (pathname.startsWith('/api/vtyt-combos/')) return '/api/vtyt-combos';
  return '';
}

function requestMethod(input, init = {}) {
  return String(init.method || (input instanceof Request ? input.method : 'GET') || 'GET').toUpperCase();
}

function withConcurrencyHeaders(input, init, resourceKey, method) {
  if (!resourceKey || method === 'GET' || method === 'HEAD') return { input, init };
  const expected = versions.get(resourceKey) || '';
  const baseHeaders = new Headers(input instanceof Request ? input.headers : undefined);
  const extra = new Headers(init?.headers || undefined);
  for (const [k, v] of extra.entries()) baseHeaders.set(k, v);
  baseHeaders.set('x-client-concurrency', '1');
  if (expected) baseHeaders.set('If-Match', `"${expected}"`);

  if (input instanceof Request) {
    const nextRequest = new Request(input, { ...init, headers: baseHeaders });
    return { input: nextRequest, init: undefined };
  }
  return { input, init: { ...init, headers: baseHeaders } };
}

function captureVersion(response, resourceKey) {
  if (!resourceKey) return;
  const version = response?.headers?.get('x-resource-version') || '';
  if (version) versions.set(resourceKey, version);
}

export function installResourceConcurrencyFetch() {
  if (installed || typeof window === 'undefined' || typeof window.fetch !== 'function') return;
  installed = true;
  const nativeFetch = window.fetch.bind(window);

  window.fetch = async (input, init = {}) => {
    const pathname = pathnameOf(input);
    const key = resourceKeyFor(pathname);
    const method = requestMethod(input, init);
    const prepared = withConcurrencyHeaders(input, init, key, method);
    const response = await nativeFetch(prepared.input, prepared.init);
    captureVersion(response, key);

    if ((response.status === 409 || response.status === 428) && key) {
      window.dispatchEvent(new CustomEvent('emr:resource-conflict', {
        detail: { resource: key, status: response.status },
      }));
    }
    return response;
  };

  // Khi thiết bị khác thay đổi resource, cố ý KHÔNG thay version cache thành bản mới.
  // Version cũ phải được giữ lại để lần lưu kế tiếp bị server trả 409, buộc UI tải lại
  // thay vì âm thầm ghi đè bằng dữ liệu đang hiển thị đã cũ.
  window.addEventListener('emr:server-resource', (event) => {
    const name = String(event?.detail?.resource || '');
    const key = name === 'board' ? '/api/data'
      : name === 'nurse-settings' ? '/api/nurse-settings'
      : name === 'admin-nurse-state' ? '/api/admin-nurse-state'
      : name === 'sick-leave-state' ? '/api/sick-leave-state'
      : name === 'sick-leave-import' ? '/api/sick-leave-import'
      : name === 'medication-catalog' ? '/api/medication-catalog'
      : name === 'routes-custom' ? '/api/routes'
      : name === 'vtyt-catalog' ? '/api/vtyt-catalog'
      : name === 'vtyt-combos' ? '/api/vtyt-combos'
      : name === 'vtyt-draft' ? '/api/hchanh/vtyt-draft'
      : '';
    if (!key) return;
    const current = versions.get(key) || '';
    const incoming = String(event?.detail?.version || '');
    if (current && incoming && current !== incoming) {
      window.dispatchEvent(new CustomEvent('emr:resource-stale', {
        detail: { resource: key, current_version: current, server_version: incoming, actor_name: String(event?.detail?.actor_name || '') },
      }));
    }
  });
}

export function getKnownResourceVersion(pathname) {
  return versions.get(resourceKeyFor(pathname)) || '';
}

export function clearKnownResourceVersion(pathname) {
  const key = resourceKeyFor(pathname);
  if (key) versions.delete(key);
}

export { resourceKeyFor };
