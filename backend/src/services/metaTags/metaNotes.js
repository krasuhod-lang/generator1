'use strict';

/**
 * metaTags/metaNotes — «человеческий» слой над техническими заметками
 * пост-валидации.
 *
 * Проблема, которую решает модуль: в UI редактору падал сырой английский дамп
 * GIST-ranker'а вида «No candidate passed all GIST Meta Filter tests
 * (concreteness, decision_relevance…). Fallback sequence did not yield a valid
 * GIST factor: relax_verifiability requires…». Для правки текста это бесполезно,
 * а место в интерфейсе занимает.
 *
 * Здесь мы:
 *   1) переводим/пересказываем типовые причины ranker'а по-русски
 *      (`humanizeReviewReason`), а сырой текст отдаём в `_meta` для логов;
 *   2) раскладываем плоский список заметок на три группы
 *      (`classifyNotes`): errors — требуют правки, warnings — стоит
 *      посмотреть, recommendations — можно улучшить.
 */

const MANUAL_REVIEW_TEXT = 'Нужна ручная правка.';

// Типовые куски английского вывода ranker'а → человеческая формулировка.
// Порядок важен: первое совпадение выигрывает.
const REASON_RULES = [
  {
    re: /no candidate passed all gist meta filter tests/i,
    text: 'Ни один факт о странице не прошёл все четыре проверки GIST '
      + '(конкретность, влияние на решение, незаменяемость, проверяемость).',
  },
  {
    re: /failed replaceability/i,
    text: 'Единственный уцелевший факт оказался заменяемым: конкурент может '
      + 'написать то же самое почти дословно.',
  },
  {
    re: /fallback sequence did not yield a valid gist factor|fallback.*no candidate qualifies/i,
    text: 'Резервная последовательность отбора тоже не дала подходящего факта.',
  },
  {
    re: /no supercategory or structural facts available/i,
    text: 'На странице нет ни фактов уровня категории, ни структурных данных '
      + '(состав, параметры, условия), на которые можно опереться.',
  },
  {
    re: /manual review required/i,
    text: MANUAL_REVIEW_TEXT,
  },
  {
    re: /relax_verifiability requires/i,
    text: 'Смягчение проверяемости невозможно: у кандидатов не хватает базовых оценок.',
  },
  {
    re: /empty candidate pool|пустой пул кандидатов/i,
    text: 'Пул кандидатов-фактов пуст.',
  },
];

// Что делать редактору — добавляем к переводу, чтобы заметка была действием,
// а не констатацией.
const NEXT_STEP = 'Что делать: добавьте на страницу проверяемую деталь '
  + '(число, срок, условие, состав данных) и перегенерируйте пару.';

/**
 * Переводит причину ручной проверки на русский. Если строка уже русская —
 * возвращает её как есть (тримленной).
 *
 * @param {string} reason сырое значение manual_review_reason
 * @returns {string} человеческая формулировка (может быть пустой строкой)
 */
function humanizeReviewReason(reason) {
  const raw = String(reason || '').trim();
  if (!raw) return '';

  const parts = [];
  REASON_RULES.forEach((rule) => {
    if (rule.re.test(raw) && !parts.includes(rule.text)) parts.push(rule.text);
  });

  if (!parts.length) {
    // Незнакомая формулировка. Русский текст писался для редактора — отдаём
    // как есть; сугубо английский помечаем как техническую причину.
    const hasCyrillic = /[а-яё]/i.test(raw);
    return hasCyrillic
      ? raw
      : `Автоматический отбор факта не дал результата (техническая причина: ${raw.slice(0, 160)}).`;
  }

  // «Нужна ручная правка» — не самостоятельная причина: она дублирует маркер
  // заметки. Оставляем её, только если больше сказать нечего.
  const meaningful = parts.filter((p) => p !== MANUAL_REVIEW_TEXT);
  const head = (meaningful.length ? meaningful : parts).slice(0, 3);
  head.push(NEXT_STEP);
  return head.join(' ');
}

const ERROR_MARKERS = [
  /^⚠️/,
  /не прошла все проверки/i,
  /manual_review_required/i,
  /остались нарушения/i,
  /guard:/i,
];

const RECOMMENDATION_MARKERS = [
  /^рекомендация/i,
  /добавьте, если/i,
  /есть риск однотипности/i,
];

/**
 * Раскладывает плоский список заметок на errors / warnings / recommendations.
 * Возвращает и исходный плоский список — чтобы старые потребители
 * (`post_validation_notes`) продолжали работать без изменений.
 *
 * @param {string[]} notes
 * @returns {{errors: string[], warnings: string[], recommendations: string[], all: string[]}}
 */
function classifyNotes(notes) {
  const list = Array.isArray(notes) ? notes.map((n) => String(n || '').trim()).filter(Boolean) : [];
  const report = { errors: [], warnings: [], recommendations: [], all: list };

  list.forEach((note) => {
    if (RECOMMENDATION_MARKERS.some((re) => re.test(note))) {
      report.recommendations.push(note);
      return;
    }
    if (ERROR_MARKERS.some((re) => re.test(note))) {
      report.errors.push(note);
      return;
    }
    report.warnings.push(note);
  });

  return report;
}

module.exports = {
  humanizeReviewReason,
  classifyNotes,
  REASON_RULES,
};
