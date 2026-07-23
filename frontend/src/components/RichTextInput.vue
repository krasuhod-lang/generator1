<script setup>
/**
 * RichTextInput — лёгкий WYSIWYG-редактор для описательных полей задач.
 * Использует TipTap (ProseMirror) с поддержкой списков, форматирования и ссылок.
 * Сохраняет HTML — форматирование отображается ровно так, как введено.
 */
import { watch, onBeforeUnmount } from 'vue';
import { useEditor, EditorContent } from '@tiptap/vue-3';
import StarterKit from '@tiptap/starter-kit';
import Link from '@tiptap/extension-link';
import Image from '@tiptap/extension-image';
import DOMPurify from 'dompurify';

const props = defineProps({
  modelValue: { type: String, default: '' },
  placeholder: { type: String, default: '' },
  minHeight: { type: String, default: '120px' },
});
const emit = defineEmits(['update:modelValue']);

// Последнее значение, которое мы сами отправили наверх через update:modelValue.
// Нужно, чтобы отличить «эхо» собственного ввода (родитель вернул тот же HTML
// обратно в modelValue) от настоящего внешнего изменения. Без этого watch
// пересобирал контент на каждом нажатии клавиши и сбрасывал курсор в конец —
// из-за чего «улетал» курсор и терялись пробелы при наборе.
let lastEmittedHtml = null;

/**
 * Если modelValue выглядит как plain-text (не содержит HTML-тегов),
 * конвертируем переносы строк в <p> для корректного отображения,
 * а голые URL превращаем в <a>.
 */
function plainToHtml(text) {
  if (!text) return '';
  if (/<[a-z][\s\S]*>/i.test(text)) return text; // уже HTML
  return text
    .split('\n')
    .map(line => {
      const escaped = line
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      // Превращаем голые URL в кликабельные ссылки
      const linked = escaped.replace(
        /(https?:\/\/[^\s<]+)/g,
        '<a href="$1" target="_blank" rel="noopener noreferrer">$1</a>',
      );
      return `<p>${linked || '<br>'}</p>`;
    })
    .join('');
}

