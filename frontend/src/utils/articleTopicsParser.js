/**
 * Парсер markdown-отчётов Article Topics Forecaster.
 *
 * Промпты (`backend/src/prompts/articleTopics/main.txt` и `deepDive.txt`)
 * жёстко задают структуру результата:
 *
 *   • main      — секции «## Фаза N. ...» + финальный «## Strategic Action Plan»
 *                 с подзаголовками «### ДЕЙСТВИЕ N — ...».
 *                 Тренды лежат в markdown-таблице внутри секции «Фаза 2.
 *                 Emerging Trend Identification».
 *   • deep_dive — четыре секции «## 1. ...», «## 2. ...», «## 3. ...», «## 4. ...».
 *                 Hub & Spoke — таблица в секции 2; «Быстрая победа» —
 *                 список с meta-полями в секции 4.
 *
 * На основе этой структуры мы режем текст на блоки, парсим markdown-таблицы
 * и извлекаем список трендов для UI-кнопок «Углубить этот тренд». Парсер
 * толерантен к небольшим отклонениям (лишние пустые строки, кавычки вокруг
 * имени тренда, разный регистр заголовка), но не пытается понимать произвольный
 * markdown — это намеренно: при существенном сломе формата UI просто покажет
 * исходный markdown как fallback.
 */

// ── Markdown-таблица ───────────────────────────────────────────────────
//
// Распознаём блок строк, начинающихся с «|». Вторая строка — разделитель
// «| --- | --- |» (опционально, мы её просто пропускаем, если она похожа
// на разделитель). Возвращаем `{ headers: string[], rows: string[][] }`
// или null, если таблицу собрать не удалось.

function _splitTableRow(line) {
  // Срезаем краевые «|», затем split по «|». Не делаем escape сложного
  // markdown внутри ячеек — модели возвращают plain текст в ячейках.
  let s = line.trim();
  if (s.startsWith('|')) s = s.slice(1);
  if (s.endsWith('|'))   s = s.slice(0, -1);
  return s.split('|').map((c) => c.trim());
}

function _isSeparatorRow(cells) {
  if (!cells.length) return false;
  return cells.every((c) => /^:?-{2,}:?$/.test(c.replace(/\s+/g, '')));
}

/**
 * Парсит первую markdown-таблицу в блоке текста.
 * Возвращает `{ headers, rows, raw }` или null.
 */
export function parseFirstMarkdownTable(text) {
  const lines = String(text || '').split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i].trim().startsWith('|')) { start = i; break; }
  }
  if (start === -1) return null;

  const tableLines = [];
  for (let i = start; i < lines.length; i += 1) {
    if (!lines[i].trim().startsWith('|')) break;
    tableLines.push(lines[i]);
  }
  if (tableLines.length < 2) return null;

  const headerCells = _splitTableRow(tableLines[0]);
  let rowStart = 1;
  if (tableLines[1] && _isSeparatorRow(_splitTableRow(tableLines[1]))) {
    rowStart = 2;
  }
  const rows = [];
  for (let i = rowStart; i < tableLines.length; i += 1) {
    const cells = _splitTableRow(tableLines[i]);
    if (cells.length === 0 || cells.every((c) => !c)) continue;
    rows.push(cells);
  }
  if (!rows.length) return null;
  return { headers: headerCells, rows, raw: tableLines.join('\n') };
}

// ── Разбиение отчёта на секции по заголовкам «## ...» ─────────────────

/**
 * Делит markdown на верхнеуровневые секции «## ...».
 * Текст до первой «##» возвращается как preamble (может быть пустым).
 * Каждая секция: { title, body, level: 2 }.
 */
export function splitByH2(md) {
  const text = String(md || '');
  const lines = text.split('\n');
  const sections = [];
  let preamble = [];
  let cur = null;

  for (const line of lines) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m && !line.startsWith('###')) {
      if (cur) sections.push(cur);
      cur = { title: m[1].trim(), body: '', _lines: [], level: 2 };
    } else if (cur) {
      cur._lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (cur) sections.push(cur);

  for (const s of sections) {
    s.body = (s._lines || []).join('\n').replace(/^\n+|\n+$/g, '');
    delete s._lines;
  }
  return {
    preamble: preamble.join('\n').replace(/^\n+|\n+$/g, ''),
    sections,
  };
}

