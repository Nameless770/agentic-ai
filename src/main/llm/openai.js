'use strict';

// Services that speak OpenAI's Chat Completions API: OpenAI itself, Google
// Gemini, OpenRouter, Groq, Mistral, DeepSeek, xAI, Together, and local
// servers such as LM Studio. One request = one streamed reply; the chat loop
// (chat.js) runs the tools in between.

const { ProviderError, request, failure, readSSE, parseArgs, newCallId } = require('./common');

/** Merge streamed pieces of an object (OpenRouter's reasoning details, Gemini's extra fields). */
function mergeInto(target, piece) {
  for (const [k, v] of Object.entries(piece || {})) {
    if (typeof v === 'string' && typeof target[k] === 'string' && (k === 'text' || k === 'summary' || k === 'data' || k === 'arguments')) target[k] += v;
    else if (v && typeof v === 'object' && !Array.isArray(v) && target[k] && typeof target[k] === 'object') mergeInto(target[k], v);
    else if (v !== null && v !== undefined) target[k] = v;
  }
  return target;
}

class OpenAICompatible {
  /**
   * @param conn    { id, preset, name, baseUrl }
   * @param getKey  () => the API key ('' for servers that need none)
   */
  constructor(conn, getKey) {
    this.conn = conn;
    this.getKey = getKey;
    this.key = `openai:${conn.id}`; // whose raw replies can be replayed as-is
  }

  get name() {
    return this.conn.name;
  }

  url(path) {
    return `${String(this.conn.baseUrl).replace(/\/+$/, '')}${path}`;
  }

  headers(json = true) {
    const h = {};
    if (json) h['Content-Type'] = 'application/json';
    const key = this.getKey();
    if (key) h.Authorization = `Bearer ${key}`;
    if (this.conn.preset === 'openrouter') {
      h['X-Title'] = 'Claude Buddy';
      h['HTTP-Referer'] = 'https://claude-buddy.local';
    }
    return h;
  }

  /** The service's model list, as raw entries (providers.js makes sense of them). */
  async listModels() {
    const res = await request(this.url('/models'), { headers: this.headers(false), timeoutMs: 20000, provider: this.name });
    if (!res.ok) throw await failure(res, { provider: this.name });
    const j = await res.json().catch(() => null);
    const list = Array.isArray(j) ? j : j && Array.isArray(j.data) ? j.data : j && Array.isArray(j.models) ? j.models : null;
    if (!list) throw new ProviderError(`${this.name} sent a model list Buddy can't read.`, { provider: this.name });
    return list.filter((m) => m && (m.id || m.name));
  }

  /** The request's messages, from the chat's view of the conversation. */
  buildMessages(system, view) {
    const out = [{ role: 'system', content: system }];
    for (const m of view) {
      if (m.role === 'user') {
        if (m.image) {
          out.push({
            role: 'user',
            content: [
              { type: 'image_url', image_url: { url: `data:image/jpeg;base64,${m.image}` } },
              { type: 'text', text: m.text },
            ],
          });
        } else {
          out.push({ role: 'user', content: m.text });
        }
      } else if (m.role === 'assistant') {
        const own = m.inTurn && m.via === this.key && m.raw;
        const calls = m.toolCalls || [];
        const msg = { role: 'assistant', content: m.text ? m.text : calls.length ? null : '' };
        if (calls.length) {
          msg.tool_calls =
            own && Array.isArray(m.raw.tool_calls) && m.raw.tool_calls.length === calls.length
              ? m.raw.tool_calls
              : calls.map((c) => ({ id: c.id, type: 'function', function: { name: c.name, arguments: JSON.stringify(c.args || {}) } }));
        }
        if (own && m.raw.reasoning_details) msg.reasoning_details = m.raw.reasoning_details;
        out.push(msg);
      } else if (m.role === 'tool') {
        const t = { role: 'tool', tool_call_id: m.callId, content: m.text || 'Done.' };
        if (this.conn.preset === 'mistral') t.name = m.name;
        out.push(t);
      }
    }
    return out;
  }

  /** Extra request fields for the Thinking setting, or null to leave them out. */
  reasoning(model, think) {
    if (!model.canThink || model.thinkParam === false) return null;
    const preset = this.conn.preset;
    const id = String(model.id).toLowerCase();
    if (preset === 'openrouter') return { reasoning: { effort: think ? 'high' : 'low' } };
    if (preset === 'openai' && /^(o\d|gpt-5(?!-chat))/.test(id)) return { reasoning_effort: think ? 'high' : 'low' };
    if (preset === 'gemini' && /gemini-(2\.5|[3-9])/.test(id)) return { reasoning_effort: think ? 'high' : 'low' };
    if (preset === 'xai' && /grok-3-mini/.test(id)) return { reasoning_effort: think ? 'high' : 'low' };
    if (preset === 'custom' && think) return { reasoning_effort: 'high' };
    return null;
  }

