'use client';

import { useEditor, EditorContent } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import { useEffect } from 'react';

// A small WYSIWYG editor for free-form content (policy documents, rich
// descriptions, etc.). Value is HTML. Supports: bold, italic, H2/H3,
// bullet / numbered lists, links, undo/redo. Keeps the output constrained
// to Tiptap's schema so saved HTML is safe to render with
// dangerouslySetInnerHTML.
export default function RichTextEditor({ value = '', onChange, placeholder = 'Type or paste your content…', minHeight = 320 }) {
  const editor = useEditor({
    // Avoid Next.js App Router SSR hydration warnings — editor mounts on the client.
    immediatelyRender: false,
    extensions: [
      StarterKit.configure({
        heading: { levels: [2, 3] },
      }),
      Link.configure({
        openOnClick: false,
        autolink: true,
        linkOnPaste: true,
        HTMLAttributes: { rel: 'noopener noreferrer', target: '_blank', class: 'text-indigo-600 underline' },
      }),
    ],
    content: value || '',
    onUpdate({ editor }) {
      const html = editor.getHTML();
      // Tiptap emits an empty paragraph when the editor is cleared — normalise
      // that to an empty string so downstream "has content?" checks behave.
      onChange?.(html === '<p></p>' ? '' : html);
    },
    editorProps: {
      attributes: {
        class: 'prose prose-sm max-w-none focus:outline-none px-3 py-3',
        style: `min-height:${minHeight}px`,
      },
    },
  });

  // Keep Tiptap in sync if the parent replaces the value (e.g. opening the
  // modal for a different policy).
  useEffect(() => {
    if (!editor) return;
    const current = editor.getHTML();
    if ((value || '') !== current && (value || '') !== (current === '<p></p>' ? '' : current)) {
      editor.commands.setContent(value || '', false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value, editor]);

  if (!editor) {
    return (
      <div className="border border-gray-300 rounded-lg bg-white" style={{ minHeight: minHeight + 40 }}>
        <div className="px-3 py-2 border-b border-gray-200 bg-gray-50 text-xs text-gray-400">Loading editor…</div>
      </div>
    );
  }

  function promptLink() {
    const prev = editor.getAttributes('link').href || '';
    const url = window.prompt('Link URL (leave blank to remove)', prev);
    if (url === null) return; // cancelled
    if (url === '') {
      editor.chain().focus().extendMarkRange('link').unsetLink().run();
      return;
    }
    // Basic normalisation — add https:// if the user typed a bare domain.
    const safe = /^https?:\/\//i.test(url) || url.startsWith('mailto:') ? url : `https://${url}`;
    editor.chain().focus().extendMarkRange('link').setLink({ href: safe }).run();
  }

  const btnBase = 'px-2 py-1 text-xs rounded border transition-colors';
  const btnIdle = 'border-gray-300 bg-white text-gray-700 hover:bg-gray-100';
  const btnActive = 'border-indigo-500 bg-indigo-50 text-indigo-700';
  const divider = <span className="w-px h-5 bg-gray-300 mx-1" aria-hidden />;

  return (
    <div className="border border-gray-300 rounded-lg bg-white overflow-hidden focus-within:ring-2 focus-within:ring-indigo-500 focus-within:border-transparent">
      <div className="flex flex-wrap items-center gap-1 px-2 py-1.5 border-b border-gray-200 bg-gray-50">
        <button type="button" title="Bold (Ctrl+B)"
          className={`${btnBase} font-bold ${editor.isActive('bold') ? btnActive : btnIdle}`}
          onClick={() => editor.chain().focus().toggleBold().run()}>B</button>
        <button type="button" title="Italic (Ctrl+I)"
          className={`${btnBase} italic ${editor.isActive('italic') ? btnActive : btnIdle}`}
          onClick={() => editor.chain().focus().toggleItalic().run()}>I</button>
        {divider}
        <button type="button" title="Heading 2"
          className={`${btnBase} ${editor.isActive('heading', { level: 2 }) ? btnActive : btnIdle}`}
          onClick={() => editor.chain().focus().toggleHeading({ level: 2 }).run()}>H2</button>
        <button type="button" title="Heading 3"
          className={`${btnBase} ${editor.isActive('heading', { level: 3 }) ? btnActive : btnIdle}`}
          onClick={() => editor.chain().focus().toggleHeading({ level: 3 }).run()}>H3</button>
        <button type="button" title="Paragraph"
          className={`${btnBase} ${editor.isActive('paragraph') && !editor.isActive('heading') ? btnActive : btnIdle}`}
          onClick={() => editor.chain().focus().setParagraph().run()}>P</button>
        {divider}
        <button type="button" title="Bullet list"
          className={`${btnBase} ${editor.isActive('bulletList') ? btnActive : btnIdle}`}
          onClick={() => editor.chain().focus().toggleBulletList().run()}>• List</button>
        <button type="button" title="Numbered list"
          className={`${btnBase} ${editor.isActive('orderedList') ? btnActive : btnIdle}`}
          onClick={() => editor.chain().focus().toggleOrderedList().run()}>1. List</button>
        {divider}
        <button type="button" title="Add / edit link"
          className={`${btnBase} ${editor.isActive('link') ? btnActive : btnIdle}`}
          onClick={promptLink}>Link</button>
        <button type="button" title="Clear formatting"
          className={`${btnBase} ${btnIdle}`}
          onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()}>Clear</button>
        {divider}
        <button type="button" title="Undo"
          className={`${btnBase} ${btnIdle}`}
          onClick={() => editor.chain().focus().undo().run()}
          disabled={!editor.can().undo()}>↶</button>
        <button type="button" title="Redo"
          className={`${btnBase} ${btnIdle}`}
          onClick={() => editor.chain().focus().redo().run()}
          disabled={!editor.can().redo()}>↷</button>
      </div>
      <div className="relative">
        <EditorContent editor={editor} />
        {editor.isEmpty && (
          <div
            className="absolute top-0 left-0 pointer-events-none text-gray-400 text-sm px-3 py-3"
            aria-hidden="true"
          >
            {placeholder}
          </div>
        )}
      </div>
    </div>
  );
}
