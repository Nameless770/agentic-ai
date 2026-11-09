'use strict';

// Documents the model writes (Word, PDF, Markdown, text, web page), saved in
// Documents\Claude Buddy. The model writes Markdown; this file turns it into
// each format. Right-to-left text (Arabic, Hebrew) is laid out correctly.

const { app, BrowserWindow } = require('electron');
const fs = require('fs');
const path = require('path');
const { Marked } = require('marked');
const docx = require('docx');

const FORMATS = { docx: 'Word document', pdf: 'PDF', md: 'Markdown file', txt: 'text file', html: 'web page' };
const ALIASES = { word: 'docx', doc: 'docx', markdown: 'md', text: 'txt', htm: 'html', web: 'html' };
const RTL_CHAR = /[֐-ࣿיִ-﷿ﹰ-﻿]/;
const LTR_CHAR = /[A-Za-zÀ-ɏͰ-ϿЀ-ӿ]/;
const MAX_CHARS = 200000;

function folder() {
  return path.join(app.getPath('documents'), 'Claude Buddy');
}

/** Right-to-left if the first letter with a direction is Arabic/Hebrew. */
function isRtl(text) {
  for (const ch of String(text || '')) {
    if (RTL_CHAR.test(ch)) return true;
    if (LTR_CHAR.test(ch)) return false;
  }
  return false;
}

function normalizeFormat(format) {
  const f = String(format || 'docx').toLowerCase().trim().replace(/^\./, '');
  return ALIASES[f] || f;
}