/**
 * Делит секцию на под-секции «### ...». Используется для Strategic Action Plan
 * (### ДЕЙСТВИЕ 1, 2, 3) и других мест, где есть осмысленный третий уровень.
 */
export function splitByH3(body) {
  const lines = String(body || '').split('\n');
  const subs = [];
  let preamble = [];
  let cur = null;
  for (const line of lines) {
    const m = /^###\s+(.+?)\s*$/.exec(line);
    if (m) {
      if (cur) subs.push(cur);
      cur = { title: m[1].trim(), body: '', _lines: [], level: 3 };
    } else if (cur) {
      cur._lines.push(line);
    } else {
      preamble.push(line);
    }
  }
  if (cur) subs.push(cur);
  for (const s of subs) {
    s.body = (s._lines || []).join('\n').replace(/^\n+|\n+$/g, '');
    delete s._lines;
  }
  return { preamble: preamble.join('\n').replace(/^\n+|\n+$/g, ''), subs };
}

// ── Эвристики для распознавания нужных секций ─────────────────────────

const PHASE_KEYWORDS = {
  signals:        /(фаза\s*1|weak\s*signal)/i,
  trends:         /(фаза\s*2(?!\.5)|emerging\s*trend)/i,
  blindSpots:     /(фаза\s*2\.5|blind\s*spot|слепые\s*зон)/i,
  futureSearch:   /(фаза\s*3|future\s*search|topic\s*cluster|прогноз.*sero|поисков)/i,
  lifecycle:      /(фаза\s*4|lifecycle|жизненн)/i,
  disruption:     /(фаза\s*5(?!b)|disruption|serp|угроз)/i,
  yandex:         /(фаза\s*5b|яндекс-?экосистем|яндекс\s*$)/i,
  metaTrends:     /(фаза\s*6|meta-?trend|мета-?тренд)/i,
  actionPlan:     /(strategic\s*action\s*plan|финальный|action\s*plan)/i,
};

function _classifyMainSection(title) {
  for (const [key, re] of Object.entries(PHASE_KEYWORDS)) {
    if (re.test(title)) return key;
  }
  return 'other';
}

/**
 * Извлекает список трендов из таблицы Фазы 2.
 *
 * Возвращает массив `{ name, drivers, stage, vector, signals, raw }`.
 * Если первый столбец таблицы — это «#» / порядковый номер, имя берём
 * из второго. Имя очищаем от лишних кавычек/звёздочек, чтобы кнопка
 * «Углубить» получала чистое значение.
 */
