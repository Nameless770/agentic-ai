'use strict';

// Shared pieces for talking to AI services: one error type with a code the
// chat window understands, a fetch wrapper with timeouts, and readers for
// streamed replies (server-sent events and JSON lines).

class ProviderError extends Error {
  /**
   * code is one of:
   *   DOWN (can't connect), TIMEOUT, AUTH (key rejected), QUOTA (no credit),
   *   RATE (too many requests), OVERLOADED (service busy), NOT_FOUND (no such model),
   *   CONTEXT (too long), NO_VISION / NO_TOOLS / NO_THINK (the model can't take
   *   images / tools / the reasoning setting), REFUSAL, LOGIN (Claude Code sign-in),
   *   LIMIT (subscription usage limit), NO_MODEL, or '' for anything else.
   */
  constructor(message, { status = 0, code = '', provider = '', retryAfter = 0 } = {}) {
    super(message);
    this.name = 'ProviderError';
    this.status = status;
    this.code = code;
    this.provider = provider;
    this.retryAfter = retryAfter;
  }
}

function abortError() {
  return Object.assign(new Error('Stopped'), { name: 'AbortError' });
}

function sleepOrAbort(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal && signal.aborted) return reject(abortError());
    const t = setTimeout(() => {
      if (signal) signal.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(abortError());
    };
    if (signal) signal.addEventListener('abort', onAbort, { once: true });
  });
}

/** Seconds from a Retry-After header (0 if missing or unreadable). */
function retryAfterSeconds(res) {
  const v = res && res.headers && res.headers.get('retry-after');
  if (!v) return 0;
  const n = Number(v);
  if (Number.isFinite(n)) return Math.max(0, n);
  const at = Date.parse(v);
  return Number.isFinite(at) ? Math.max(0, (at - Date.now()) / 1000) : 0;
}

/** The message inside an error body, whatever shape the service uses. */
function errorText(body) {
  if (!body) return '';
  if (typeof body === 'string') {
    try {
      return errorText(JSON.parse(body)) || body.slice(0, 500);
    } catch {
      return body.slice(0, 500);
    }
  }
  if (Array.isArray(body)) return errorText(body[0]);
  const e = body.error !== undefined ? body.error : body;
  if (typeof e === 'string') return e;
  if (e && typeof e === 'object') {
    const msg = e.message || e.msg || e.detail || e.error || '';
    const extra = e.metadata && e.metadata.raw ? ` (${String(e.metadata.raw).slice(0, 300)})` : '';
    if (msg) return String(typeof msg === 'object' ? JSON.stringify(msg) : msg) + extra;
  }
  if (body.message) return String(body.message);
  if (body.detail) return typeof body.detail === 'string' ? body.detail : JSON.stringify(body.detail).slice(0, 500);
  return JSON.stringify(body).slice(0, 500);
}

/**
 * Sort an error reply into a code. `sent` says what the request carried, so
 * that "this model doesn't take images" is only blamed on images when there
 * were some.
 */
function classify(status, message, { provider = '', sent = {}, retryAfter = 0 } = {}) {
  const m = String(message || '');
  const opts = { status, provider, retryAfter };
  let code = '';
  if (status === 401 || status === 403 || /invalid.{0,20}(api[ _-]?key|token|credential)|incorrect api key|unauthori[sz]ed|authentication|permission denied|no auth credentials/i.test(m)) code = 'AUTH';
  if (status === 402 || /credit|balance (is )?too low|billing|insufficient[_ ]quota|exceeded your current quota|payment required|add funds|top up/i.test(m)) code = 'QUOTA';
  else if (status === 429 || /rate.?limit|too many requests|resource.?exhausted/i.test(m)) code = code || 'RATE';
  if (!code && (status === 529 || status === 503 || status === 502 || /overloaded|temporarily unavailable|server is busy|try again later/i.test(m))) code = 'OVERLOADED';
  if (!code && (status === 400 || status === 404 || status === 415 || status === 422 || status === 500)) {
    if (sent.images && /image|vision|multimodal|multi-modal|image_url|picture|content.?type|unsupported (content|input)|only (supports )?text|does not support (this )?input/i.test(m)) code = 'NO_VISION';
    else if (sent.tools && /\btools?\b|function[_ ]?call|function calling/i.test(m) && /support|allow|enable|invalid|unknown|unrecognized|not available/i.test(m)) code = 'NO_TOOLS';
    else if (sent.think && /reasoning|thinking|effort|budget_tokens|output_config/i.test(m)) code = 'NO_THINK';
    else if (/context (length|window)|too long|too many tokens|maximum (context|prompt)|token limit|exceeds the (maximum|context)|prompt is too long|request too large/i.test(m)) code = 'CONTEXT';
    else if (status === 404 || /model.{0,40}(not found|does not exist|not available|not supported|is not a valid|unknown|no access|decommissioned|deprecated)|no such model|invalid model/i.test(m)) code = 'NOT_FOUND';
  }
  if (!code && status === 413) code = 'CONTEXT';
  if (!code && status >= 500) code = 'OVERLOADED';
  return new ProviderError(m || `HTTP ${status}`, { ...opts, code });
}

