<script setup>
/**
 * MarkdownView.vue — лёгкий рендер Markdown без внешних зависимостей.
 *
 * Поддерживает: заголовки #..######, **жирный**, *курсив*, `код`,
 * списки (маркированные/нумерованные), таблицы GFM, ссылки [t](url),
 * горизонтальные линии, абзацы. HTML экранируется ДО разметки, итог
 * прогоняется через DOMPurify — защита от XSS в ИИ-выводе.
 */
import { computed } from 'vue';
import DOMPurify from 'dompurify';

const props = defineProps({
  source: { type: String, default: '' },
});

function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

// Инлайн-разметка внутри уже экранированного текста.
function inline(text) {
  let t = text;
  t = t.replace(/`([^`]+)`/g, (_, c) => `<code>${c}</code>`);
  t = t.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  t = t.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  // ссылки [text](http...) — допускаем только http/https
  t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer nofollow">$1</a>');
  return t;
}

function splitRow(line) {
  return line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

function renderMarkdown(src) {
  const lines = String(src || '').replace(/\r\n/g, '\n').split('\n');
  const out = [];
  let i = 0;
  let listType = null; // 'ul' | 'ol'
  let para = [];

  const flushPara = () => {
    if (para.length) {
      out.push(`<p>${inline(esc(para.join(' ')))}</p>`);
      para = [];
    }
  };
  const closeList = () => {
    if (listType) { out.push(`</${listType}>`); listType = null; }
  };

  while (i < lines.length) {
    const line = lines[i];
    const trimmed = line.trim();

    // Таблица GFM: строка с | и следующая строка-разделитель ---|---
    if (/\|/.test(line) && i + 1 < lines.length && /^\s*\|?[\s:-]+\|[\s:|-]*$/.test(lines[i + 1])) {
      flushPara(); closeList();
      const header = splitRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) {
        rows.push(splitRow(lines[i])); i++;
      }
      let html = '<table><thead><tr>';
      html += header.map((h) => `<th>${inline(esc(h))}</th>`).join('');
      html += '</tr></thead><tbody>';
      for (const r of rows) {
        html += '<tr>' + r.map((c) => `<td>${inline(esc(c))}</td>`).join('') + '</tr>';
      }
      html += '</tbody></table>';
      out.push(html);
      continue;
    }

    // Заголовки
    const h = trimmed.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      flushPara(); closeList();
      const lvl = h[1].length;
      out.push(`<h${lvl}>${inline(esc(h[2]))}</h${lvl}>`);
      i++; continue;
    }

    // Горизонтальная линия
    if (/^(-{3,}|\*{3,}|_{3,})$/.test(trimmed)) {
      flushPara(); closeList();
      out.push('<hr />');
      i++; continue;
    }

    // Списки
    const ol = trimmed.match(/^(\d+)[.)]\s+(.*)$/);
    const ul = trimmed.match(/^[-*+]\s+(.*)$/);
    if (ol || ul) {
      flushPara();
      const wanted = ol ? 'ol' : 'ul';
      if (listType && listType !== wanted) closeList();
      if (!listType) { out.push(`<${wanted}>`); listType = wanted; }
      out.push(`<li>${inline(esc((ol ? ol[2] : ul[1])))}</li>`);
      i++; continue;
    }

    // Пустая строка → конец абзаца/списка
    if (!trimmed) {
      flushPara(); closeList();
      i++; continue;
    }

    // Обычный текст абзаца
    closeList();
    para.push(trimmed);
    i++;
  }
  flushPara(); closeList();
  return out.join('\n');
}

const html = computed(() => DOMPurify.sanitize(renderMarkdown(props.source), {
  ALLOWED_TAGS: ['h1', 'h2', 'h3', 'h4', 'h5', 'h6', 'p', 'strong', 'em', 'code',
    'ul', 'ol', 'li', 'a', 'hr', 'br', 'table', 'thead', 'tbody', 'tr', 'th', 'td', 'blockquote'],
  ALLOWED_ATTR: ['href', 'target', 'rel'],
}));
</script>

<template>
  <div class="markdown-body prose prose-invert max-w-none" v-html="html"></div>
</template>

<style scoped>
.markdown-body :deep(h1),
.markdown-body :deep(h2),
.markdown-body :deep(h3) { color: #c7d2fe; font-weight: 700; margin: 1rem 0 0.5rem; }
.markdown-body :deep(h2) { font-size: 1.15rem; border-bottom: 1px solid #1f2937; padding-bottom: 0.25rem; }
.markdown-body :deep(h3) { font-size: 1rem; }
.markdown-body :deep(p) { margin: 0.5rem 0; line-height: 1.6; color: #d1d5db; }
.markdown-body :deep(ul),
.markdown-body :deep(ol) { margin: 0.5rem 0 0.5rem 1.25rem; }
.markdown-body :deep(ul) { list-style: disc; }
.markdown-body :deep(ol) { list-style: decimal; }
.markdown-body :deep(li) { margin: 0.2rem 0; color: #d1d5db; }
.markdown-body :deep(strong) { color: #f3f4f6; font-weight: 700; }
.markdown-body :deep(code) { background: #111827; padding: 0.1rem 0.3rem; border-radius: 4px; font-size: 0.85em; }
.markdown-body :deep(a) { color: #818cf8; text-decoration: underline; }
.markdown-body :deep(table) { width: 100%; border-collapse: collapse; margin: 0.75rem 0; font-size: 0.85rem; }
.markdown-body :deep(th),
.markdown-body :deep(td) { border: 1px solid #1f2937; padding: 0.4rem 0.6rem; text-align: left; }
.markdown-body :deep(th) { background: #111827; color: #c7d2fe; }
.markdown-body :deep(hr) { border: none; border-top: 1px solid #1f2937; margin: 1rem 0; }
</style>
