'use strict';

// What the model can do besides talking: the tool definitions sent to Ollama,
// checks on the arguments it sends back, and plain-language labels for the
// chat window. Nothing here touches the PC; main.js carries the actions out.

const { parseKeys } = require('./input');

const DOC_FORMATS = ['docx', 'pdf', 'md', 'txt', 'html'];
const FORMAT_ALIASES = { word: 'docx', doc: 'docx', markdown: 'md', text: 'txt', htm: 'html' };
const MAX_TYPE_CHARS = 2000;

const fn = (name, description, properties, required) => ({
  type: 'function',
  function: { name, description, parameters: { type: 'object', properties, required } },
});

// Qwen-style vision models answer in a 0-1000 grid whatever they are told,
// so that is the grid we ask for.
const position = (axis) => ({
  type: 'number',
  description:
    axis === 'x'
      ? 'Horizontal position on the latest screenshot, from 0 (left edge) to 1000 (right edge).'
      : 'Vertical position on the latest screenshot, from 0 (top edge) to 1000 (bottom edge).',
});

const DOCUMENT_TOOLS = [
  fn(
    'create_document',
    "Write a document straight into a file (Word, PDF and more) in the user's Documents\\Claude Buddy folder; no need to open Word. Use it when the user asks you to write, make, export or save a document, report, letter, essay, summary, plan or notes.",
    {
      title: { type: 'string', description: 'Short title, also used as the file name.' },
      format: {
        type: 'string',
        enum: DOC_FORMATS,
        description: 'docx (Word), pdf, md (Markdown), txt (plain text) or html (web page). Use docx unless the user asked for another.',
      },
      content: {
        type: 'string',
        description: 'The complete document in Markdown: # headings, paragraphs, - bullet lists, 1. numbered lists, | tables |.',
      },
    },
    ['title', 'format', 'content'],
  ),
];

const CONTROL_TOOLS = [
  fn(
    'click',
    'Click a point on the screen. To type into a box, click the box first.',
    {
      x: position('x'),
      y: position('y'),
      target: { type: 'string', description: 'What you are clicking, in a few words, e.g. "the Save button".' },
      button: { type: 'string', enum: ['left', 'right'], description: 'Mouse button. Default left.' },
      double: { type: 'boolean', description: 'true to double-click.' },
    },
    ['x', 'y', 'target'],
  ),
  fn(
    'type_text',
    'Type text into a text box. Give x and y of the box: it is clicked first so the text goes into it. Set clear to true to replace what the box already contains. Use \\n for a new line.',
    {
      text: { type: 'string', description: 'The text to type.' },
      x: position('x'),
      y: position('y'),
      target: { type: 'string', description: 'Which box, in a few words, e.g. "the Name box".' },
      clear: { type: 'boolean', description: 'true to replace the text that is already in the box.' },
    },
    ['text', 'x', 'y'],
  ),
  fn(
    'press_keys',
    'Press a key or a keyboard shortcut, for example "enter", "tab", "esc", "ctrl+s", "ctrl+c", "alt+tab" or "win".',
    { keys: { type: 'string', description: 'Key names joined with +.' } },
    ['keys'],
  ),
  fn(
    'scroll',
    'Scroll with the mouse wheel over a point on the screen.',
    {
      x: position('x'),
      y: position('y'),
      direction: { type: 'string', enum: ['up', 'down'] },
      amount: { type: 'number', description: 'Wheel steps, 1 to 10. Default 5.' },
    },
    ['x', 'y', 'direction'],
  ),
  fn(
    'open_app',
    'Open an app by its name through the Start menu search, e.g. "Notepad", "Calculator", "File Explorer". Not for writing documents: create_document makes those directly.',
    { name: { type: 'string', description: 'The app name.' } },
    ['name'],
  ),
  fn('open_url', 'Open a web page in the default browser.', { url: { type: 'string', description: 'Full address starting with https://' } }, ['url']),
  fn(
    'wait',
    'Wait for something to load before looking at the screen again.',
    { seconds: { type: 'number', description: '1 to 10.' } },
    ['seconds'],
  ),
];

function argsOf(call) {
  let args = (call && call.function && call.function.arguments) || {};
  if (typeof args === 'string') {
    try {
      args = JSON.parse(args);
    } catch {
      args = {};
    }
  }
  return args && typeof args === 'object' ? args : {};
}

function coord(v) {
  const n = Number(v);
  return Number.isFinite(n) ? Math.min(1000, Math.max(0, n)) : NaN;
}