function safeName(title) {
  let s = String(title || '')
    .replace(/[<>:"/\\|?*\u0000-\u001f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[. ]+$/, '');
  if (!s) s = 'Document';
  if (/^(con|prn|aux|nul|com\d|lpt\d)$/i.test(s)) s += ' document';
  return s.slice(0, 80).trim();
}

function uniquePath(dir, base, ext) {
  let file = path.join(dir, `${base}.${ext}`);
  for (let n = 2; fs.existsSync(file); n++) file = path.join(dir, `${base} (${n}).${ext}`);
  return file;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
}

function decodeEntities(s) {
  return String(s || '')
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

/** Does the Markdown already start with a top-level heading? */
function startsWithTitle(content) {
  return /^\s*#\s+\S/.test(content);
}

// ------------------------------------------------------------------ HTML / PDF

const markdown = new Marked({ gfm: true, breaks: false });
markdown.use({
  renderer: {
    // Raw HTML from the model is shown as text, never rendered.
    html({ text }) {
      return escapeHtml(text);
    },
    image({ text }) {
      return escapeHtml(text || '');
    },
  },
});

const CSS = `
body { font-family: 'Segoe UI', Calibri, Arial, sans-serif; font-size: 11pt; line-height: 1.55; color: #1f1e1d; margin: 0; }
body.page { max-width: 820px; margin: 40px auto; padding: 0 24px; }
h1 { font-size: 22pt; line-height: 1.2; margin: 0 0 14pt; }
h2 { font-size: 16pt; margin: 18pt 0 8pt; }
h3 { font-size: 13pt; margin: 14pt 0 6pt; }
h4, h5, h6 { font-size: 11.5pt; margin: 12pt 0 4pt; }
p { margin: 0 0 8pt; }
ul, ol { margin: 0 0 8pt; padding-inline-start: 22pt; }
li { margin: 2pt 0; }
table { border-collapse: collapse; width: 100%; margin: 6pt 0 12pt; }
th, td { border: 1px solid #c9c6bc; padding: 5pt 7pt; text-align: start; vertical-align: top; }
th { background: #f1efe7; }
pre { background: #f4f2eb; padding: 8pt 10pt; border-radius: 4pt; white-space: pre-wrap; font: 9.5pt Consolas, 'Courier New', monospace; }
code { font-family: Consolas, 'Courier New', monospace; font-size: 0.92em; background: #f4f2eb; padding: 0 2pt; border-radius: 2pt; }
pre code { background: none; padding: 0; }
blockquote { margin: 0 0 8pt; padding: 2pt 0 2pt 12pt; border-inline-start: 3pt solid #d97757; color: #57564f; }
hr { border: 0; border-top: 1px solid #c9c6bc; margin: 14pt 0; }
a { color: #bd5d3a; }
`;

function toHtml(title, content, { page = false } = {}) {
  // dir="auto": each block (and each list) takes the direction of its own text.
  const body = markdown.parse(content).replace(/<(p|h[1-6]|li|blockquote|td|th|ul|ol)(\s[^>]*)?>/g, '<$1 dir="auto"$2>');
  const dir = isRtl(`${startsWithTitle(content) ? '' : title} ${content}`) ? 'rtl' : 'ltr';
  return (
    `<!doctype html><html dir="${dir}"><head><meta charset="utf-8">` +
    `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; img-src data:">` +
    `<meta name="viewport" content="width=device-width, initial-scale=1"><title>${escapeHtml(title)}</title><style>${CSS}</style></head>` +
    `<body${page ? ' class="page"' : ''}>${startsWithTitle(content) ? '' : `<h1 dir="auto">${escapeHtml(title)}</h1>`}${body}</body></html>`
  );
}

/** Lay the page out in a hidden window (no scripts) and print it to PDF. */
async function writePdf(file, html) {
  const win = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true, contextIsolation: true } });
  win.webContents.on('will-navigate', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  try {
    // From memory rather than a temp file: Windows short paths (C:\Users\NAME~1)
    // can fail to load as file:// URLs.
    await win.loadURL(`data:text/html;charset=utf-8;base64,${Buffer.from(html, 'utf8').toString('base64')}`);
    const pdf = await win.webContents.printToPDF({
      pageSize: 'A4',
      printBackground: true,
      margins: { top: 0.75, bottom: 0.75, left: 0.75, right: 0.75 },
    });
    fs.writeFileSync(file, pdf);
  } finally {
    win.destroy();
  }
}

// ------------------------------------------------------------------ plain text

function plainInline(tokens) {
  return (tokens || [])
    .map((t) => {
      if (t.type === 'link') return `${plainInline(t.tokens)} (${t.href})`;
      if (t.type === 'br') return '\n';
      if (t.tokens) return plainInline(t.tokens);
      return decodeEntities(t.text || '');
    })
    .join('');
}

function plainBlocks(tokens, indent = '') {
  const out = [];
  for (const t of tokens) {
    if (t.type === 'heading') out.push(`${plainInline(t.tokens)}\n${t.depth <= 2 ? '='.repeat(Math.min(60, t.text.length)) : ''}`.trimEnd());
    else if (t.type === 'paragraph' || t.type === 'text') out.push(indent + plainInline(t.tokens || [{ text: t.text }]));
    else if (t.type === 'list') {
      t.items.forEach((item, i) => {
        const mark = t.ordered ? `${(t.start || 1) + i}.` : '•';
        const [first, ...rest] = plainBlocks(item.tokens, '').join('\n').split('\n');
        out.push([`${indent}${mark} ${first}`, ...rest.map((l) => `${indent}   ${l}`)].join('\n'));
      });
    } else if (t.type === 'code') out.push(t.text.split('\n').map((l) => `    ${l}`).join('\n'));
    else if (t.type === 'blockquote') out.push(plainBlocks(t.tokens).map((b) => b.replace(/^/gm, '> ')).join('\n\n'));
    else if (t.type === 'table') {
      const row = (cells) => cells.map((c) => plainInline(c.tokens)).join('\t');
      out.push([row(t.header), ...t.rows.map(row)].join('\n'));
    } else if (t.type === 'hr') out.push('-'.repeat(40));
  }
  return out;
}

function toText(title, content) {
  const blocks = plainBlocks(markdown.lexer(content));
  if (!startsWithTitle(content)) blocks.unshift(`${title}\n${'='.repeat(Math.min(60, title.length))}`);
  return `${blocks.join('\n\n')}\n`;
}

// ------------------------------------------------------------------ Word

const {
  Document,
  Packer,
  Paragraph,
  TextRun,
  HeadingLevel,
  ExternalHyperlink,
  Table,
  TableRow,
  TableCell,
  WidthType,
  AlignmentType,
  LevelFormat,
  BorderStyle,
  ShadingType,
} = docx;

const HEADINGS = [null, HeadingLevel.HEADING_1, HeadingLevel.HEADING_2, HeadingLevel.HEADING_3, HeadingLevel.HEADING_4, HeadingLevel.HEADING_5, HeadingLevel.HEADING_6];

function run(text, style) {
  return new TextRun({ text, ...style, ...(RTL_CHAR.test(text) ? { rightToLeft: true } : {}) });
}

function runsFrom(tokens, style = {}) {
  const runs = [];
  for (const t of tokens || []) {
    switch (t.type) {
      case 'strong':
        runs.push(...runsFrom(t.tokens, { ...style, bold: true }));
        break;
      case 'em':
        runs.push(...runsFrom(t.tokens, { ...style, italics: true }));
        break;
      case 'del':
        runs.push(...runsFrom(t.tokens, { ...style, strike: true }));
        break;
      case 'codespan':
        runs.push(run(decodeEntities(t.text), { ...style, font: 'Consolas', shading: { type: ShadingType.CLEAR, fill: 'F4F2EB' } }));
        break;
      case 'br':
        runs.push(new TextRun({ break: 1 }));
        break;
      case 'link':
        if (/^(https?:|mailto:)/i.test(t.href || '')) {
          runs.push(new ExternalHyperlink({ link: t.href, children: runsFrom(t.tokens, { ...style, style: 'Hyperlink' }) }));
        } else {
          runs.push(...runsFrom(t.tokens, style));
        }
        break;
      case 'text':
        if (t.tokens && t.tokens.length) runs.push(...runsFrom(t.tokens, style));
        else runs.push(run(decodeEntities(t.text), style));
        break;
      default:
        runs.push(run(decodeEntities(t.text || t.raw || ''), style));
    }
  }
  return runs;
}

function paragraph(children, plain, opts = {}) {
  return new Paragraph({ children, ...(isRtl(plain) ? { bidirectional: true } : {}), ...opts });
}

function listParagraphs(list, level, ctx, extra) {
  const out = [];
  const instance = ++ctx.lists;
  for (const item of list.items) {
    const inline = [];
    const nested = [];
    for (const tok of item.tokens || []) {
      if (tok.type === 'list') nested.push(tok);
      else if (tok.type === 'text' || tok.type === 'paragraph') {
        if (inline.length) inline.push({ type: 'br' });
        inline.push(...(tok.tokens || [{ type: 'text', text: tok.text }]));
      } else if (tok.type !== 'space') inline.push({ type: 'text', text: tok.text || tok.raw || '' });
    }
    if (item.task) inline.unshift({ type: 'text', text: item.checked ? '☑ ' : '☐ ' });
    const lvl = Math.min(level, 2);
    const kind = list.ordered ? { numbering: { reference: 'buddy-numbers', level: lvl, instance } } : { bullet: { level: lvl } };
    out.push(paragraph(runsFrom(inline, extra.style), item.text, { ...kind }));
    for (const n of nested) out.push(...listParagraphs(n, level + 1, ctx, extra));
  }
  return out;
}

function tableBlock(t) {
  const row = (cells, header) =>
    new TableRow({
      tableHeader: header,
      children: cells.map(
        (c) =>
          new TableCell({
            children: [paragraph(runsFrom(c.tokens, header ? { bold: true } : {}), c.text)],
            margins: { top: 60, bottom: 60, left: 100, right: 100 },
            ...(header ? { shading: { type: ShadingType.CLEAR, fill: 'F1EFE7' } } : {}),
          }),
      ),
    });
  return new Table({ width: { size: 100, type: WidthType.PERCENTAGE }, rows: [row(t.header, true), ...t.rows.map((r) => row(r, false))] });
}

function wordBlocks(tokens, ctx, extra = {}) {
  const out = [];
  const quote = extra.quote
    ? { indent: { left: 480 }, border: { left: { style: BorderStyle.SINGLE, size: 18, color: 'D97757', space: 8 } } }
    : {};
  for (const t of tokens) {
    switch (t.type) {
      case 'heading':
        out.push(paragraph(runsFrom(t.tokens), t.text, { heading: HEADINGS[t.depth] || HeadingLevel.HEADING_6 }));
        break;
      case 'paragraph':
      case 'text':
        out.push(paragraph(runsFrom(t.tokens || [{ type: 'text', text: t.text }], extra.style), t.text, quote));
        break;
      case 'list':
        out.push(...listParagraphs(t, 0, ctx, extra));
        break;
      case 'code': {
        const lines = String(t.text).split('\n');
        lines.forEach((line, i) =>
          out.push(
            new Paragraph({
              children: [new TextRun({ text: line || ' ', font: 'Consolas', size: 19 })],
              shading: { type: ShadingType.CLEAR, fill: 'F4F2EB' },
              spacing: { before: 0, after: i === lines.length - 1 ? 160 : 0 },
            }),
          ),
        );
        break;
      }
      case 'blockquote':
        out.push(...wordBlocks(t.tokens, ctx, { quote: true, style: { italics: true, color: '57564F' } }));
        break;
      case 'table':
        out.push(tableBlock(t), new Paragraph({ children: [] }));
        break;
      case 'hr':
        out.push(new Paragraph({ children: [], border: { bottom: { style: BorderStyle.SINGLE, size: 6, color: 'C9C6BC', space: 1 } } }));
        break;
      case 'space':
        break;
      default:
        if (t.text) out.push(paragraph([run(decodeEntities(t.text), {})], t.text));
    }
  }
  return out;
}

async function toDocx(title, content) {
  const ctx = { lists: 0 };
  const children = wordBlocks(markdown.lexer(content), ctx);
  if (!startsWithTitle(content)) children.unshift(paragraph([run(title, {})], title, { heading: HeadingLevel.TITLE }));
  const doc = new Document({
    creator: 'Claude Buddy',
    title,
    styles: {
      default: {
        document: { run: { font: { ascii: 'Calibri', hAnsi: 'Calibri', cs: 'Arial', eastAsia: 'Calibri' }, size: 22, sizeComplexScript: 22 } },
      },
    },
    numbering: {
      config: [
        {
          reference: 'buddy-numbers',
          levels: [LevelFormat.DECIMAL, LevelFormat.LOWER_LETTER, LevelFormat.LOWER_ROMAN].map((format, level) => ({
            level,
            format,
            text: `%${level + 1}.`,
            alignment: AlignmentType.START,
            style: { paragraph: { indent: { left: 720 * (level + 1), hanging: 360 } } },
          })),
        },
      ],
    },
    sections: [{ children: children.length ? children : [new Paragraph({ children: [] })] }],
  });
  return Packer.toBuffer(doc);
}

// ------------------------------------------------------------------ entry point

/**
 * Save a document. `content` is Markdown. Returns { path, name, format, kind, folder }.
 * Never overwrites: a second "Report" becomes "Report (2)".
 */
async function createDocument({ title, format, content }) {
  const fmt = normalizeFormat(format);
  if (!FORMATS[fmt]) throw new Error(`Can't make "${format}" files. Use docx, pdf, md, txt or html.`);
  let body = String(content || '').replace(/\r\n/g, '\n').trim();
  if (!body) throw new Error('The document is empty.');
  if (body.length > MAX_CHARS) body = body.slice(0, MAX_CHARS);
  const name = safeName(title || (body.match(/^\s*#\s+(.+)$/m) || [])[1]);

  const dir = folder();
  fs.mkdirSync(dir, { recursive: true });
  const file = uniquePath(dir, name, fmt);
  switch (fmt) {
    case 'md':
      fs.writeFileSync(file, `${startsWithTitle(body) ? '' : `# ${name}\n\n`}${body}\n`, 'utf8');
      break;
    case 'txt':
      fs.writeFileSync(file, toText(name, body), 'utf8');
      break;
    case 'html':
      fs.writeFileSync(file, toHtml(name, body, { page: true }), 'utf8');
      break;
    case 'pdf':
      await writePdf(file, toHtml(name, body));
      break;
    default:
      fs.writeFileSync(file, await toDocx(name, body));
  }
  return { path: file, name: path.basename(file), format: fmt, kind: FORMATS[fmt], folder: dir };
}

module.exports = { FORMATS, createDocument, folder, normalizeFormat, safeName, isRtl, toHtml };