function sanitize(html) {
  if (!html) return '';
  // Разрешаем изображения (используются в описаниях задач отчётов: скриншоты
  // загружаются через /reports/upload-image и вставляются как <img>). data:
  // схема нужна, чтобы поддержать вставку из буфера до загрузки на сервер.
  const cleaned = DOMPurify.sanitize(html, {
    USE_PROFILES: { html: true },
    ADD_TAGS: ['img'],
    ADD_ATTR: ['src', 'alt', 'width', 'height', 'style', 'target', 'rel'],
    ALLOWED_URI_REGEXP: /^(?:https?:\/\/|\/(?:api\/)?uploads\/|data:image\/(?:png|jpeg|jpg|gif|webp);base64,)/i,
  });
  // Все ссылки в задачах должны открываться в новой вкладке, чтобы отчёт
  // оставался открытым у клиента (см. также safeHtml в ReportRenderer).
  return cleaned
    // Legacy: картинки, сохранённые как `/uploads/...`, недоступны в проде
    // (nginx проксирует на backend только `/api/`) — переписываем на `/api/uploads/`.
    .replace(/(<img\b[^>]*\bsrc=["'])\/uploads\//gi, '$1/api/uploads/')
    .replace(/<a\b([^>]*)>/gi, (m, attrs) => {
      let next = attrs;
      if (!/\btarget=/i.test(next)) next += ' target="_blank"';
      if (!/\brel=/i.test(next)) next += ' rel="noopener noreferrer"';
      return `<a${next}>`;
    });
}

const editor = useEditor({
  content: sanitize(plainToHtml(props.modelValue || '')),
  extensions: [
    StarterKit,
    Link.configure({
      openOnClick: false,
      autolink: true,
      linkOnPaste: true,
      HTMLAttributes: { target: '_blank', rel: 'noopener noreferrer' },
    }),
    // Изображения: используются в описаниях задач отчётов (скриншоты).
    // Для других форм (CreateTaskPage и т.п.) расширение безвредно — просто
    // даёт возможность вставить <img>, если кто-то её введёт.
    Image.configure({
      inline: false,
      allowBase64: true,
      HTMLAttributes: { style: 'max-width:100%; height:auto;' },
    }),
  ],
  editorProps: {
    attributes: {
      class: 'prose prose-invert prose-sm max-w-none p-3 focus:outline-none bg-gray-900 rounded-b-lg border border-gray-700 border-t-0',
      style: `min-height: ${props.minHeight}`,
    },
  },
  onUpdate: ({ editor: ed }) => {
    const html = ed.getHTML();
    lastEmittedHtml = html;
    emit('update:modelValue', html);
  },
});

watch(() => props.modelValue, (newVal) => {
  if (!editor.value) return;
  // Эхо нашего собственного ввода — родитель вернул тот же HTML обратно.
  // Ничего не делаем: контент в редакторе уже актуален, а повторный
  // setContent сбросил бы позицию курсора и «съел» набираемые пробелы.
  if (newVal === lastEmittedHtml) return;
  const current = editor.value.getHTML();
  const incoming = sanitize(plainToHtml(newVal || ''));
  // Обновляем только при настоящем внешнем изменении (вставка картинки,
  // подгрузка данных и т.п.), чтобы не трогать курсор во время набора.
  if (current !== incoming) {
    editor.value.commands.setContent(incoming, false);
  }
});

/* ── Команды тулбара ────────────────────────────────────────────────── */
function toggleBold()   { editor.value?.chain().focus().toggleBold().run(); }
function toggleItalic() { editor.value?.chain().focus().toggleItalic().run(); }
function toggleBullet() { editor.value?.chain().focus().toggleBulletList().run(); }
function toggleOrdered(){ editor.value?.chain().focus().toggleOrderedList().run(); }

function setLink() {
  if (!editor.value) return;
  const prev = editor.value.getAttributes('link').href;
  const url = window.prompt('URL ссылки:', prev || 'https://');
  if (url === null) return; // отмена
  if (url === '') {
    editor.value.chain().focus().extendMarkRange('link').unsetLink().run();
    return;
  }
  editor.value.chain().focus().extendMarkRange('link').setLink({ href: url }).run();
}

function removeLink() {
  editor.value?.chain().focus().extendMarkRange('link').unsetLink().run();
}

function isActive(name, attrs) {
  return editor.value?.isActive(name, attrs) ?? false;
}

onBeforeUnmount(() => {
  if (editor.value) editor.value.destroy();
});
</script>

<template>
  <div class="rich-text-input">
    <!-- Toolbar -->
    <div class="flex items-center gap-1 px-2 py-1.5 bg-gray-800 rounded-t-lg border border-gray-700">
      <button type="button" @click="toggleBold"
        :class="['toolbar-btn', { active: isActive('bold') }]" title="Жирный">
        <span class="font-bold text-xs">B</span>
      </button>
      <button type="button" @click="toggleItalic"
        :class="['toolbar-btn', { active: isActive('italic') }]" title="Курсив">
        <span class="italic text-xs">I</span>
      </button>
      <span class="w-px h-4 bg-gray-600 mx-1"></span>
      <button type="button" @click="toggleBullet"
        :class="['toolbar-btn', { active: isActive('bulletList') }]" title="Маркированный список">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M4 6h16M4 12h16M4 18h16" />
        </svg>
      </button>
      <button type="button" @click="toggleOrdered"
        :class="['toolbar-btn', { active: isActive('orderedList') }]" title="Нумерованный список">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M4 6h16M4 12h16M4 18h8" />
        </svg>
      </button>
      <span class="w-px h-4 bg-gray-600 mx-1"></span>
      <button type="button" @click="setLink"
        :class="['toolbar-btn', { active: isActive('link') }]" title="Вставить ссылку">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M13.828 10.172a4 4 0 00-5.656 0l-4 4a4 4 0 105.656 5.656l1.102-1.101m-.758-4.899a4 4 0 005.656 0l4-4a4 4 0 00-5.656-5.656l-1.1 1.1" />
        </svg>
      </button>
      <button v-if="isActive('link')" type="button" @click="removeLink"
        class="toolbar-btn text-red-400" title="Убрать ссылку">
        <svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
          <path stroke-linecap="round" stroke-linejoin="round" stroke-width="2"
            d="M18.364 18.364A9 9 0 005.636 5.636m12.728 12.728A9 9 0 015.636 5.636m12.728 12.728L5.636 5.636" />
        </svg>
      </button>
    </div>
    <!-- Editor -->
    <EditorContent :editor="editor" />
    <p v-if="placeholder && !modelValue" class="placeholder-hint">{{ placeholder }}</p>
  </div>
</template>

<style scoped>
.rich-text-input {
  position: relative;
}
.toolbar-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 28px;
  height: 28px;
  border-radius: 4px;
  color: #9ca3af;
  transition: all 0.15s;
  cursor: pointer;
  background: transparent;
  border: none;
}
.toolbar-btn:hover {
  background: rgba(255,255,255,0.08);
  color: #e5e7eb;
}
.toolbar-btn.active {
  background: rgba(99,102,241,0.2);
  color: #818cf8;
}
.placeholder-hint {
  position: absolute;
  bottom: 12px;
  left: 16px;
  color: #6b7280;
  font-size: 0.8rem;
  pointer-events: none;
}

/* Стили ProseMirror-контента */
.rich-text-input :deep(.ProseMirror) {
  outline: none;
}
.rich-text-input :deep(.ProseMirror p) {
  color: #d1d5db;
  line-height: 1.6;
  margin: 0.3em 0;
}
.rich-text-input :deep(.ProseMirror ul),
.rich-text-input :deep(.ProseMirror ol) {
  color: #d1d5db;
  padding-left: 1.5em;
}
.rich-text-input :deep(.ProseMirror li) {
  margin: 0.2em 0;
}
.rich-text-input :deep(.ProseMirror strong) {
  color: #fff;
}
.rich-text-input :deep(.ProseMirror a) {
  color: #818cf8;
  text-decoration: underline;
  cursor: pointer;
}
.rich-text-input :deep(.ProseMirror p.is-editor-empty:first-child::before) {
  content: attr(data-placeholder);
  float: left;
  color: #6b7280;
  pointer-events: none;
  height: 0;
}
</style>
