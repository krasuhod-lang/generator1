<script setup>
/**
 * CopilotEditor — WYSIWYG редактор статьи на TipTap.
 * Загружает initial-HTML из props.modelValue. При выделении публикует
 * { text, html } через эмит. Поддерживает команды replace / insert_below.
 */
import { onBeforeUnmount, watch, ref } from 'vue';
import { useEditor, EditorContent } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import { DOMSerializer } from '@tiptap/pm/model';
import DOMPurify from 'dompurify';

const props = defineProps({
  modelValue: { type: String, default: '' },
});
const emit  = defineEmits(['update:modelValue', 'selection-change']);

const editorRef = ref(null);
const editor = useEditor({
  content: sanitize(props.modelValue || ''),
  extensions: [StarterKit],
  editorProps: {
    attributes: {
      class: 'prose prose-invert max-w-none p-4 focus:outline-none min-h-[400px] bg-gray-900 rounded-lg border border-gray-700',
    },
  },
  onUpdate: ({ editor }) => {
    emit('update:modelValue', editor.getHTML());
  },
  onSelectionUpdate: ({ editor }) => {
    const { from, to, empty } = editor.state.selection;
    if (empty) {
      emit('selection-change', { text: '', html: '', from, to });
      return;
    }
    const text = editor.state.doc.textBetween(from, to, '\n', '\n');
    // HTML селекции — берём slice через ProseMirror serializer.
    const slice = editor.state.doc.slice(from, to);
    const fragment = slice.content;
    const div = document.createElement('div');
    fragment.forEach((node) => {
      const html = serializerToHTML(editor, node);
      if (html) div.insertAdjacentHTML('beforeend', html);
    });
    emit('selection-change', { text, html: div.innerHTML, from, to });
  },
});

function serializerToHTML(editorInstance, node) {
  try {
    const ser = DOMSerializer.fromSchema(editorInstance.schema);
    const dom = ser.serializeNode(node);
    const tmp = document.createElement('div');
    tmp.appendChild(dom);
    return tmp.innerHTML;
  } catch (_) {
    return node.textContent || '';
  }
}

watch(() => props.modelValue, (newVal) => {
  if (!editor.value) return;
  if (editor.value.getHTML() !== newVal) {
    editor.value.commands.setContent(sanitize(newVal || ''), false);
  }
});

function sanitize(html) {
  if (!html) return '';
  return DOMPurify.sanitize(html, { USE_PROFILES: { html: true } });
}

// ── Публичные команды ────────────────────────────────────────────────────
function replaceSelection(html) {
  if (!editor.value || !html) return;
  const clean = sanitize(html);
  editor.value
    .chain()
    .focus()
    .deleteSelection()
    .insertContent(clean, { parseOptions: { preserveWhitespace: 'full' } })
    .run();
  emit('update:modelValue', editor.value.getHTML());
}

function insertBelow(html) {
  if (!editor.value || !html) return;
  const clean = sanitize(html);
  // Перемещаем курсор в конец выделения (или текущей позиции, если выделения нет)
  const { to } = editor.value.state.selection;
  editor.value
    .chain()
    .focus()
    .setTextSelection(to)
    .insertContent(`<div data-copilot-insert>${clean}</div>`, {
      parseOptions: { preserveWhitespace: 'full' },
    })
    .run();
  emit('update:modelValue', editor.value.getHTML());
}

function getCurrentHtml() {
  return editor.value ? editor.value.getHTML() : '';
}

defineExpose({ replaceSelection, insertBelow, getCurrentHtml });

onBeforeUnmount(() => {
  if (editor.value) editor.value.destroy();
});
</script>

<template>
  <div ref="editorRef" class="copilot-editor">
    <EditorContent :editor="editor" />
  </div>
</template>

<style scoped>
.copilot-editor :deep(.ProseMirror) {
  min-height: 400px;
}
.copilot-editor :deep(h1),
.copilot-editor :deep(h2),
.copilot-editor :deep(h3) {
  color: #f9fafb;
  font-weight: 700;
  margin-top: 1.2em;
  margin-bottom: 0.5em;
}
.copilot-editor :deep(h2) { font-size: 1.5rem; }
.copilot-editor :deep(h3) { font-size: 1.25rem; }
.copilot-editor :deep(p) { color: #d1d5db; line-height: 1.7; margin: 0.6em 0; }
.copilot-editor :deep(ul),
.copilot-editor :deep(ol) { color: #d1d5db; padding-left: 1.5em; }
.copilot-editor :deep(li) { margin: 0.3em 0; }
.copilot-editor :deep(strong) { color: #fff; }
.copilot-editor :deep(a) { color: #818cf8; text-decoration: underline; }
.copilot-editor :deep([data-copilot-insert]) {
  border-left: 3px solid #6366f1;
  padding-left: 0.8em;
  margin: 0.6em 0;
}
</style>
