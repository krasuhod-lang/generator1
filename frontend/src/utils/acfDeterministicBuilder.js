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
  // Сюда же относятся «авторские» и «редакторские» вариации заголовка —
  // по требованию задачи блок автора/эксперта в статье есть всегда и должен
  // ВСЕГДА классифицироваться как acf_fc_layout="expert" (это и есть
  // «блок автора» в нашей ACF-схеме). См. также looksLikeExpertBody:
  // дополнительно ловим явный маркер <blockquote class="expert-opinion">,
  // который stage3_writer гарантированно вставляет ровно один раз.
  expert:    ['мнение эксперт', 'мнение специалист', 'мнение врача',
              'мнение юриста', 'мнение мастера', 'комментарий эксперт',
              'слово эксперт', 'эксперт говорит',
              'мнение автор', 'слово автор', 'комментарий автор',
              'от автора', 'автор советует', 'автор рекомендует',
              'автор отмечает', 'позиция автора', 'точка зрения автора',
              'мнение редактор', 'слово редактор', 'комментарий редактор',
              'от редакции', 'редакция рекомендует', 'мнение редакции'],
  // tabs (Вкладки) удалены из набора по требованию: соответствующий контент
  // теперь падает в универсальный blocks-блок (либо в более подходящий
  // типизированный блок, если совпадает по другим ключевым словам).
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

// ── Удаление встроенных media (зеркалит stripInlineMediaFromHtml в AcfJsonPage) ──
// info-article-cover (<figure><img src="data:..."/></figure>), любые <img>
// и <picture>. Эти элементы не имеют целевого ACF-поля в наших 7 блоках
// (blocks/steps/bens/price/faq/attention/expert), а base64-картинка
// раздула бы text-поле на сотни КБ. Дублируем здесь страховочно: основной
// вызов делается в AcfJsonPage.runJob, но билдер должен оставаться
// самодостаточным, если его дёрнут напрямую из тестов/другого места.
function stripInlineMedia(html) {
  if (!html) return '';
  let out = String(html);
  for (let i = 0; i < 10; i += 1) {
    const next = out.replace(/<figure\b[^>]*>[\s\S]*?<\/figure\s*>/gi, '');
    if (next === out) break;
    out = next;
  }
  for (let i = 0; i < 10; i += 1) {
    const next = out.replace(/<picture\b[^>]*>[\s\S]*?<\/picture\s*>/gi, '');
    if (next === out) break;
    out = next;
  }
  out = out.replace(/<img\b[^>]*\/?>/gi, '');
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
// Дополнительно — гарантированный маркер из stage3_writer:
// <blockquote class="expert-opinion">…</blockquote> в любом месте поддерева
// секции (а не только как прямой ребёнок). Это закрывает кейсы, когда
// автор/редактор обернул цитату во вспомогательный <div>, и сам H2 при этом
// не совпал с KW.expert (например «От автора», «Слово редактора») — без
// этой ветки такая секция уходила в обычный blocks-блок, и в JSON
// терялся отдельный «блок автора».
function looksLikeExpertBody(body) {
  for (const n of body) {
    if (tag(n) === 'blockquote' && (n.textContent || '').trim()) return true;
    if (n && n.nodeType === 1 && typeof n.querySelector === 'function') {
      const marked = n.querySelector('blockquote.expert-opinion');
      if (marked && (marked.textContent || '').trim()) return true;
    }
  }
  return false;
}

// «Похоже ли тело на Tabs» удалено вместе с buildTabsBlock —
// соответствующий контент теперь упаковывается в blocks-layout.

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

  // tabs (Вкладки) удалены: «Диагностика», «Признаки», «Виды», «Типы»,
  // «Варианты» теперь падают в дефолтный blocks-блок ниже — текст
  // сохраняется byte-for-byte, без визуального разбиения на табы.

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
//
// ВНИМАНИЕ: разделитель (`. ) : - — –`) ОБЯЗАТЕЛЕН, если нет ключевого
// слова-нумератора (Шаг/Этап/Step/...). Иначе обычные заголовки вида
// «5 типичных ошибок при замене шлангов» теряют ведущую цифру, что:
//   1) ломает title блока (становится «типичных ошибок ...»);
//   2) роняет findMissingHeadings (canon исходного <h2> с «5» больше не
//      совпадает с canon стрипнутого title) и findMissingPhrases (окно
//      «5 типичных ошибок при замене шлангов» исчезает из вывода);
//   3) приводит к ложному срабатыванию LLM-фолбэка и в итоге обрывает
//      задачу с «потерями контента», которых на самом деле нет.
// Также защищает «5-минутный гайд», «3D-печать» и подобные конструкции,
// где дефис — часть слова, а не разделитель.
//
// Совпадает строго в двух формах:
//   A) «<keyword> [№]<digits>[<sep>][пробел...]» — для «Шаг 1: », «Этап 2».
//   B) «<digits><sep>(пробел или конец строки)» — для «1. », «1) », «1: ».
const TITLE_NUMBER_PREFIX_RE = /^\s*(?:(?:Шаг|Этап|Раздел|Часть|Глава|Step|Part)\s*№?\s*\d+\s*[.):\-—–]?\s*|\d+\s*[.):\-—–](?:\s+|$))/i;
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

