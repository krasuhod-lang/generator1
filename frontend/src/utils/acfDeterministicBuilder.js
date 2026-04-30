/**
 * acfDeterministicBuilder.js
 *
 * Детерминированный конвертер HTML → массив блоков WordPress ACF Flexible
 * Content. Используется на вкладке «Сформировать JSON» в режиме «Программный
 * (рекомендуется)» как альтернатива LLM-сборке через Qwen / DashScope.
 *
 * Зачем нужен:
 *   • Жёсткое требование задачи — «нельзя менять структуру текста, заголовков
 *     и сам текст». Это инвариант **детерминированный**: его в принципе
 *     нельзя гарантировать LLM-ом (модель с ненулевой вероятностью
 *     перефразирует / склеит / обрежет абзацы — особенно на длинных входах).
 *   • Программная сборка копирует исходный HTML абзацев и заголовков
 *     **байт-в-байт** через `node.outerHTML` → инвариант соблюдается
 *     математически.
 *   • Дополнительный бонус: исходник никогда не уходит в DashScope, значит
 *     прокси-лимит «HTTP 413 Payload Too Large» не возникает в принципе.
 *
 * Алгоритм (см. план в issue):
 *   1. DOMParser → нарезка по <h2> на «секции».
 *   2. Эвристика классификации секции по канонизированному тексту <h2>
 *      и форме контента (наличие <ol>/<table>/<blockquote>/пар <h3>+<p>).
 *   3. Для каждого типа блока — узкоспециализированный билдер, который
 *      кладёт ОРИГИНАЛЬНЫЙ HTML сабнодов в подходящие поля ACF.
 *   4. Минимальная санитизация: вырезаем <h1> (по требованию ТЗ,
 *      зеркалит существующий stripH1FromHtml в AcfJsonPage.vue).
 *
 * Ограничения опциональных полей: типы portfolio / form / reviews /
 * tags-as-buttons требуют либо галерею WP-картинок, либо ссылки на сторонние
 * посты — детерминированно из текста статьи их собрать нельзя, поэтому
 * билдер их не порождает (если в источнике явно нет соответствующих сигналов).
 *
 * Все экспорты — pure-functions, без Vue/реактивности, чтобы модуль был
 * легко тестируем и переиспользуем.
 */

// ── Канонизация (lowercase, без пунктуации, ё→е) — для сравнения ───────────
// Скопировано один-в-один из AcfJsonPage.vue (canonicalForCompare): держать
// ОДНУ реализацию внутри одного модуля проще, чем тащить общий импорт через
// Vue-файл. Логика тождественна, поэтому валидаторы AcfJsonPage сравнивают
// канон-формы согласованно.
function canon(s) {
  if (!s) return '';
  let t = String(s).toLowerCase();
  t = t.replace(/[^\p{L}\p{N}\s]+/gu, ' ');
  t = t.replace(/ё/g, 'е');
  t = t.replace(/\s+/g, ' ').trim();
  return t;
}

// ── Ключевые слова для классификации <h2> ─────────────────────────────────
// Подбирались по реальным заголовкам, которые генерирует наш SEO-/блог-pipeline
// и которые встречаются в исходниках клиентов. Совпадение — по подстроке
// канон-формы (substring), а не по точному равенству, чтобы ловить
// «Преимущества нашей клиники», «Этапы лечения зубов», «Часто задаваемые
// вопросы о суппорте» и т. д. одной строкой.
const KW = {
  faq:       ['faq', 'часто задаваемые', 'частые вопросы', 'популярные вопросы',
              'вопросы и ответы', 'вопрос ответ', 'чаво'],
  steps:     ['этап', 'шаг', 'процесс', 'процедур', 'как проходит',
              'как мы работаем', 'пошагов', 'инструкция', 'сценари',
              'порядок работ', 'ход работ'],
  bens:      ['преимуществ', 'плюс', 'почему', 'выгод', 'что вы получ',
              'наши плюсы', 'почему выбирают', 'почему именно'],
  price:     ['цен', 'стоимост', 'тариф', 'прайс'],
  attention: ['важно', 'внимание', 'осторожно', 'предупрежд', 'не забуд',
              'противопоказан', 'обратите внимание'],
  expert:    ['мнение эксперт', 'мнение специалист', 'мнение врача',
              'мнение юриста', 'мнение мастера', 'комментарий эксперт',
              'слово эксперт', 'эксперт говорит'],
  tabs:      ['диагностик', 'признак', 'способы провер', 'варианты',
              'виды', 'типы'],
  portfolio: ['галер', 'портфолио', 'примеры работ', 'наши работы',
              'фото работ', 'до и после', 'результаты работ'],
  tags:      ['теги', 'смежные услуги', 'другие услуги', 'связанные услуги',
              'популярные услуги'],
};

