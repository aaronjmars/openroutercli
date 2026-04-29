import { resolveAuth } from './config.js';

export class APIError extends Error {
  constructor(message, { status, body } = {}) {
    super(message);
    this.name = 'APIError';
    this.status = status;
    this.body = body;
    this.exitCode = 2;
  }
}

function buildHeaders({ apiKey, referer, title, extra }) {
  const headers = {
    Accept: 'application/json',
    'HTTP-Referer': referer,
    'X-Title': title
  };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  return { ...headers, ...(extra || {}) };
}

function joinUrl(base, path) {
  if (/^https?:\/\//i.test(path)) return path;
  return base.replace(/\/$/, '') + (path.startsWith('/') ? path : '/' + path);
}

async function parseError(res) {
  const text = await res.text();
  let body = text;
  try {
    body = JSON.parse(text);
  } catch {}
  const message =
    (body && body.error && body.error.message) ||
    (typeof body === 'string' ? body : `HTTP ${res.status}`);
  throw new APIError(`${res.status} ${res.statusText}: ${message}`, {
    status: res.status,
    body
  });
}

export async function api(method, path, opts = {}) {
  const authOpts = { ...(opts.auth || {}) };
  if (opts.requiresManagement) authOpts.requiresManagement = true;
  const auth = await resolveAuth(authOpts);
  if (opts.requireAuth !== false && !auth.apiKey) {
    const msg = opts.requiresManagement
      ? 'No API key set. This command needs a management key. Run `openrouter login --management` or set OPENROUTER_MANAGEMENT_KEY.'
      : 'No API key set. Run `openrouter login` or `openrouter login --key sk-or-...`, or set OPENROUTER_API_KEY.';
    const e = new Error(msg);
    e.exitCode = 3;
    throw e;
  }

  const url = joinUrl(auth.baseUrl, path) + (opts.query ? '?' + new URLSearchParams(opts.query).toString() : '');
  const headers = buildHeaders({
    apiKey: auth.apiKey,
    referer: auth.referer,
    title: auth.title,
    extra: opts.headers
  });

  let body;
  if (opts.body !== undefined) {
    if (opts.body instanceof Uint8Array || typeof opts.body === 'string') {
      body = opts.body;
    } else {
      body = JSON.stringify(opts.body);
      headers['Content-Type'] = 'application/json';
    }
  }

  const res = await fetch(url, {
    method: method.toUpperCase(),
    headers,
    body,
    signal: opts.signal
  });

  if (!res.ok) await parseError(res);

  if (opts.raw) return res;
  if (opts.binary) return new Uint8Array(await res.arrayBuffer());

  const text = await res.text();
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export async function* sseStream(res) {
  if (!res.body) return;
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf8');
  let buffer = '';
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) !== -1) {
      const line = buffer.slice(0, idx).replace(/\r$/, '');
      buffer = buffer.slice(idx + 1);
      if (!line) continue;
      if (line.startsWith(':')) continue; // SSE comment / keepalive
      if (line.startsWith('data:')) {
        const data = line.slice(5).trim();
        if (data === '[DONE]') return;
        try {
          yield JSON.parse(data);
        } catch {
          // ignore malformed chunk
        }
      }
    }
  }
}
