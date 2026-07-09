'use client';

/*
 * WysiwygEditor — Feature 9 "write on the letterhead" authoring surface.
 *
 * Renders the selected letterhead's page 1 (rasterized client-side by PdfCanvas) as
 * the backdrop and overlays a rich contentEditable EXACTLY at the layout's writing
 * area, so what the admin types sits where it will print ("what you place is what
 * you get"). Formatting is a small Markdown SUBSET that the server renderer mirrors:
 * bold, H1/H2/H3, bullet + numbered lists. Merge fields insert as atomic chips.
 *
 * Storage stays Markdown (the LetterTemplate.bodyMarkdown field + the {{token}}
 * validator are unchanged): the editor round-trips Markdown ↔ HTML. A raw-source
 * toggle is kept as a safety valve.
 *
 * Contract:
 *   <WysiwygEditor ref value={markdown} onChange={fn} letterhead={row|null} />
 *   ref.current.insertToken('{{employee.name}}')  // called by the merge drawer
 */

import {
  forwardRef, useCallback, useEffect, useImperativeHandle, useRef, useState,
} from 'react';
import PdfCanvas from '../letterheads/PdfCanvas';

// Must match backend renderLetter.js DEFAULT_WRITING_AREA so the on-screen band
// lines up with the printed body when a letterhead has no saved layout yet.
const DEFAULT_WA = { x: 0.1, y: 0.26, w: 0.8, h: 0.56, fontSize: 11 };

// ── Markdown SUBSET ↔ HTML ────────────────────────────────────────────────────
const TOKEN_RE = /\{\{\s*([a-zA-Z][\w]*\.[a-zA-Z][\w]*)\s*\}\}/g;