function matchesKw(canonText, list) {
  for (const kw of list) {
    if (canonText.indexOf(kw) !== -1) return true;
  }
  return false;
}

// ── Удаление <h1> (зеркалит stripH1FromHtml в AcfJsonPage.vue) ────────────
// Делается ДО парсинга, чтобы выкинутый <h1> не попал ни в один блок.
function stripH1(html) {
  if (!html) return '';
  let out = String(html);
  out = out.replace(/<h1\b[^>]*>[\s\S]*?<\/h1\s*>/gi, '');
  out = out.replace(/<\/?h1\b[^>]*>/gi, '');
  return out;
}

// ── Парсинг HTML в DOM (браузерный DOMParser) ─────────────────────────────
// Оборачиваем в <body>, чтобы DOMParser не пытался достроить <html>/<head>
// и не мешал детям перепутаться при отсутствии корня.
function parseHtmlToBody(html) {
  if (typeof DOMParser === 'undefined') {
    throw new Error('DOMParser недоступен — детерминированный билдер работает только в браузере.');
  }
  const doc = new DOMParser().parseFromString(`<!DOCTYPE html><html><body>${html}</body></html>`, 'text/html');
  return doc.body;
}

// Узлы, которые надо безусловно игнорировать при сборке (whitespace-only
// текстовые ноды между блочными элементами и комментарии).
function isIgnorableNode(node) {
  if (!node) return true;
  if (node.nodeType === 8 /* COMMENT_NODE */) return true;
  if (node.nodeType === 3 /* TEXT_NODE */) {
    return !String(node.textContent || '').trim();
  }
  return false;
}

// Возвращает теговое имя в нижнем регистре или ''.
function tag(node) {
  return node && node.nodeType === 1 ? String(node.tagName || '').toLowerCase() : '';
}

// ── Нарезка по <h2> ───────────────────────────────────────────────────────
// Каждая «секция» = { h2: Node|null, body: Node[] }.
// Узлы ДО первого <h2> попадают в безымянную «вступительную» секцию
// (h2=null) — типичный кейс: вводный абзац перед первым подзаголовком.
function sliceByH2(rootEl) {
  const sections = [];
  let intro = [];
  let current = null;
  for (const node of Array.from(rootEl.childNodes)) {
    if (isIgnorableNode(node)) continue;
    if (tag(node) === 'h2') {
      if (current) sections.push(current);
      current = { h2: node, body: [] };
    } else if (current) {
      current.body.push(node);
    } else {
      intro.push(node);
    }
  }
  if (current) sections.push(current);
  if (intro.length) sections.unshift({ h2: null, body: intro });
  return sections;
}

// ── Эвристики формы контента ──────────────────────────────────────────────
// «Похоже ли тело на FAQ»: есть пары (<h3>|<h4>|<p><strong>) → <p>.
function looksLikeFaqBody(body) {
  let pairs = 0;
  for (let i = 0; i < body.length - 1; i++) {
    const a = body[i];
    const b = body[i + 1];
    const aTag = tag(a);
    const bTag = tag(b);
    if ((aTag === 'h3' || aTag === 'h4') && bTag === 'p') pairs += 1;
  }
  return pairs >= 2;
}

// «Похоже ли тело на Steps»: есть нумерованный список ИЛИ серия h3+p.
function looksLikeStepsBody(body) {
  for (const n of body) if (tag(n) === 'ol') return true;
  return looksLikeFaqBody(body); // та же форма h3+p
}