  /**
   * One streamed reply.
   * Resolves to { text, thinking, toolCalls: [{ id, name, args }], stop, raw }.
   */
  async step({ model, system, view, tools, think, signal, onThinking, onText }) {
    const body = { model: model.id, messages: this.buildMessages(system, view), stream: true };
    if (tools && tools.length) body.tools = tools;
    const reasoning = this.reasoning(model, think);
    if (reasoning) Object.assign(body, reasoning);
    const sent = { images: view.some((m) => m.image), tools: !!body.tools, think: !!reasoning };

    const res = await request(this.url('/chat/completions'), { method: 'POST', headers: this.headers(), body, signal, timeoutMs: 180000, provider: this.name });
    if (!res.ok) throw await failure(res, { provider: this.name, sent });

    let text = '';
    let thinking = '';
    let stop = '';
    const calls = [];
    let details = null;
    let gotAny = false;
    const type = String(res.headers.get('content-type') || '');

    if (!type.includes('text/event-stream')) {
      // A server that ignored "stream": read the whole reply at once.
      const j = await res.json().catch(() => null);
      if (!j || j.error) throw new ProviderError((j && j.error && (j.error.message || j.error)) || `${this.name} sent an empty reply.`, { provider: this.name });
      const msg = (j.choices && j.choices[0] && j.choices[0].message) || {};
      text = typeof msg.content === 'string' ? msg.content : '';
      thinking = msg.reasoning_content || msg.reasoning || '';
      if (thinking) onThinking(thinking);
      if (text) onText(text);
      for (const c of msg.tool_calls || []) calls.push({ ...c });
      stop = (j.choices && j.choices[0] && j.choices[0].finish_reason) || '';
      gotAny = true;
    } else {
      for await (const ev of readSSE(res, { signal, provider: this.name })) {
        if (ev.data === '[DONE]') break;
        let j;
        try {
          j = JSON.parse(ev.data);
        } catch {
          continue;
        }
        if (j.error) {
          const e = j.error;
          throw new ProviderError(String((e && (e.message || e.error)) || e), { provider: this.name, code: /rate/i.test(JSON.stringify(e)) ? 'RATE' : '' });
        }
        const ch = j.choices && j.choices[0];
        if (!ch) continue;
        gotAny = true;
        const d = ch.delta || ch.message || {};
        let reason = d.reasoning_content || d.reasoning || '';
        let content = '';
        if (typeof d.content === 'string') content = d.content;
        else if (Array.isArray(d.content)) {
          // Mistral's reasoning models send typed parts.
          for (const part of d.content) {
            if (part.type === 'text') content += part.text || '';
            else if (part.type === 'thinking') reason += (part.thinking || []).map((t) => t.text || '').join('');
          }
        }
        if (typeof reason === 'string' && reason) {
          thinking += reason;
          onThinking(reason);
        }
        if (d.refusal) content += d.refusal;
        if (content) {
          text += content;
          onText(content);
        }
        if (Array.isArray(d.reasoning_details)) {
          details = details || [];
          for (const piece of d.reasoning_details) {
            const at = Number.isInteger(piece.index) ? details.findIndex((x) => x.index === piece.index) : -1;
            if (at === -1) details.push({ ...piece });
            else mergeInto(details[at], piece);
          }
        }
        for (const tc of d.tool_calls || []) {
          let at = Number.isInteger(tc.index) ? tc.index : -1;
          if (at === -1 && tc.id) at = calls.findIndex((c) => c && c.id === tc.id);
          if (at === -1) at = calls.length;
          const cur = calls[at] || (calls[at] = { id: '', type: 'function', function: { name: '', arguments: '' } });
          for (const [k, v] of Object.entries(tc)) {
            if (k === 'index') continue;
            if (k === 'function') {
              if (v.name && !cur.function.name.endsWith(v.name)) cur.function.name += v.name;
              if (v.arguments !== undefined && v.arguments !== null) {
                cur.function.arguments += typeof v.arguments === 'string' ? v.arguments : JSON.stringify(v.arguments);
              }
            } else if (k === 'id') {
              if (v) cur.id = v;
            } else if (v && typeof v === 'object' && cur[k] && typeof cur[k] === 'object') mergeInto(cur[k], v);
            else if (v !== null && v !== undefined) cur[k] = v;
          }
        }
        if (ch.finish_reason) stop = ch.finish_reason;
      }
    }
    if (!gotAny) throw new ProviderError(`${this.name} sent an empty reply.`, { provider: this.name });

    const raw = calls.filter((c) => c && c.function && c.function.name);
    for (const c of raw) {
      if (!c.id) c.id = newCallId();
      if (typeof c.function.arguments !== 'string') c.function.arguments = JSON.stringify(c.function.arguments || {});
      if (!c.function.arguments) c.function.arguments = '{}';
    }
    const toolCalls = raw.map((c) => ({ id: c.id, name: c.function.name, args: parseArgs(c.function.arguments) }));
    return {
      text,
      thinking,
      toolCalls,
      stop: stop === 'length' ? 'length' : stop === 'content_filter' ? 'refusal' : toolCalls.length ? 'tool' : 'end',
      raw: { tool_calls: raw, reasoning_details: details || undefined },
    };
  }
}

module.exports = { OpenAICompatible };