function escapeHtml(s) {
  return String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function chipHtml(token) {
  const bare = String(token).replace(/[{}]/g, '').trim();
  const label = bare.split('.')[1] || bare;
  return `<span class="mfchip" contenteditable="false" data-token="${bare}">${escapeHtml(label)}</span>`;
}

function inlineToHtml(text) {
  let s = escapeHtml(text);
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  s = s.replace(TOKEN_RE, (_m, tok) => chipHtml(tok));
  return s || '<br>';
}

// Markdown subset → HTML for the contentEditable initial content.
function mdToHtml(md) {
  const out = [];
  let list = null; // { type:'ul'|'ol', items:[] }
  const flush = () => {
    if (!list) return;
    out.push(`<${list.type}>${list.items.map((i) => `<li>${i}</li>`).join('')}</${list.type}>`);
    list = null;
  };
  for (const raw of String(md || '').split(/\r?\n/)) {
    const line = raw.replace(/\s+$/, '');
    let m;
    if (/^\s*$/.test(line)) { flush(); out.push('<p><br></p>'); continue; }
    if ((m = /^\s*(#{1,3})\s+(.*)$/.exec(line))) {
      flush(); out.push(`<h${m[1].length}>${inlineToHtml(m[2])}</h${m[1].length}>`);
    } else if ((m = /^\s*[-*]\s+(.*)$/.exec(line))) {
      if (!list || list.type !== 'ul') { flush(); list = { type: 'ul', items: [] }; }
      list.items.push(inlineToHtml(m[1]));
    } else if ((m = /^\s*\d+\.\s+(.*)$/.exec(line))) {
      if (!list || list.type !== 'ol') { flush(); list = { type: 'ol', items: [] }; }
      list.items.push(inlineToHtml(m[1]));
    } else {
      flush(); out.push(`<p>${inlineToHtml(line)}</p>`);
    }
  }
  flush();
  return out.join('') || '<p><br></p>';
}

// Serialize an element's inline content back to Markdown (bold + chips preserved).
function serializeInline(node) {
  let out = '';
  node.childNodes.forEach((n) => {
    if (n.nodeType === 3) { out += n.textContent.replace(/ /g, ' '); return; }
    if (n.nodeType !== 1) return;
    const tag = n.tagName.toLowerCase();
    if (n.dataset && n.dataset.token) out += `{{${n.dataset.token}}}`;
    else if (tag === 'strong' || tag === 'b') out += `**${serializeInline(n)}**`;
    else if (tag === 'br') out += '';
    else out += serializeInline(n);
  });
  return out;
}

// contentEditable HTML → Markdown subset.
function htmlToMd(root) {
  const lines = [];
  root.childNodes.forEach((node) => {
    if (node.nodeType === 3) { const t = node.textContent.replace(/ /g, ' ').trim(); if (t) lines.push(t); return; }
    if (node.nodeType !== 1) return;
    const tag = node.tagName.toLowerCase();
    if (tag === 'h1' || tag === 'h2' || tag === 'h3') {
      lines.push(`${'#'.repeat(Number(tag[1]))} ${serializeInline(node)}`.trim());
    } else if (tag === 'ul') {
      node.querySelectorAll(':scope > li').forEach((li) => lines.push(`- ${serializeInline(li)}`.trim()));
    } else if (tag === 'ol') {
      let i = 0;
      node.querySelectorAll(':scope > li').forEach((li) => { i += 1; lines.push(`${i}. ${serializeInline(li)}`.trim()); });
    } else if (tag === 'p' || tag === 'div') {
      lines.push(serializeInline(node).trim());
    } else if (tag === 'br') {
      lines.push('');
    } else {
      const md = serializeInline(node).trim();
      if (md) lines.push(md);
    }
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

// ── toolbar ───────────────────────────────────────────────────────────────────
function ToolbarButton({ onClick, title, children, active }) {
  return (
    <button
      type="button"
      title={title}
      onMouseDown={(e) => { e.preventDefault(); onClick(); }}
      className={`px-2 py-1 text-xs rounded border ${active ? 'border-violet-400 bg-violet-50 text-violet-700' : 'border-gray-300 text-gray-600 hover:bg-gray-50'}`}
    >
      {children}
    </button>
  );
}

const WysiwygEditor = forwardRef(function WysiwygEditor({ value, onChange, letterhead }, ref) {
  const editorRef = useRef(null);
  const lastEmitted = useRef(null);        // last Markdown WE produced (avoid caret resets)
  const [mode, setMode] = useState('rich'); // 'rich' | 'source'
  const [canvas, setCanvas] = useState({ cssWidth: 0, cssHeight: 0, pageWidthPt: 595.28 });

  const src = letterhead && letterhead.fileUrl ? letterhead.fileUrl : null;
  const wa = (letterhead && letterhead.layoutJson && letterhead.layoutJson.writingArea) || DEFAULT_WA;

  // Hydrate the contentEditable from `value` only on EXTERNAL change (switching
  // templates / source-edit), never on our own keystroke echo — that would reset
  // the caret to the top on every character.
  useEffect(() => {
    if (mode !== 'rich') return;
    const el = editorRef.current;
    if (!el) return;
    if (value === lastEmitted.current) return;
    el.innerHTML = mdToHtml(value || '');
    lastEmitted.current = value || '';
  }, [value, mode]);

  const emit = useCallback(() => {
    const el = editorRef.current;
    if (!el) return;
    const md = htmlToMd(el);
    lastEmitted.current = md;
    onChange(md);
  }, [onChange]);

  const exec = useCallback((cmd, arg) => {
    editorRef.current?.focus();
    try {
      // Emit semantic tags (<b>/<strong>, <h1>, <ul>) not inline CSS, so the
      // HTML→Markdown serializer stays deterministic across browsers.
      document.execCommand('styleWithCSS', false, false);
      document.execCommand(cmd, false, arg);
    } catch { /* deprecated but supported in target browsers */ }
    emit();
  }, [emit]);

  const insertToken = useCallback((token) => {
    if (mode === 'source') {
      // In source mode just append the raw token at the end.
      const next = `${value || ''}{{${String(token).replace(/[{}]/g, '').trim()}}}`;
      onChange(next); lastEmitted.current = next;
      return;
    }
    const el = editorRef.current;
    if (!el) return;
    el.focus();
    const sel = window.getSelection();
    let range;
    if (sel && sel.rangeCount && el.contains(sel.anchorNode)) range = sel.getRangeAt(0);
    else { range = document.createRange(); range.selectNodeContents(el); range.collapse(false); }
    range.deleteContents();
    const tmp = document.createElement('span');
    tmp.innerHTML = `${chipHtml(token)} `;
    const frag = document.createDocumentFragment();
    let last = null;
    while (tmp.firstChild) { last = tmp.firstChild; frag.appendChild(last); }
    range.insertNode(frag);
    if (last) { range.setStartAfter(last); range.collapse(true); sel.removeAllRanges(); sel.addRange(range); }
    emit();
  }, [mode, value, onChange, emit]);

  useImperativeHandle(ref, () => ({ insertToken }), [insertToken]);

  // Paste as plain text (keep the doc to our controlled subset).
  const onPaste = useCallback((e) => {
    e.preventDefault();
    const text = (e.clipboardData || window.clipboardData).getData('text/plain');
    try { document.execCommand('insertText', false, text); } catch { /* noop */ }
    emit();
  }, [emit]);

  const scale = canvas.cssWidth && canvas.pageWidthPt ? canvas.cssWidth / canvas.pageWidthPt : 1;
  const fontPx = Math.max(9, Math.round((Number(wa.fontSize) || 11) * scale));

  const editorStyle = src && canvas.cssWidth
    ? {
      position: 'absolute',
      left: wa.x * canvas.cssWidth,
      top: wa.y * canvas.cssHeight,
      width: wa.w * canvas.cssWidth,
      height: wa.h * canvas.cssHeight,
      fontSize: fontPx,
      overflowY: 'auto',
    }
    : { minHeight: 340, fontSize: 15 };

  return (
    <div className="flex-1 min-w-0">
      {/* toolbar */}
      <div className="flex items-center gap-1 mb-2 flex-wrap">
        <ToolbarButton title="Bold (⌘B)" onClick={() => exec('bold')}><b>B</b></ToolbarButton>
        <ToolbarButton title="Heading 1" onClick={() => exec('formatBlock', 'H1')}>H1</ToolbarButton>
        <ToolbarButton title="Heading 2" onClick={() => exec('formatBlock', 'H2')}>H2</ToolbarButton>
        <ToolbarButton title="Normal text" onClick={() => exec('formatBlock', 'P')}>¶</ToolbarButton>
        <ToolbarButton title="Bullet list" onClick={() => exec('insertUnorderedList')}>• List</ToolbarButton>
        <ToolbarButton title="Numbered list" onClick={() => exec('insertOrderedList')}>1. List</ToolbarButton>
        <span className="flex-1" />
        <div className="inline-flex rounded border border-gray-300 overflow-hidden">
          <button type="button" onClick={() => setMode('rich')}
            className={`px-2 py-1 text-xs ${mode === 'rich' ? 'bg-gray-800 text-white' : 'bg-white text-gray-600'}`}>Rich</button>
          <button type="button" onClick={() => { if (mode === 'rich') emit(); setMode('source'); }}
            className={`px-2 py-1 text-xs ${mode === 'source' ? 'bg-gray-800 text-white' : 'bg-white text-gray-600'}`}>Source</button>
        </div>
      </div>

      {mode === 'source' ? (
        <textarea
          value={value || ''}
          onChange={(e) => { onChange(e.target.value); lastEmitted.current = e.target.value; }}
          rows={18}
          spellCheck={false}
          className="w-full px-3 py-2 border border-gray-300 rounded-lg text-sm font-mono leading-relaxed focus:outline-none"
          placeholder="To Whomsoever It May Concern…  # Heading, **bold**, - bullet, {{employee.name}}"
        />
      ) : src ? (
        // WYSIWYG on the letterhead: raster backdrop + editable overlay at the writing area.
        <div className="border border-gray-200 rounded-lg bg-gray-50 p-3 overflow-auto" style={{ maxHeight: '58vh' }}>
          <div className="relative inline-block mx-auto">
            <PdfCanvas src={src} scale={1} onSize={setCanvas} />
            {/* writing-area guide */}
            {canvas.cssWidth ? (
              <div className="pointer-events-none absolute border border-dashed border-violet-300"
                style={{ left: wa.x * canvas.cssWidth, top: wa.y * canvas.cssHeight, width: wa.w * canvas.cssWidth, height: wa.h * canvas.cssHeight }} />
            ) : null}
            <div
              ref={editorRef}
              contentEditable
              suppressContentEditableWarning
              onInput={emit}
              onPaste={onPaste}
              className="mfeditor outline-none text-gray-900 leading-snug"
              style={editorStyle}
            />
          </div>
        </div>
      ) : (
        // No letterhead selected → plain rich surface (still WYSIWYG for formatting).
        <div
          ref={editorRef}
          contentEditable
          suppressContentEditableWarning
          onInput={emit}
          onPaste={onPaste}
          className="mfeditor outline-none border border-gray-300 rounded-lg px-4 py-3 text-gray-900 leading-relaxed"
          style={editorStyle}
        />
      )}

      <style jsx global>{`
        .mfeditor h1 { font-size: 1.5em; font-weight: 700; margin: 0.3em 0; }
        .mfeditor h2 { font-size: 1.28em; font-weight: 700; margin: 0.3em 0; }
        .mfeditor h3 { font-size: 1.12em; font-weight: 700; margin: 0.2em 0; }
        .mfeditor p { margin: 0 0 0.35em; }
        .mfeditor ul { list-style: disc; padding-left: 1.4em; margin: 0.2em 0; }
        .mfeditor ol { list-style: decimal; padding-left: 1.4em; margin: 0.2em 0; }
        .mfeditor .mfchip {
          display: inline-block; padding: 0 6px; margin: 0 1px; border-radius: 9999px;
          background: #ede9fe; color: #6d28d9; border: 1px solid #ddd6fe;
          font-size: 0.85em; font-family: ui-monospace, monospace; white-space: nowrap;
        }
      `}</style>
    </div>
  );
});

export default WysiwygEditor;