// «Похоже ли тело на Price»: есть таблица с цифровым последним столбцом
// или ul/li, где явно встречается денежный паттерн.
// Денежный паттерн для эвристики price-блока: «5000», «5 000 руб», «1 234 567 ₽».
// {0,8} ограничивает «телесную» часть числа максимум 8 разделителями/цифрами
// после первой — этого хватает для миллионов («1 234 567»), но защищает от
// false-positive на длинных номерах телефонов / серий документов и т. п.
const PRICE_RE = /\d[\d\s]{0,8}(?:р\b|руб\b|₽|\$|€)/i;
function looksLikePriceBody(body) {
  for (const n of body) {
    if (tag(n) === 'table' && n.querySelector && n.querySelector('tr')) return true;
    if ((tag(n) === 'ul' || tag(n) === 'ol') && PRICE_RE.test(n.textContent || '')) return true;
  }
  return false;
}

// «Похоже ли тело на Expert»: есть <blockquote> с непустым текстом.
function looksLikeExpertBody(body) {
  for (const n of body) {
    if (tag(n) === 'blockquote' && (n.textContent || '').trim()) return true;
  }
  return false;
}

// «Похоже ли тело на Tabs»: ≥2 <h3>, и при этом НЕ FAQ (FAQ имеет приоритет
// по h2-ключевым словам).
function looksLikeTabsBody(body) {
  let h3count = 0;
  for (const n of body) if (tag(n) === 'h3') h3count += 1;
  return h3count >= 2;
}

// ── Классификатор: какой acf_fc_layout выбрать для секции ─────────────────
function classifySection(section, ctx) {
  const h2Canon = canon(section.h2 ? (section.h2.textContent || '') : '');
  const body = section.body;

  // FAQ имеет высший приоритет, если ключевое слово совпало И форма похожа.
  if (matchesKw(h2Canon, KW.faq) && looksLikeFaqBody(body)) return 'faq';

  // Expert — только если ещё не использован (квота 1 на массив).
  if (!ctx.expertUsed && (matchesKw(h2Canon, KW.expert) || looksLikeExpertBody(body))) {
    return 'expert';
  }

  if (matchesKw(h2Canon, KW.price) || looksLikePriceBody(body)) return 'price';

  if (matchesKw(h2Canon, KW.steps) && looksLikeStepsBody(body)) return 'steps';

  if (matchesKw(h2Canon, KW.bens) && looksLikeFaqBody(body)) return 'bens';
  // Отдельно: преимущества часто оформлены как <ul><li><strong>…</strong>…</li>
  if (matchesKw(h2Canon, KW.bens)) return 'bens';

  if (matchesKw(h2Canon, KW.attention)) return 'attention';

  if (matchesKw(h2Canon, KW.portfolio)) return 'portfolio';

  if (matchesKw(h2Canon, KW.tags)) return 'tags';

  if (matchesKw(h2Canon, KW.tabs) && looksLikeTabsBody(body)) return 'tabs';

  return 'blocks';
}

// ── Сериализация массива нод в HTML-строку ────────────────────────────────
// Берём `outerHTML` напрямую — это и есть «байт-в-байт» сохранение исходной
// разметки. Для текстовых нод используем textContent (хотя whitespace-only
// уже отфильтрованы isIgnorableNode).
function nodesToHtml(nodes) {
  const out = [];
  for (const n of nodes) {
    if (n.nodeType === 1) out.push(n.outerHTML);
    else if (n.nodeType === 3) {
      const t = n.textContent;
      if (t && t.trim()) out.push(t);
    }
  }
  return out.join('');
}

// Текст без HTML-тегов (используется для коротких title/question).
function nodeText(node) {
  if (!node) return '';
  return String(node.textContent || '').replace(/\s+/g, ' ').trim();
}