/**
 * fetch with a time limit for the reply to start, and a watchdog that gives
 * up when a streamed reply goes quiet. Returns the Response (ok or not).
 */
async function request(url, { method = 'GET', headers, body, signal, timeoutMs = 120000, provider = '' } = {}) {
  const timeout = AbortSignal.timeout(timeoutMs);
  const signals = [signal, timeout].filter(Boolean);
  try {
    return await fetch(url, {
      method,
      headers,
      body: body === undefined ? undefined : typeof body === 'string' ? body : JSON.stringify(body),
      signal: signals.length > 1 ? AbortSignal.any(signals) : signals[0],
    });
  } catch (err) {
    if (signal && signal.aborted) throw abortError();
    if (timeout.aborted || (err && err.name === 'TimeoutError')) {
      throw new ProviderError(`${provider || 'The service'} didn't answer in time.`, { code: 'TIMEOUT', provider });
    }
    let host = url;
    try {
      host = new URL(url).host;
    } catch {
      // keep the raw url
    }
    throw new ProviderError(`Can't reach ${host}.`, { code: 'DOWN', provider });
  }
}

/** Read an error reply and turn it into a ProviderError. */
async function failure(res, { provider = '', sent = {} } = {}) {
  let text = '';
  try {
    text = await res.text();
  } catch {
    // no body
  }
  return classify(res.status, errorText(text) || `HTTP ${res.status}`, { provider, sent, retryAfter: retryAfterSeconds(res) });
}

/** GET/POST that expects JSON back. */
async function requestJson(url, opts = {}) {
  const res = await request(url, opts);
  if (!res.ok) throw await failure(res, opts);
  try {
    return await res.json();
  } catch {
    throw new ProviderError(`${opts.provider || 'The service'} sent a reply that isn't JSON.`, { provider: opts.provider });
  }
}

/**
 * Stream a response body, aborting if nothing arrives for `idleMs`.
 * Yields decoded text chunks.
 */
async function* readText(res, { signal, idleMs = 120000, provider = '' } = {}) {
  const decoder = new TextDecoder();
  const reader = res.body.getReader();
  let timer = null;
  let idle = false;
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      idle = true;
      reader.cancel().catch(() => {});
    }, idleMs);
  };
  const onAbort = () => reader.cancel().catch(() => {});
  if (signal) signal.addEventListener('abort', onAbort, { once: true });
  try {
    arm();
    for (;;) {
      const { value, done } = await reader.read();
      if (signal && signal.aborted) throw abortError();
      if (idle) throw new ProviderError(`${provider || 'The service'} stopped sending the reply.`, { code: 'TIMEOUT', provider });
      if (done) break;
      arm();
      yield decoder.decode(value, { stream: true });
    }
    const rest = decoder.decode();
    if (rest) yield rest;
  } finally {
    clearTimeout(timer);
    if (signal) signal.removeEventListener('abort', onAbort);
  }
}

/** Server-sent events: yields { event, data } (data as a string). */
async function* readSSE(res, opts) {
  let buf = '';
  let event = '';
  let data = [];
  const flush = function* () {
    if (data.length) yield { event: event || 'message', data: data.join('\n') };
    event = '';
    data = [];
  };
  for await (const chunk of readText(res, opts)) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      let line = buf.slice(0, nl);
      buf = buf.slice(nl + 1);
      if (line.endsWith('\r')) line = line.slice(0, -1);
      if (line === '') {
        yield* flush();
        continue;
      }
      if (line[0] === ':') continue; // comment / keep-alive
      const colon = line.indexOf(':');
      const field = colon === -1 ? line : line.slice(0, colon);
      let value = colon === -1 ? '' : line.slice(colon + 1);
      if (value[0] === ' ') value = value.slice(1);
      if (field === 'data') data.push(value);
      else if (field === 'event') event = value;
    }
  }
  if (buf.trim()) {
    const line = buf.trim();
    if (line.startsWith('data:')) data.push(line.slice(5).trim());
  }
  yield* flush();
}

/** One JSON object per line (Ollama). */
async function* readJsonLines(res, opts) {
  let buf = '';
  for await (const chunk of readText(res, opts)) {
    buf += chunk;
    let nl;
    while ((nl = buf.indexOf('\n')) !== -1) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (line) yield JSON.parse(line);
    }
  }
  if (buf.trim()) yield JSON.parse(buf);
}

function parseArgs(args) {
  if (args && typeof args === 'object') return args;
  if (typeof args !== 'string' || !args.trim()) return {};
  try {
    const v = JSON.parse(args);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

let idSeq = 0;
/** A tool-call id for services that don't give one (9 letters and digits: valid everywhere). */
function newCallId() {
  idSeq = (idSeq + 1) % 1e7;
  return `c${Date.now().toString(36).slice(-4)}${String(idSeq).padStart(4, '0')}`.slice(0, 9).padEnd(9, '0');
}

module.exports = {
  ProviderError,
  abortError,
  sleepOrAbort,
  classify,
  errorText,
  request,
  requestJson,
  failure,
  readText,
  readSSE,
  readJsonLines,
  parseArgs,
  newCallId,
  retryAfterSeconds,
};