function short(text, max) {
  const s = String(text).replace(/\s+/g, ' ').trim();
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

/** "Study_Plan.docx" -> "Study Plan" */
function cleanTitle(title) {
  let s = String(title || '').trim().replace(/\.(docx?|pdf|md|txt|html?)$/i, '');
  if (!/\s/.test(s)) s = s.replace(/[_]+/g, ' ');
  return s.trim() || 'Document';
}

/**
 * Check a tool call from the model.
 * Returns { ok: true, action } or { ok: false, error } (the error goes back to the model).
 * action: { kind, label, ... } where kind is document | click | type | keys | scroll | open_app | open_url | wait.
 */
function parseCall(call) {
  const name = call && call.function && call.function.name;
  const args = argsOf(call);
  switch (name) {
    case 'create_document': {
      const content = String(args.content || '').trim();
      if (!content) return { ok: false, error: 'content was empty. Put the whole document in content, in Markdown.' };
      let format = String(args.format || 'docx').toLowerCase().trim().replace(/^\./, '');
      format = FORMAT_ALIASES[format] || format;
      if (!DOC_FORMATS.includes(format)) return { ok: false, error: `format must be one of ${DOC_FORMATS.join(', ')}.` };
      const title = cleanTitle(args.title);
      return { ok: true, action: { kind: 'document', title, format, content, label: `Create “${short(title, 50)}.${format}”` } };
    }
    case 'click': {
      const x = coord(args.x);
      const y = coord(args.y);
      if (Number.isNaN(x) || Number.isNaN(y)) return { ok: false, error: 'x and y must be numbers from 0 to 1000.' };
      const button = String(args.button || '').toLowerCase() === 'right' ? 'right' : 'left';
      const double = args.double === true || String(args.double).toLowerCase() === 'true';
      const target = short(args.target || 'that spot', 60);
      const verb = double ? 'Double-click' : button === 'right' ? 'Right-click' : 'Click';
      return { ok: true, action: { kind: 'click', x, y, button, double, label: `${verb} ${target}` } };
    }
    case 'type_text': {
      const text = String(args.text == null ? '' : args.text);
      if (!text) return { ok: false, error: 'text was empty.' };
      if (text.length > MAX_TYPE_CHARS) return { ok: false, error: `That is too much to type at once (max ${MAX_TYPE_CHARS} characters). For long text, use create_document.` };
      const x = coord(args.x);
      const y = coord(args.y);
      const at = Number.isNaN(x) || Number.isNaN(y) ? {} : { x, y };
      const clear = args.clear === true || String(args.clear).toLowerCase() === 'true';
      const where = args.target ? short(args.target, 40) : '';
      const label = clear
        ? `Replace the text${where ? ` in ${where}` : ''} with “${short(text, 40)}”`
        : `Type “${short(text, 50)}”${where ? ` into ${where}` : ''}`;
      return { ok: true, action: { kind: 'type', text, clear, ...at, label } };
    }
    case 'press_keys': {
      try {
        const { label } = parseKeys(args.keys);
        return { ok: true, action: { kind: 'keys', keys: String(args.keys), label: `Press ${label}` } };
      } catch (err) {
        return { ok: false, error: `${err.message} Use key names like enter, tab, esc, ctrl+s.` };
      }
    }
    case 'scroll': {
      const x = coord(args.x);
      const y = coord(args.y);
      if (Number.isNaN(x) || Number.isNaN(y)) return { ok: false, error: 'x and y must be numbers from 0 to 1000.' };
      const direction = String(args.direction || 'down').toLowerCase() === 'up' ? 'up' : 'down';
      const amount = Math.round(Math.min(10, Math.max(1, Number(args.amount) || 5)));
      return { ok: true, action: { kind: 'scroll', x, y, direction, amount, label: `Scroll ${direction}` } };
    }
    case 'open_app': {
      const app = short(args.name || '', 60);
      if (!app || /[\r\n]/.test(String(args.name))) return { ok: false, error: 'name must be the app name, e.g. Notepad.' };
      return { ok: true, action: { kind: 'open_app', name: app, label: `Open ${app}` } };
    }
    case 'open_url': {
      let url;
      try {
        url = new URL(String(args.url || '').trim());
      } catch {
        return { ok: false, error: 'url must be a full web address starting with https://' };
      }
      if (url.protocol !== 'https:' && url.protocol !== 'http:') return { ok: false, error: 'Only http and https addresses can be opened.' };
      return { ok: true, action: { kind: 'open_url', url: url.toString(), label: `Open ${short(url.host + url.pathname.replace(/\/$/, ''), 60)}` } };
    }
    case 'wait': {
      const seconds = Math.round(Math.min(10, Math.max(1, Number(args.seconds) || 2)));
      return { ok: true, action: { kind: 'wait', seconds, label: `Wait ${seconds} s` } };
    }
    default:
      return { ok: false, error: `There is no tool called "${name}".` };
  }
}

module.exports = { DOCUMENT_TOOLS, CONTROL_TOOLS, parseCall, cleanTitle, MAX_TYPE_CHARS };