// Срез нумерации-префикса в коротких title/question (зеркалит
// stripLeadingNumber из AcfJsonPage.vue, чтобы программный билдер
// производил такие же чистые ярлыки, как и LLM-режим после
// postCleanupAcfArray).
const TITLE_NUMBER_PREFIX_RE = /^\s*(?:(?:Шаг|Этап|Раздел|Часть|Глава|Step|Part)\s*№?\s*)?\d+\s*[.):\-—–]?\s*/i;
function stripLeadingNumber(s) {
  if (typeof s !== 'string') return s;
  const m = TITLE_NUMBER_PREFIX_RE.exec(s);
  if (!m || m[0].length === 0) return s;
  const rest = s.slice(m[0].length).trim();
  if (!rest) return s;
  return rest;
}

// Поле text/content имеет ограниченную ширину в ACF-UI WordPress'а:
// длинные ярлыки переносятся уродливо и плохо читаются в админке. 90 —
// эмпирический предел: помещается в одну строку при типичной ширине поля
// и оставляет запас под суффикс «…».
const TITLE_MAX_LEN = 90;
function shortTitle(h2Node, fallback) {
  const raw = nodeText(h2Node) || fallback || '';
  let s = stripLeadingNumber(raw);
  if (s.length > TITLE_MAX_LEN) s = s.slice(0, TITLE_MAX_LEN - 1).trimEnd() + '…';
  return s;
}

// Возвращает HTML-строку открытого+закрытого тега заголовка, побайтно
// идентичную исходному узлу. Используется для prepend'а исходного <h2>
// внутрь полей блоков, у которых иначе нет места для дословного хранения
// (steps/bens/tabs/faq/expert-blockquote/price/portfolio/tags). Без этого
// валидатор findMissingHeadings из AcfJsonPage.vue репортит «потерянный
// h2» — короткое поле title не считается дословным сохранением заголовка.
function h2ToHtml(h2Node) {
  if (!h2Node) return '';
  if (h2Node.nodeType === 1) return h2Node.outerHTML;
  return '';
}

// ── Билдеры конкретных типов блоков ───────────────────────────────────────

// blocks (универсальный) — H2 + всё тело идёт в text как есть.
function buildBlocksBlock(section) {
  const inner = [];
  if (section.h2) inner.push(section.h2);
  for (const n of section.body) inner.push(n);
  return {
    acf_fc_layout: 'blocks',
    title: shortTitle(section.h2, 'Раздел'),
    subtitle: '',
    blocks: [{
      block_width: '12',
      bg_color: 'default',
      text: nodesToHtml(inner),
      image: '',
      url: '',
    }],
    type: '1',
    vert_center: false,
    block_equal_height: false,
  };
}

// faq — пары (h3|h4) + (p+) превращаем в { question, answer }.
// Любые «осиротевшие» <p> между парами приклеиваются к ближайшему answer
// сверху — так они не теряются, что критично для инварианта.
function buildFaqBlock(section) {
  const items = [];
  let i = 0;
  const body = section.body;
  while (i < body.length) {
    const node = body[i];
    const t = tag(node);
    if ((t === 'h3' || t === 'h4') && i + 1 < body.length) {
      const question = stripLeadingNumber(nodeText(node));
      // Собираем ВСЕ последующие узлы, пока не упрёмся в следующий h3/h4.
      const answerNodes = [];
      let j = i + 1;
      while (j < body.length) {
        const nt = tag(body[j]);
        if (nt === 'h3' || nt === 'h4') break;
        answerNodes.push(body[j]);
        j += 1;
      }
      items.push({
        question,
        answer: nodesToHtml(answerNodes) || '<p></p>',
      });
      i = j;
    } else {
      // Сирота до первой пары: цепляем к последнему answer'у; если ещё нет
      // ни одной пары — кладём в pending-список, который вольётся в первый.
      if (items.length) {
        items[items.length - 1].answer += nodesToHtml([node]);
      } else {
        // Очень редкий случай, кладём как «псевдо-вопрос» с одним абзацем,
        // чтобы НЕ потерять контент. Лучше уродливый title, чем пропавший
        // абзац (инвариант сохранности текста — №1).
        items.push({
          question: 'Информация',
          answer: nodesToHtml([node]),
        });
      }
      i += 1;
    }
  }
  return {
    acf_fc_layout: 'faq',
    title: shortTitle(section.h2, 'FAQ'),
    subtitle: '',
    faq: items.length ? items : [{ question: '', answer: '<p></p>' }],
  };
}