// (Хелпер h2ToHtml удалён вместе с механизмом «sibling-h2».)

// ── Хелперы для сохранения «остаточного» контента ─────────────────────────
// Несколько специализированных билдеров (price/steps-ol/expert/tags) умеют
// извлекать ТОЛЬКО один структурный контейнер из тела секции — таблицу,
// нумерованный список, blockquote, набор ссылок. Любые СОПУТСТВУЮЩИЕ узлы
// (вступительные/заключительные <p> и <h3>, развёрнутые объяснения) при
// этом раньше молча отбрасывались, что ломало инвариант сохранности
// контента и валидаторы findMissingPhrases / findMissingHeadings.
//
// Чтобы это починить детерминированно (и не «угадывать», поместится ли
// текст внутрь одного из специализированных полей), мы заворачиваем такие
// «остатки» в отдельный sibling-блок acf_fc_layout="blocks" — точно так же,
// как orchestrator уже делает для дословного хранения <h2> через
// h2HoldingMiniBlock. На уровне валидаторов это безопасно: outputPlainText
// конкатенирует все text/content/answer/blocks-text, дублирования нет.

// Возвращает blocks-блок без H2-префикса для переданных «остаточных» узлов.
// Возвращает null, если среди узлов нет ничего, кроме пустоты/пробелов.
function leftoverBlocksBlock(nodes) {
  if (!nodes || !nodes.length) return null;
  const meaningful = nodes.filter((n) => nodeText(n).length > 0);
  if (!meaningful.length) return null;
  return buildBlocksBlock({ h2: null, body: meaningful });
}

// Унифицированно оборачивает специализированный «primary» блок остаточными
// blocks-сиблингами в порядке исходного текста: pre → primary → post.
// Каждый специализированный билдер (steps/bens/expert/price) теперь
// возвращает результат этой функции и тем самым гарантированно сохраняет
// весь текст исходной секции.
function wrapWithLeftovers(primary, preLeftover, postLeftover) {
  const out = [];
  const pre = leftoverBlocksBlock(preLeftover);
  if (pre) out.push(pre);
  out.push(primary);
  const post = leftoverBlocksBlock(postLeftover);
  if (post) out.push(post);
  return out;
}

// ── Билдеры конкретных типов блоков ───────────────────────────────────────