export function extractTrendsFromMain(md) {
  const { sections } = splitByH2(md);
  const trendSection = sections.find((s) => _classifyMainSection(s.title) === 'trends');
  if (!trendSection) return [];
  const table = parseFirstMarkdownTable(trendSection.body);
  if (!table) return [];

  // Определяем индекс столбца с именем тренда. По промпту это первый
  // столбец «Название тренда», но если модель добавила «#» — сдвигаем.
  let nameIdx = 0;
  const firstHeader = (table.headers[0] || '').toLowerCase();
  if (/^#$|^№$|^номер/.test(firstHeader.trim())) nameIdx = 1;
  // На всякий случай: если в первом столбце все значения — короткие числа,
  // тоже сдвигаемся.
  if (nameIdx === 0 && table.rows.every((r) => /^\s*\d+\s*$/.test(r[0] || ''))) {
    nameIdx = 1;
  }

  // Срезаем markdown-обёртки имени тренда: **жирный**, *курсив*, `code`,
  // кавычки/тире вокруг. Промпт не запрещает модели подчёркивать имя
  // тренда жирным — а в кнопке «Углубить» нам нужна чистая строка.
  const cleanName = (s) => {
    let v = String(s || '').trim();
    // Снимаем парные **...** / *...* / `...` / "..." / «...» обёртки.
    for (let i = 0; i < 3; i += 1) {
      const before = v;
      v = v.replace(/^\*\*(.+)\*\*$/, '$1')
           .replace(/^\*(.+)\*$/, '$1')
           .replace(/^`(.+)`$/, '$1')
           .replace(/^"(.+)"$/, '$1')
           .replace(/^«(.+)»$/, '$1')
           .replace(/^'(.+)'$/, '$1')
           .trim();
      if (v === before) break;
    }
    return v.replace(/\s+/g, ' ').trim();
  };

  const trends = [];
  for (const row of table.rows) {
    const name = cleanName(row[nameIdx]);
    if (!name) continue;
    trends.push({
      name,
      drivers:  row[nameIdx + 1] || '',
      stage:    row[nameIdx + 2] || '',
      vector:   row[nameIdx + 3] || '',
      signals:  row[nameIdx + 4] || '',
      raw:      row.join(' | '),
    });
  }
  return trends;
}

// ── Парсинг main-результата целиком ───────────────────────────────────

// Sentinel-маркеры машинно-читаемого блока трендов. Промпт `main.txt`
// просит модель оборачивать TRENDS_JSON в HTML-комментарии. Мы их вырезаем
// перед рендером, чтобы в «структурном» виде юзер не видел JSON-сырьё.
const TRENDS_JSON_SENTINEL_RE =
  /<!--\s*TRENDS_JSON_START\s*-->[\s\S]*?<!--\s*TRENDS_JSON_END\s*-->/i;

/**
 * Удаляет TRENDS_JSON-блок из markdown (для рендера).
 */
export function stripTrendsJsonBlock(md) {
  return String(md || '').replace(TRENDS_JSON_SENTINEL_RE, '').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * Объединяет тренды из таблицы Фазы 2 (надёжный fallback) с
 * `trendsJsonFromBackend` (более точные имена + confidence + stage от модели).
 *
 * Контракт:
 *   - Если `trendsJsonFromBackend.trends` присутствует и непустой — используем
 *     его как основной источник (порядок, название, confidence, stage).
 *     Дополнительно подтягиваем поля `drivers`/`vector` из табличного парсера
 *     там, где имена совпадают по нормализованному виду.
 *   - Иначе используем только табличный парсер.
 */
function _normalizeForMatch(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[*_`«»"']+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function _mergeTrends(tableTrends, backendTrendsJson) {
  const arr = (backendTrendsJson && Array.isArray(backendTrendsJson.trends))
    ? backendTrendsJson.trends
    : null;
  if (!arr || !arr.length) {
    return tableTrends.map((t) => ({ ...t, source: 'table' }));
  }
  // Индексируем табличные тренды для быстрого lookup.
  const tableByNorm = new Map();
  for (const t of tableTrends) tableByNorm.set(_normalizeForMatch(t.name), t);

  return arr.map((bt) => {
    const norm = _normalizeForMatch(bt.name);
    const fallback = tableByNorm.get(norm) || {};
    const drivers = Array.isArray(bt.drivers) && bt.drivers.length
      ? bt.drivers.join(', ')
      : (fallback.drivers || '');
    return {
      name:       String(bt.name || '').trim(),
      drivers,
      stage:      bt.stage      || fallback.stage  || '',
      vector:     bt.vector     || fallback.vector || '',
      signals:    Array.isArray(bt.signal_ids) && bt.signal_ids.length
        ? bt.signal_ids.join(', ')
        : (fallback.signals || ''),
      confidence: bt.confidence || null,                 // low | medium | high
      competitorCoverage: bt.competitor_coverage || null,// none | partial | covered
      windowMonths:        bt.window_months || 0,
      raw:        bt.name,
      source:     'json',
    };
  });
}

/**
 * Готовит main-результат к красивому рендеру:
 *   { preamble, sections: [{ kind, title, body, table?, subs? }],
 *     trends: [...], hasTrendsJson: bool }
 *
 * `kind` — один из ключей PHASE_KEYWORDS (или 'other'); используется в UI,
 * чтобы выбрать иконку/акцент для секции и понять, в какой секции таблица.
 * `subs` заполняется только для actionPlan (### ДЕЙСТВИЕ N).
 *
 * `trendsJsonFromBackend` (опционально) — объект `{ trends, signals_count,
 * ru_cis_block_present }`, который backend распарсил из TRENDS_JSON-блока
 * в pipeline и сохранил в `task.trends_json`. Если передан — используется
 * как primary источник трендов (с confidence-бейджами в UI).
 */
export function parseMainResult(md, trendsJsonFromBackend = null) {
  const cleanMd = stripTrendsJsonBlock(md);
  const { preamble, sections } = splitByH2(cleanMd);
  const enriched = sections.map((s) => {
    const kind = _classifyMainSection(s.title);
    const table = parseFirstMarkdownTable(s.body);
    let subs = null;
    if (kind === 'actionPlan') {
      const split = splitByH3(s.body);
      if (split.subs.length) subs = split.subs;
    }
    return { kind, title: s.title, body: s.body, table, subs };
  });
  const tableTrends = extractTrendsFromMain(cleanMd);
  const trends = _mergeTrends(tableTrends, trendsJsonFromBackend);
  return {
    preamble,
    sections: enriched,
    trends,
    hasTrendsJson: !!(trendsJsonFromBackend && Array.isArray(trendsJsonFromBackend.trends) && trendsJsonFromBackend.trends.length),
  };
}

// ── Парсинг deep-dive результата ──────────────────────────────────────

const DEEPDIVE_KEYWORDS = {
  currentState:  /^(\s*0[\.\)]|\s*##\s*0)|состояние\s*тренда|current\s*state/i,
  semanticCore:  /^(\s*1[\.\)]|\s*##\s*1)|семантическ|семантика|long[-\s]?tail/i,
  hubAndSpoke:   /^(\s*2[\.\)]|\s*##\s*2)|hub\s*&?\s*spoke|архитектур|pillar/i,
  competitorGap: /^(\s*3[\.\)]|\s*##\s*3)|конкурентн|gap|пробел/i,
  quickWin:      /^(\s*4[\.\)]|\s*##\s*4)|быстр(ая|ой|ое)\s*победа|quick\s*win/i,
};

function _classifyDeepSection(title) {
  for (const [key, re] of Object.entries(DEEPDIVE_KEYWORDS)) {
    if (re.test(title)) return key;
  }
  return 'other';
}

export function parseDeepDiveResult(md) {
  const cleanMd = stripTrendsJsonBlock(md);
  const { preamble, sections } = splitByH2(cleanMd);
  const enriched = sections.map((s) => {
    const kind = _classifyDeepSection(s.title);
    const table = parseFirstMarkdownTable(s.body);
    return { kind, title: s.title, body: s.body, table };
  });
  return { preamble, sections: enriched };
}

// ── Лёгкий рендер inline-markdown ──────────────────────────────────────
//
// Полноценный markdown-парсер тут избыточен (и тащить новую зависимость
// ради одной страницы — оверкилл). Прометы используют только: заголовки
// (### уже разрезаны выше), параграфы, списки «- »/«* »/«1. », жирный
// **текст**, инлайн-код `…` и обычные ссылки [text](url). Для всего
// остального откатываемся на whitespace-pre-wrap.
//
// !!! Все пользовательские строки прогоняем через escapeHtml ДО подстановки
// markdown-токенов, чтобы избежать XSS из ответа модели (модель технически
// может вернуть `<script>`).

export function escapeHtml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function _renderInline(text) {
  let s = escapeHtml(text);
  // Жирный
  s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
  // Инлайн-код
  s = s.replace(/`([^`\n]+)`/g, '<code class="px-1 py-0.5 rounded bg-gray-800 text-indigo-200 text-[0.85em]">$1</code>');
  // Простые ссылки [text](http(s)://...) — допускаем только http/https/mailto.
  // Дополнительно запрещаем в URL кавычки/угловые скобки/пробелы, чтобы даже
  // в случае передачи специально подобранной (уже HTML-эскейпленной выше)
  // строки нельзя было сломать href-атрибут или вставить onmouseover-handler.
  s = s.replace(/\[([^\]]+)\]\((https?:\/\/[^\s"'<>)]+|mailto:[^\s"'<>)]+)\)/g,
    '<a href="$2" target="_blank" rel="noopener noreferrer" class="text-indigo-300 underline hover:text-indigo-200">$1</a>');
  return s;
}

/**
 * Рендерит markdown-блок (без заголовков ## / ### и без таблиц — те
 * вырезает вызывающий код) в безопасный HTML.
 */
export function renderInlineMarkdown(md) {
  const text = String(md || '').trim();
  if (!text) return '';
  const lines = text.split('\n');
  const out = [];
  let listType = null;        // 'ul' | 'ol' | null
  let paraBuf = [];

  const flushPara = () => {
    if (paraBuf.length) {
      out.push(`<p class="text-sm text-gray-200 leading-relaxed">${_renderInline(paraBuf.join(' '))}</p>`);
      paraBuf = [];
    }
  };
  const flushList = () => {
    if (listType) {
      out.push(`</${listType}>`);
      listType = null;
    }
  };

  for (let raw of lines) {
    const line = raw.replace(/\s+$/, '');
    if (!line.trim()) {
      flushPara();
      flushList();
      continue;
    }
    // Пропускаем markdown-таблицы — должны быть вырезаны заранее, но на
    // всякий случай не ломаем рендер.
    if (line.trim().startsWith('|')) continue;

    const ulMatch = /^\s*[-*]\s+(.*)$/.exec(line);
    const olMatch = /^\s*\d+[\.\)]\s+(.*)$/.exec(line);
    if (ulMatch || olMatch) {
      flushPara();
      const wantType = ulMatch ? 'ul' : 'ol';
      if (listType !== wantType) {
        flushList();
        const cls = wantType === 'ul'
          ? 'list-disc list-inside space-y-1 text-sm text-gray-200'
          : 'list-decimal list-inside space-y-1 text-sm text-gray-200';
        out.push(`<${wantType} class="${cls}">`);
        listType = wantType;
      }
      const content = (ulMatch ? ulMatch[1] : olMatch[1]).trim();
      out.push(`<li>${_renderInline(content)}</li>`);
      continue;
    }

    // Обычная строка — собираем в параграф.
    flushList();
    paraBuf.push(line.trim());
  }
  flushPara();
  flushList();
  return out.join('\n');
}

// ── Хелперы копирования секций как plain text ─────────────────────────

/**
 * Возвращает чистый текст без markdown-таблиц/жирного/кода — пригодный
 * для вставки в чат, документ или почту. Markdown-таблицы конвертируем
 * в выровненный plain-text.
 */
export function sectionToPlainText(section) {
  if (!section) return '';
  const out = [];
  if (section.title) out.push(section.title.toUpperCase());
  out.push('');

  // Тело без таблицы (если она была вырезана для отдельного рендера) и
  // без под-секций ### — они печатаются ниже отдельным блоком.
  let bodyWithoutTable = section.body || '';
  if (section.table && section.table.raw) {
    bodyWithoutTable = bodyWithoutTable.replace(section.table.raw, '');
  }
  if (section.subs && section.subs.length) {
    // Отрезаем всё, начиная с первого ### — оно дублируется через subs.
    const idx = bodyWithoutTable.search(/^\s*###\s+/m);
    if (idx >= 0) bodyWithoutTable = bodyWithoutTable.slice(0, idx);
  }
  bodyWithoutTable = bodyWithoutTable.replace(/\n{3,}/g, '\n\n').trim();

  if (bodyWithoutTable) {
    out.push(_stripMarkdown(bodyWithoutTable));
    out.push('');
  }

  if (section.table) {
    out.push(_tableToPlainText(section.table));
    out.push('');
  }

  if (section.subs && section.subs.length) {
    for (const sub of section.subs) {
      out.push(`— ${sub.title} —`);
      out.push(_stripMarkdown(sub.body));
      out.push('');
    }
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

function _stripMarkdown(s) {
  return String(s || '')
    .replace(/^\s*[#]+\s+/gm, '')        // ### заголовки
    .replace(/\*\*([^*]+)\*\*/g, '$1')   // bold
    .replace(/`([^`]+)`/g, '$1')         // inline code
    .replace(/^\s*[-*]\s+/gm, '• ')      // bullet
    .trim();
}

function _tableToPlainText(table) {
  if (!table || !table.headers) return '';
  const clean = (v) => _stripMarkdown(String(v || ''));
  const headers = table.headers.map(clean);
  const rows    = table.rows.map((r) => r.map(clean));
  const widths = headers.map((h, i) => {
    let w = h.length;
    for (const r of rows) {
      const v = r[i] || '';
      if (v.length > w) w = v.length;
    }
    return Math.min(w, 60); // ограничиваем, чтобы plain-text не разъезжался
  });
  const fmt = (cells) => cells
    .map((c, i) => String(c || '').slice(0, widths[i]).padEnd(widths[i]))
    .join('  ');
  const lines = [];
  lines.push(fmt(headers));
  lines.push(widths.map((w) => '-'.repeat(w)).join('  '));
  for (const r of rows) lines.push(fmt(r));
  return lines.join('\n');
}