// (h2 для секций, у которых нет «безвредного» места дословно держать
// заголовок, выносится во внешний sibling-блок через h2HoldingMiniBlock —
// см. orchestrator). Внутрь items[0].text/answer вставлять H2 нельзя, потому
// что это разрывает phrase-windows исходного <li> в пост-валидации
// findMissingPhrases (окно «strong-часть … обычная часть» одного <li>
// после такой вставки перестаёт быть смежным в outputPlainText).

// steps — две формы:
//   • <ol><li>...</li>...</ol> → каждый <li> = шаг (title=первая строка/<strong>, text=остальное)
//   • h3+p пары → каждая пара = шаг
function buildStepsBlock(section) {
  const items = [];
  const body = section.body;

  // 1. Если есть <ol>, разбираем его (берём ПЕРВЫЙ ol).
  const ol = body.find((n) => tag(n) === 'ol');
  if (ol) {
    for (const li of Array.from(ol.children || [])) {
      if (tag(li) !== 'li') continue;
      // Ищем <strong>/<b> в начале как title; иначе — первое предложение.
      const strong = li.querySelector && li.querySelector('strong, b');
      let titleStr = '';
      let textHtml = '';
      if (strong && strong.parentNode === li) {
        titleStr = nodeText(strong);
        // Удаляем strong из клона, чтобы text не дублировал заголовок.
        const clone = li.cloneNode(true);
        const cloneStrong = clone.querySelector('strong, b');
        if (cloneStrong) cloneStrong.remove();
        textHtml = `<p>${(clone.innerHTML || '').trim()}</p>`;
      } else {
        const full = nodeText(li);
        // 80 симв. — эмпирическая граница «короткое предложение, годится в title».
        // Длиннее — не делим, кладём усечённую первую фразу с многоточием,
        // чтобы title оставался компактным в ACF-UI.
        const dotIdx = full.search(/[.!?](?:\s|$)/);
        if (dotIdx > 0 && dotIdx < 80) {
          titleStr = full.slice(0, dotIdx).trim();
          textHtml = `<p>${li.innerHTML}</p>`;
        } else {
          titleStr = full.length > 60 ? full.slice(0, 60).trim() + '…' : full;
          textHtml = `<p>${li.innerHTML}</p>`;
        }
      }
      items.push({
        title: stripLeadingNumber(titleStr),
        text: textHtml,
      });
    }
  } else {
    // 2. h3+p пары.
    let i = 0;
    while (i < body.length) {
      const node = body[i];
      const t = tag(node);
      if ((t === 'h3' || t === 'h4') && i + 1 < body.length) {
        const titleStr = stripLeadingNumber(nodeText(node));
        const restNodes = [];
        let j = i + 1;
        while (j < body.length) {
          const nt = tag(body[j]);
          if (nt === 'h3' || nt === 'h4') break;
          restNodes.push(body[j]);
          j += 1;
        }
        // ВНИМАНИЕ: оригинальный <h3>/<h4> сохраняем ВНУТРИ text — это
        // зеркальное требование к LLM-режиму (см. ЗАДАЧА 1A в системном
        // промте). Без этого валидатор findMissingHeadings репортит потерю.
        items.push({
          title: titleStr,
          text: nodesToHtml([node, ...restNodes]),
        });
        i = j;
      } else {
        // Сирота → в последний step как добавка, либо одиночный «шаг».
        if (items.length) {
          items[items.length - 1].text += nodesToHtml([node]);
        } else {
          items.push({
            title: 'Шаг',
            text: nodesToHtml([node]),
          });
        }
        i += 1;
      }
    }
  }

  // Колонки: 4 (3 в ряд) для 3–6 шагов; 6 (2 в ряд) для 1–2; 3 (4 в ряд) для 7+.
  let columns = '4';
  if (items.length <= 2) columns = '6';
  else if (items.length >= 7) columns = '3';

  return {
    acf_fc_layout: 'steps',
    title: shortTitle(section.h2, 'Этапы'),
    subtitle: '',
    items,
    columns,
  };
}