// blocks (универсальный) — H2 + всё тело идёт в text как есть.
function buildBlocksBlock(section) {
  const inner = [];
  if (section.h2) inner.push(section.h2);
  for (const n of section.body) inner.push(n);
  return {
    acf_fc_layout: 'blocks',
    // Без фейкового fallback'а «Раздел»: для leftover/intro-блоков (h2:null)
    // title остаётся пустым — это честнее, чем навязывать заголовок, которого
    // в исходном HTML нет. Реальные секции с <h2> по-прежнему получают его
    // текст как title через nodeText(section.h2) внутри shortTitle.
    title: shortTitle(section.h2, ''),
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

// (Раньше для секций без «безвредного» места дословно держать заголовок
// эмитился внешний sibling-блок через h2HoldingMiniBlock, но он создавал
// визуальный дубль с `title` виджета. Сейчас findMissingHeadings принимает
// заголовок как сохранённый, если его канон совпал с `title` блока — этого
// достаточно, чтобы инвариант не нарушался без дубля в HTML).

// steps — две формы:
//   • <ol><li>...</li>...</ol> → каждый <li> = шаг (title=первая строка/<strong>, text=остальное)
//   • h3+p пары → каждая пара = шаг
//
// Внутренний экстрактор: возвращает { items, preLeftover, postLeftover }.
// Вынесен из buildStepsBlock, чтобы buildBensBlock мог переиспользовать ту
// же логику и при этом тоже корректно прокидывать остатки тела секции
// в blocks-сиблинги (раньше bens терял контент так же, как steps).
function _extractStepLikeItems(body) {
  const items = [];
  let preLeftover = [];
  let postLeftover = [];

  // 1. Если есть <ol>, разбираем его (берём ПЕРВЫЙ ol). Всё, что лежит
  //    в теле секции ДО и ПОСЛЕ этого <ol> (вступление, поясняющие <p>,
  //    заключительные <h3>+<p> и т. п.), становится «остатками» для
  //    sibling blocks-блоков — иначе этот текст безвозвратно терялся.
  const olIdx = body.findIndex((n) => tag(n) === 'ol');
  if (olIdx !== -1) {
    const ol = body[olIdx];
    preLeftover = body.slice(0, olIdx);
    postLeftover = body.slice(olIdx + 1);
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
    // 2. h3+p пары. Сюда же приклеиваются все «сироты» — этот путь сам
    //    по себе ничего не теряет, поэтому leftover'ы остаются пустыми.
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
        // ИСХОДНЫЙ <h3>/<h4> в items[].text НЕ дублируем: его текст уже
        // лежит в items[].title, а WP-виджет (steps/bens) рендерит title
        // как видимый заголовок шага/преимущества. Иначе пользователь видит
        // ОДИН и тот же подзаголовок дважды (стилизованный + сырой <h3>).
        // Сохранность подтверждается title-канон-исключением в
        // findMissingHeadings (см. AcfJsonPage.vue). Дополнительная защита
        // для LLM-режима: dedupeLeadingHeading в postCleanupAcfArray
        // подчищает такой ведущий <hN>, если LLM всё-таки его сгенерировала.
        items.push({
          title: titleStr,
          text: nodesToHtml(restNodes),
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

  return { items, preLeftover, postLeftover };
}

function buildStepsBlock(section) {
  const { items, preLeftover, postLeftover } = _extractStepLikeItems(section.body);

  // Колонки: 4 (3 в ряд) для 3–6 шагов; 6 (2 в ряд) для 1–2; 3 (4 в ряд) для 7+.
  let columns = '4';
  if (items.length <= 2) columns = '6';
  else if (items.length >= 7) columns = '3';

  const primary = {
    acf_fc_layout: 'steps',
    title: shortTitle(section.h2, 'Этапы'),
    subtitle: '',
    items,
    columns,
  };
  return wrapWithLeftovers(primary, preLeftover, postLeftover);
}

// bens — структурно близко к steps, но другой набор полей.
function buildBensBlock(section) {
  // Переиспользуем разбор из steps, чтобы и набор items, и pre/post-остатки
  // считались одинаково — и bens теперь так же не теряет окружающий текст.
  const { items: rawItems, preLeftover, postLeftover } = _extractStepLikeItems(section.body);
  const items = rawItems.map((it) => ({
    title: it.title,
    image: '',
    text: it.text,
  }));
  let columns = '4';
  if (items.length <= 2) columns = '6';
  else if (items.length >= 7) columns = '3';
  const primary = {
    acf_fc_layout: 'bens',
    title: shortTitle(section.h2, 'Преимущества'),
    color_title: '#000000',
    subtitle: '',
    items,
    columns,
    image: '',
  };
  return wrapWithLeftovers(primary, preLeftover, postLeftover);
}

// (Хелпер h2HoldingMiniBlock удалён вместе с механизмом «sibling-h2».
// Если потребуется снова — восстановить из истории git.)

// price — таблица или список с денежными хвостами.
// Возвращает МАССИВ блоков (mini-blocks с H2 + сам price + опциональные
// blocks-сиблинги для остаточного текста), чтобы исходный <h2> и любые
// сопутствующие <p>/<h3> вокруг таблицы/списка сохранились дословно —
// у price-схемы нет HTML-поля для встраивания произвольного абзаца.
function buildPriceBlock(section) {
  const items = [];
  const body = section.body;
  let primaryIdx = -1;

  const tableIdx = body.findIndex((n) => tag(n) === 'table');
  if (tableIdx !== -1) {
    primaryIdx = tableIdx;
    const table = body[tableIdx];
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
    const listIdx = body.findIndex((n) => tag(n) === 'ul' || tag(n) === 'ol');
    if (listIdx !== -1) {
      primaryIdx = listIdx;
      const list = body[listIdx];
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

  const preLeftover  = primaryIdx >= 0 ? body.slice(0, primaryIdx)     : [];
  const postLeftover = primaryIdx >= 0 ? body.slice(primaryIdx + 1)    : [];
  const primary = {
    acf_fc_layout: 'price',
    title: shortTitle(section.h2, 'Прайс'),
    subtitle: '',
    items,
  };
  return wrapWithLeftovers(primary, preLeftover, postLeftover);
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
// Возвращает МАССИВ: blocks-сиблинги с pre/post-текстом вокруг blockquote
// (если они есть) + сам expert-блок. Без этих сиблингов любой <p>/<h3>,
// который шёл до или после blockquote в исходной секции «Мнение эксперта»,
// безвозвратно терялся (видно по баг-репорту: пропадали h3 «Сертификация
// и стандарты…», «Ресурс колодок в городском цикле Москвы…»).
function buildExpertBlock(section) {
  const body = section.body;
  const blockquoteIdx = body.findIndex((n) => tag(n) === 'blockquote' && (n.textContent || '').trim());
  let text;
  let preLeftover = [];
  let postLeftover = [];
  if (blockquoteIdx !== -1) {
    const blockquote = body[blockquoteIdx];
    preLeftover = body.slice(0, blockquoteIdx);
    postLeftover = body.slice(blockquoteIdx + 1);
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
    for (const n of body) inner.push(n);
    text = nodesToHtml(inner);
  }
  const primary = {
    acf_fc_layout: 'expert',
    title: shortTitle(section.h2, 'Мнение эксперта'),
    expert: 0,
    text,
  };
  return wrapWithLeftovers(primary, preLeftover, postLeftover);
}

// tabs (Вкладки) удалён по требованию: контент таких секций
// («Диагностика», «Признаки», «Виды», «Типы», «Варианты») теперь
// упаковывается в универсальный blocks-блок через классификатор.

// portfolio — пустая галерея (фото в WP подгружаются вручную). Но H2 и
// весь сопутствующий текст НЕЛЬЗЯ просто выкинуть — это ломает инвариант
// сохранности. Поэтому, если в секции есть текстовое содержимое или сам
// заголовок <h2>, перед portfolio добавляется blocks-секция с этим контентом.
// Ранее <h2> добавлялся отдельным sibling-блоком из orchestrator'а — теперь,
// когда sibling-механика убрана (она дублировала заголовок виджета),
// portfolio сам ответственен за дословное сохранение исходного <h2>.
// Возвращаем массив, чтобы caller расплющил его в общий список.
function buildPortfolioBlocks(section) {
  const out = [];
  // Если в секции есть текст ИЛИ исходный <h2> — кладём всё в blocks-сиблинг
  // (включая h2, чтобы заголовок остался дословно сохранён в HTML).
  // findMissingHeadings также примет h2 через title-канон-исключение, но
  // для portfolio мы держим заголовок и в HTML — это безопасно (одно
  // место, не дубль) и читается админом WP так же, как обычный раздел.
  const hasText = section.body.some((n) => nodeText(n).length > 0);
  if (hasText || section.h2) {
    out.push(buildBlocksBlock(section));
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
// Поскольку tags-виджет рендерит ТОЛЬКО подписи ссылок (без окружающего
// текста абзацев), мы дополнительно эмитим blocks-сиблинг с исходным
// телом секции. Получается лёгкое дублирование (ссылка показана и в
// абзаце, и в виджете тегов), но валидаторы это допускают (substring),
// а инвариант сохранности контента не нарушается.
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
  const tagsBlock = {
    acf_fc_layout: 'tags',
    title: shortTitle(section.h2, 'Теги'),
    items: links,
  };
  const out = [];
  // Кладём СЕКЦИЮ (h2 + body) целиком в leftover-blocks, чтобы дословно
  // сохранить и заголовок, и абзацы (раньше h2 добавлял отдельный
  // sibling-блок из orchestrator'а — но это создавало визуальный дубль
  // секционного заголовка с `title` виджета tags).
  if (section.h2 || (section.body && section.body.length)) {
    out.push(buildBlocksBlock(section));
  }
  out.push(tagsBlock);
  return out;
}

// ── Публичный API ─────────────────────────────────────────────────────────

// Допустимые значения acf_fc_layout. Используется для валидации внешних
// подсказок (opts.layoutHints) — любое значение вне списка игнорируется и
// уступает место эвристике, чтобы LLM-классификатор не мог «прокрасться»
// и протолкнуть нестандартный layout, который сломает рендер на сайте.
const VALID_LAYOUTS = new Set([
  'blocks', 'steps', 'bens', 'price',
  'faq', 'attention', 'expert',
  'portfolio', 'tags',
]);

/**
 * Извлекает компактные дескрипторы секций для внешнего классификатора
 * (LLM-режим «гибрид»). Не возвращает полный текст секций — только
 * короткое превью + статистики формы. Этого достаточно, чтобы модель
 * выбрала правильный acf_fc_layout, при этом payload остаётся в пределах
 * сотен байт на секцию (защита от HTTP 413 промежуточных HTTPS-прокси).
 *
 * Индексация дескрипторов СТРОГО соответствует индексации секций внутри
 * `buildAcfFromHtml(html, { layoutHints })` — обе функции вызывают
 * один и тот же `sliceByH2`, поэтому подсказки можно передавать
 * напрямую по `index`.
 *
 * @param {string} html  — исходный HTML (тот же, что пойдёт в buildAcfFromHtml)
 * @returns {Array<{
 *   index: number,
 *   h2_text: string,
 *   body_stats: {
 *     h3_count: number, h4_count: number, p_count: number,
 *     ol_present: boolean, ul_present: boolean, table_present: boolean,
 *     blockquote_present: boolean, money_present: boolean,
 *     total_chars: number,
 *   },
 *   text_preview: string,
 * }>}
 */
export function extractSectionDescriptors(html) {
  const cleaned = stripH1(stripInlineMedia(html || ''));
  if (!cleaned.trim()) return [];
  const body = parseHtmlToBody(cleaned);
  const sections = sliceByH2(body);

  return sections.map((section, index) => {
    const h2Text = section.h2 ? nodeText(section.h2) : '';
    let h3Count = 0;
    let h4Count = 0;
    let pCount = 0;
    let olPresent = false;
    let ulPresent = false;
    let tablePresent = false;
    let blockquotePresent = false;
    let moneyPresent = false;
    let totalChars = 0;
    const previewParts = [];
    for (const n of section.body) {
      const t = tag(n);
      if (t === 'h3') h3Count += 1;
      else if (t === 'h4') h4Count += 1;
      else if (t === 'p') pCount += 1;
      else if (t === 'ol') olPresent = true;
      else if (t === 'ul') ulPresent = true;
      else if (t === 'table') tablePresent = true;
      else if (t === 'blockquote' && (n.textContent || '').trim()) blockquotePresent = true;
      const txt = nodeText(n);
      totalChars += txt.length;
      if (previewParts.join(' ').length < 200 && txt) previewParts.push(txt);
      if (!moneyPresent && (t === 'ul' || t === 'ol' || t === 'table')) {
        if (PRICE_RE.test(n.textContent || '')) moneyPresent = true;
      }
    }
    const text_preview = previewParts.join(' ').slice(0, 200);
    return {
      index,
      h2_text: h2Text,
      body_stats: {
        h3_count: h3Count,
        h4_count: h4Count,
        p_count: pCount,
        ol_present: olPresent,
        ul_present: ulPresent,
        table_present: tablePresent,
        blockquote_present: blockquotePresent,
        money_present: moneyPresent,
        total_chars: totalChars,
      },
      text_preview,
    };
  });
}

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
 * @param {object} [opts]
 * @param {Map<number,string>|Array<string|{index:number,layout:string}>} [opts.layoutHints]
 *   Внешние подсказки выбора acf_fc_layout (от LLM-классификатора в гибридном
 *   режиме). Индексация СТРОГО по позиции секции из `extractSectionDescriptors`.
 *   Невалидные значения / нарушение квоты `expert` автоматически отбрасываются
 *   и заменяются на эвристику. Подсказка НИКОГДА не влияет на сам текст,
 *   только на выбор контейнера — инвариант сохранности соблюдается.
 * @returns {Array<object>} массив ACF-блоков
 */
export function buildAcfFromHtml(html, opts = {}) {
  const sections = buildAcfSections(html, opts);
  const out = [];
  for (const item of sections) {
    for (const b of item.blocks) out.push(b);
  }
  return out;
}

// Внутренний пер-секционный сборщик — общая ветка switch, вынесенная из
// исторического тела buildAcfFromHtml. Принимает массив parsed-секций и
// функцию выбора подсказки (или null), возвращает массив
// { sectionIndex, layout, blocks }. Один и тот же контекст ctx
// (квота expert) пробрасывается между секциями.
function _buildPerSectionInternal(sections, getHintLayout) {
  const result = [];
  const ctx = { expertUsed: false };
  for (let sectionIdx = 0; sectionIdx < sections.length; sectionIdx += 1) {
    const section = sections[sectionIdx];
    const hinted = typeof getHintLayout === 'function'
      ? getHintLayout(sectionIdx, ctx)
      : null;
    const layout = hinted || classifySection(section, ctx);
    const blocks = [];
    switch (layout) {
      case 'faq':       blocks.push(buildFaqBlock(section)); break;
      case 'steps':
        for (const b of buildStepsBlock(section)) blocks.push(b);
        break;
      case 'bens':
        for (const b of buildBensBlock(section)) blocks.push(b);
        break;
      case 'price':
        for (const b of buildPriceBlock(section)) blocks.push(b);
        break;
      case 'attention': blocks.push(buildAttentionBlock(section)); break;
      case 'expert':
        for (const b of buildExpertBlock(section)) blocks.push(b);
        ctx.expertUsed = true;
        break;
      case 'portfolio':
        for (const b of buildPortfolioBlocks(section)) blocks.push(b);
        break;
      case 'tags':
        for (const b of buildTagsBlock(section)) blocks.push(b);
        break;
      case 'blocks':
      default:          blocks.push(buildBlocksBlock(section)); break;
    }
    result.push({ sectionIndex: sectionIdx, layout, blocks });
  }
  return result;
}

/**
 * Пер-секционная программная сборка. Возвращает массив объектов
 * { index, layout, sectionHtml, blocks }, индексация СТРОГО соответствует
 * extractSectionDescriptors (тот же sliceByH2). Используется в едином
 * Qwen-режиме AcfJsonPage.runJob: вызывающий код может валидировать каждую
 * секцию отдельно и при потере контента подменять blocks одной секции
 * результатом точечного LLM-запроса, не затрагивая остальные секции.
 *
 * `sectionHtml` — это исходный HTML именно этой секции (h2.outerHTML +
 * последовательность outerHTML её body-узлов). Подходит и для скоринга
 * пер-секционной валидации (findMissingPhrases на этом HTML), и как payload
 * для пер-секционного LLM-фолбэка (см. AcfJsonPage.buildSectionViaLlm).
 *
 * @param {string} html
 * @param {object} [opts]
 * @param {Map<number,string>|Array} [opts.layoutHints] — то же, что в
 *   buildAcfFromHtml.
 * @returns {Array<{index:number, layout:string, sectionHtml:string, blocks:Array}>}
 */
export function buildAcfSections(html, opts = {}) {
  const cleaned = stripH1(stripInlineMedia(html || ''));
  if (!cleaned.trim()) return [];
  const body = parseHtmlToBody(cleaned);
  const sections = sliceByH2(body);
  const hintMap = _normalizeHintMap(opts && opts.layoutHints);
  const getHintLayout = (idx, ctx) => {
    if (!hintMap) return null;
    const raw = hintMap.get(idx);
    if (typeof raw !== 'string') return null;
    const norm = raw.toLowerCase().trim();
    if (!VALID_LAYOUTS.has(norm)) return null;
    // Уважаем квоту 1 expert на статью — даже если LLM подсказала второй.
    if (norm === 'expert' && ctx.expertUsed) return null;
    return norm;
  };
  const perSection = _buildPerSectionInternal(sections, getHintLayout);
  return perSection.map((item) => ({
    index: item.sectionIndex,
    layout: item.layout,
    sectionHtml: _sectionToHtml(sections[item.sectionIndex]),
    blocks: item.blocks,
  }));
}

// Сериализация одной секции (h2 + body) в HTML-строку. Используется и для
// LLM-фолбэка (точечный запрос на одну секцию), и для пер-секционной
// валидации (валидаторам надо видеть только контент текущей секции, а не
// всей статьи — иначе они не отличат «потерян фрагмент именно этой секции»
// от «фрагмент перенесён в соседнюю»).
function _sectionToHtml(section) {
  const parts = [];
  if (section.h2) parts.push(section.h2.outerHTML);
  parts.push(nodesToHtml(section.body));
  return parts.join('');
}

// Нормализация подсказок layout'а в Map<number,string>. Принимаем три формы:
//   • Map<number,string>            — самый удобный путь;
//   • массив строк по индексу       — layoutHints[i] = 'steps';
//   • массив объектов {index,layout} — формат прямого ответа LLM.
// Out-of-range индексы (LLM придумал секцию №99) безопасны: при сборке
// просто не совпадут ни с одной реальной секцией.
function _normalizeHintMap(src) {
  if (!src) return null;
  if (typeof src.get === 'function') return src;
  if (!Array.isArray(src)) return null;
  const m = new Map();
  for (let i = 0; i < src.length; i += 1) {
    const v = src[i];
    if (typeof v === 'string') m.set(i, v);
    else if (
      v && typeof v === 'object'
      && Number.isInteger(v.index) && v.index >= 0
      && typeof v.layout === 'string'
    ) {
      m.set(v.index, v.layout);
    }
  }
  return m;
}

// Для тестов / внешнего переиспользования.
export const _internals = {
  canon,
  matchesKw,
  stripH1,
  stripInlineMedia,
  sliceByH2,
  classifySection,
  KW,
};