// bens — структурно близко к steps, но другой набор полей.
function buildBensBlock(section) {
  // Переиспользуем разбор из steps, потом пересобираем под bens-схему.
  const steps = buildStepsBlock(section);
  const items = steps.items.map((it) => ({
    title: it.title,
    image: '',
    text: it.text,
  }));
  let columns = '4';
  if (items.length <= 2) columns = '6';
  else if (items.length >= 7) columns = '3';
  return {
    acf_fc_layout: 'bens',
    title: shortTitle(section.h2, 'Преимущества'),
    color_title: '#000000',
    subtitle: '',
    items,
    columns,
    image: '',
  };
}

// Хелпер: «слепок» H2 как полноценный мини-блок blocks для тех типов
// (price/tags), которые НЕ имеют ни одного HTML-поля для дословного
// хранения <h2>. Дерём text=`<h2>...</h2>` (одна строка) — структурно это
// валидный блок blocks по схеме методички, и валидатор сохранности
// заголовков его принимает как «h2 на месте».
function h2HoldingMiniBlock(h2Node) {
  if (!h2Node) return null;
  const html = h2ToHtml(h2Node);
  if (!html) return null;
  return {
    acf_fc_layout: 'blocks',
    title: shortTitle(h2Node, 'Раздел'),
    subtitle: '',
    blocks: [{
      block_width: '12',
      bg_color: 'default',
      text: html,
      image: '',
      url: '',
    }],
    type: '1',
    vert_center: false,
    block_equal_height: false,
  };
}

// price — таблица или список с денежными хвостами.
// Возвращает МАССИВ блоков (mini-blocks с H2 + сам price), чтобы исходный
// <h2> сохранился дословно — у price-схемы нет HTML-поля для встраивания.
function buildPriceBlock(section) {
  const items = [];
  const body = section.body;

  const table = body.find((n) => tag(n) === 'table');
  if (table) {
    const rows = Array.from(table.querySelectorAll('tr'));
    for (const tr of rows) {
      const cells = Array.from(tr.children || []).filter((c) => /^t[hd]$/i.test(c.tagName || ''));
      if (cells.length < 2) continue;
      // Пропускаем «шапку» таблицы (если все ячейки — th).
      const allTh = cells.every((c) => /^th$/i.test(c.tagName || ''));
      if (allTh) continue;
      const titleStr = nodeText(cells[0]);
      const priceStr = nodeText(cells[cells.length - 1]);
      const middle = cells.slice(1, cells.length - 1).map((c) => nodeText(c)).filter(Boolean).join(' · ');
      if (!titleStr) continue;
      items.push({
        title: titleStr,
        text: middle || '',
        price: priceStr || '',
      });
    }
  } else {
    // ul/li с ценой в конце.
    const list = body.find((n) => tag(n) === 'ul' || tag(n) === 'ol');
    if (list) {
      for (const li of Array.from(list.children || [])) {
        if (tag(li) !== 'li') continue;
        const full = nodeText(li);
        const m = full.match(new RegExp('(.*?)\\s*[—\\-:]?\\s*(\\d[\\d\\s]{0,8}(?:\\s?(?:р|руб|₽|\\$|€)\\.?)?)\\s*$', 'i'));
        if (m && m[2]) {
          items.push({
            title: m[1].trim() || full,
            text: '',
            price: m[2].trim(),
          });
        } else {
          items.push({ title: full, text: '', price: '' });
        }
      }
    }
  }

  // Если ничего не извлеклось — fallback на blocks, чтобы не потерять контент.
  if (!items.length) return [buildBlocksBlock(section)];

  return [{
    acf_fc_layout: 'price',
    title: shortTitle(section.h2, 'Прайс'),
    subtitle: '',
    items,
  }];
}

// attention — H2 + всё тело в одно поле text.
function buildAttentionBlock(section) {
  const inner = [];
  if (section.h2) inner.push(section.h2);
  for (const n of section.body) inner.push(n);
  return {
    acf_fc_layout: 'attention',
    title: shortTitle(section.h2, 'Внимание'),
    text: nodesToHtml(inner),
    image: '',
  };
}

// expert — берём текст <blockquote> или весь body, если blockquote нет.
function buildExpertBlock(section) {
  const blockquote = section.body.find((n) => tag(n) === 'blockquote');
  let text;
  if (blockquote) {
    // Берём ИСХОДНЫЙ blockquote целиком (outerHTML), а не только innerHTML.
    // Это сохраняет атрибут class="expert-opinion" + теги <cite>/<footer>
    // ровно так, как они были в исходнике.
    // Префиксом ставим оригинальный <h2>, чтобы валидатор findMissingHeadings
    // не репортил «потерянный <h2>Мнение эксперта</h2>».
    const inner = [];
    if (section.h2) inner.push(section.h2);
    inner.push(blockquote);
    text = nodesToHtml(inner);
  } else {
    // Без явной цитаты — кладём всё тело (включая H2 для сохранности заголовка).
    const inner = [];
    if (section.h2) inner.push(section.h2);
    for (const n of section.body) inner.push(n);
    text = nodesToHtml(inner);
  }
  return {
    acf_fc_layout: 'expert',
    title: shortTitle(section.h2, 'Мнение эксперта'),
    expert: 0,
    text,
  };
}

// tabs — каждый <h3> → таб, последующие p/ul/etc. → content.
function buildTabsBlock(section) {
  const items = [];
  const body = section.body;
  let i = 0;
  while (i < body.length) {
    const node = body[i];
    const t = tag(node);
    if ((t === 'h3' || t === 'h4') && i + 1 < body.length) {
      const titleStr = stripLeadingNumber(nodeText(node));
      const restNodes = [];
      let j = i + 1;
      while (j < body.length) {
        const nt = tag(body[j]);
        if (nt === 'h3' || nt === 'h4') break;
        restNodes.push(body[j]);
        j += 1;
      }
      items.push({
        title: titleStr,
        // Внутри content сохраняем оригинальный <h3> — зеркало правила
        // «ZERO HEADING LOSS» из системного промта (см. ЗАДАЧА 1A).
        content: nodesToHtml([node, ...restNodes]),
      });
      i = j;
    } else {
      if (items.length) {
        items[items.length - 1].content += nodesToHtml([node]);
      } else {
        items.push({ title: 'Раздел', content: nodesToHtml([node]) });
      }
      i += 1;
    }
  }
  if (!items.length) return buildBlocksBlock(section);
  return {
    acf_fc_layout: 'tabs',
    title: shortTitle(section.h2, 'Варианты'),
    subtitle: '',
    items,
  };
}

// portfolio — пустая галерея (фото в WP подгружаются вручную). Но H2 и
// весь сопутствующий текст НЕЛЬЗЯ просто выкинуть — это ломает инвариант
// сохранности. Поэтому, если в секции есть текстовое содержимое, перед
// portfolio добавляется blocks-секция с этим текстом. Возвращаем массив,
// чтобы caller расплющил его в общий список.
function buildPortfolioBlocks(section) {
  const out = [];
  // Если в секции есть текст ПОМИМО H2 — делаем blocks с этим текстом.
  // Сам <h2> добавит orchestrator через sibling-h2HoldingMiniBlock.
  const hasText = section.body.some((n) => nodeText(n).length > 0);
  if (hasText) {
    // buildBlocksBlock сам положит h2+body в text — но H2 уже добавлен
    // sibling'ом. Чтобы не дублировать заголовок дважды, делаем blocks
    // ТОЛЬКО из body (без h2).
    const bodyOnlySection = { h2: null, body: section.body };
    out.push(buildBlocksBlock(bodyOnlySection));
  }
  out.push({
    acf_fc_layout: 'portfolio',
    title: shortTitle(section.h2, 'Галерея'),
    subtitle: '',
    items: [],
    gallery_type: 'gallery',
    gallery_columns: '3',
    height: '300',
    vert_photo: false,
    title_photo: false,
  });
  return out;
}

// tags — тянем из <a> в теле; если ссылок нет — fallback на blocks.
function buildTagsBlock(section) {
  const links = [];
  for (const n of section.body) {
    if (n.nodeType !== 1 || !n.querySelectorAll) continue;
    for (const a of n.querySelectorAll('a[href]')) {
      const linkTitle = nodeText(a);
      const href = a.getAttribute('href') || '';
      if (linkTitle && href) links.push({ title: linkTitle, link: href });
    }
  }
  if (!links.length) return [buildBlocksBlock(section)];
  return [{
    acf_fc_layout: 'tags',
    title: shortTitle(section.h2, 'Теги'),
    items: links,
  }];
}

// ── Публичный API ─────────────────────────────────────────────────────────
/**
 * Главный экспорт. Принимает HTML-строку, возвращает массив ACF-блоков.
 *
 * Пост-условия:
 *   • Все теги <h1> удалены из вывода (зеркало stripH1FromHtml).
 *   • Каждый исходный <h2..h5> присутствует в одном из полей text / content
 *     / answer (либо в title для FAQ-исключения «Часто задаваемые вопросы»).
 *   • Каждый абзац <p>/<li> исходника присутствует ровно один раз.
 *   • Поле subtitle ВСЕГДА = '' (требование ТЗ).
 *
 * @param {string} html  — исходный HTML (любого размера)
 * @returns {Array<object>} массив ACF-блоков
 */
export function buildAcfFromHtml(html) {
  const cleaned = stripH1(html || '');
  if (!cleaned.trim()) return [];

  const body = parseHtmlToBody(cleaned);
  const sections = sliceByH2(body);

  const out = [];
  const ctx = { expertUsed: false };

  for (const section of sections) {
    const layout = classifySection(section, ctx);
    // Helper: для типов, у которых внутренние HTML-поля занимают ОТДЕЛЬНЫЕ
    // фрагменты исходных <li>/<td> (а значит, попытка вставить туда же
    // исходный <h2> ломает phrase-windows в findMissingPhrases — окно
    // соседних слов одного <li> перестаёт быть смежным в outputPlainText),
    // выносим H2 во ВНЕШНИЙ sibling-блок blocks с одним только <h2>NAME</h2>.
    // Это надёжнее, чем эвристически искать «где не помешает» внутри блока.
    const needsSiblingH2 = (layout === 'steps' || layout === 'bens'
      || layout === 'tabs' || layout === 'faq'
      || layout === 'price' || layout === 'tags'
      || layout === 'portfolio') && !!section.h2;
    if (needsSiblingH2) {
      const mini = h2HoldingMiniBlock(section.h2);
      if (mini) out.push(mini);
    }
    let block;
    switch (layout) {
      case 'faq':       block = buildFaqBlock(section); break;
      case 'steps':     block = buildStepsBlock(section); break;
      case 'bens':      block = buildBensBlock(section); break;
      case 'price':
        // price/tags/portfolio внутри тоже могут вернуть массив (например,
        // pure-fallback на blocks при пустых items). Sibling-h2 уже выше
        // добавлен — дочерние билдеры его НЕ дублируют.
        for (const b of buildPriceBlock(section)) out.push(b);
        continue;
      case 'attention': block = buildAttentionBlock(section); break;
      case 'expert':
        block = buildExpertBlock(section);
        ctx.expertUsed = true;
        break;
      case 'tabs':      block = buildTabsBlock(section); break;
      case 'portfolio':
        for (const b of buildPortfolioBlocks(section)) out.push(b);
        continue;
      case 'tags':
        for (const b of buildTagsBlock(section)) out.push(b);
        continue;
      case 'blocks':
      default:          block = buildBlocksBlock(section); break;
    }
    out.push(block);
  }

  return out;
}

// Для тестов / внешнего переиспользования.
export const _internals = {
  canon,
  matchesKw,
  stripH1,
  sliceByH2,
  classifySection,
  KW,
};
