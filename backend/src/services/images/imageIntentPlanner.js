'use strict';

/**
 * imageIntentPlanner — решает, нужен ли визуал для конкретного блока
 * статьи, и если нужен — какого типа (image_intent).
 *
 * Ключевой сдвиг относительно legacy-схемы: изображение планируется НЕ по
 * правилу «есть H2 → нужна картинка», а по правилу «есть блок → какая у
 * него визуальная задача → нужна ли картинка». Абстрактные блоки, которые
 * не выигрывают от визуализации, получают need_image=false.
 *
 * Модуль детерминированный (без сети/LLM) — те же входные данные дают тот
 * же план. Это делает его быстрым, воспроизводимым и тестируемым офлайн,
 * в одном стиле с imageQa.service.
 *
 * Контракт входа planImageIntents(input):
 *   input.articleType   — 'infoArticle' | 'linkArticle' | 'seoTask'
 *   input.topic         — тема статьи (для cover concept)
 *   input.sections      — [{ key, h2, text|html, index }]
 *   input.audience      — произвольный дайджест аудитории (не обязателен)
 *   input.maxImages     — жёсткий верхний предел (напр. user images_count)
 *   input.maxInlineImages — предел inline из конфигурации
 *   input.editorialMode — 'strict' | 'relaxed'
 *
 * Выход — массив image_intents[] (см. README/ТЗ):
 *   { slot, section_key, section_h2, need_image, image_intent, value_reason,
 *     placement_mode, priority, anchor_block_id, signal_scores }
 */

const { scoreSectionSignals } = require('./textSignals');

// Тип визуала → человекочитаемое обоснование пользы (value_reason).
const INTENT_REASON = {
  cover: 'Задаёт визуальный образ страницы и тему статьи',
  explainer_scene: 'Помогает быстрее понять описанный процесс или принцип работы',
  comparison_scene: 'Показывает различия между вариантами, помогает выбрать',
  step_by_step: 'Визуализирует последовательность действий или этапов',
  object_visual: 'Показывает объект, который описывается в тексте',
  trust_visual: 'Усиливает доверие и конкретику (результат, экспертиза)',
  context_of_use: 'Показывает контекст использования в реальной ситуации',
};

// Порог «сигнал достаточно силён, чтобы картинка добавляла ценность».
// В strict-режиме (linkArticle по умолчанию) выше — визуал осторожнее.
const BASE_MIN_SCORE = 2;

/**
 * Определяет лучший тип визуальной задачи по scores.
 * process → step_by_step/explainer, comparison → comparison_scene,
 * object → object_visual, trust → trust_visual, usage → context_of_use.
 */
function pickIntent(sig) {
  const s = sig.scores;
  // Приоритет: process/comparison сильнее (высокая объяснительная ценность),
  // затем object/usage/trust.
  const ranking = [
    ['comparison', s.comparison, 'comparison_scene'],
    ['process',    s.process,    sig.hasList ? 'step_by_step' : 'explainer_scene'],
    ['object',     s.object,     'object_visual'],
    ['usage',      s.usage,      'context_of_use'],
    ['trust',      s.trust,      'trust_visual'],
  ];
  ranking.sort((a, b) => b[1] - a[1]);
  const [, bestScore, bestIntent] = ranking[0];
  return { bestScore, bestIntent };
}

function priorityFromScore(score) {
  if (score >= 5) return 'high';
  if (score >= 3) return 'medium';
  return 'low';
}

/**
 * planCover — обложка почти всегда создаётся, но только при наличии
 * чёткого page-level visual concept (непустая тема).
 */
function planCover(input) {
  const topic = String(input.topic || '').trim();
  const need = topic.length > 0;
  return {
    slot: 1,
    section_key: 'cover',
    section_h2: '',
    need_image: need,
    image_intent: need ? 'cover' : 'do_not_generate',
    value_reason: need ? INTENT_REASON.cover : 'Нет чёткого визуального концепта для обложки',
    placement_mode: 'after_h1',
    priority: 'high',
    anchor_block_id: null,
    signal_scores: {},
  };
}

/**
 * planImageIntents — главный вход. Возвращает упорядоченный план слотов.
 * Никогда не бросает: при пустом/битом входе вернёт как минимум план
 * обложки (или пустой массив, если maxImages=0).
 */
function planImageIntents(input = {}) {
  const articleType = String(input.articleType || 'infoArticle');
  const editorialMode = input.editorialMode === 'relaxed' ? 'relaxed' : 'strict';
  const maxImages = Number.isFinite(input.maxImages) ? Math.max(0, input.maxImages) : 6;
  const maxInline = Number.isFinite(input.maxInlineImages) ? Math.max(0, input.maxInlineImages) : 6;

  if (maxImages === 0) return [];

  // strict-режим (linkArticle) осторожнее: поднимаем порог.
  const minScore = BASE_MIN_SCORE + (editorialMode === 'strict' ? 1 : 0);

  const plan = [];

  // ── Обложка (slot=1). ──────────────────────────────────────────────
  const cover = planCover(input);
  plan.push(cover);

  // ── Inline-слоты по секциям. ───────────────────────────────────────
  const sections = Array.isArray(input.sections) ? input.sections : [];
  const candidates = [];
  for (let i = 0; i < sections.length; i += 1) {
    const sec = sections[i] || {};
    const sig = scoreSectionSignals(sec);
    const { bestScore, bestIntent } = pickIntent(sig);

    // Абстрактный/короткий блок или слабый сигнал → без картинки.
    // Короткий блок отсекаем только если сигнал тоже слабый: сильный
    // сигнал (много process/comparison-маркеров) перевешивает краткость.
    const tooAbstract = sig.abstractness >= 1.2 && bestScore < minScore + 1;
    const tooShort = sig.wordCount < 20 || (sig.wordCount < 40 && bestScore < minScore + 1);
    const need = bestScore >= minScore && !tooAbstract && !tooShort;

    candidates.push({
      section_key: String(sec.key || `section_${i}`),
      section_h2: String(sec.h2 || '').slice(0, 200),
      anchor_block_id: sec.anchor_block_id != null ? String(sec.anchor_block_id) : `block_${i}`,
      need_image: need,
      image_intent: need ? bestIntent : 'do_not_generate',
      value_reason: need ? INTENT_REASON[bestIntent] : 'Абстрактный блок — визуализация не добавляет информации',
      placement_mode: 'before_section',
      priority: priorityFromScore(bestScore),
      _score: bestScore,
      signal_scores: sig.scores,
    });
  }

  // Отбираем ТОЛЬКО полезные слоты, самые сильные первыми, с учётом лимитов.
  const useful = candidates
    .filter((c) => c.need_image)
    .sort((a, b) => b._score - a._score);

  const inlineBudget = Math.min(
    maxInline,
    Math.max(0, maxImages - 1), // -1 на обложку
  );

  const chosen = useful.slice(0, inlineBudget);
  // Восстанавливаем порядок появления в статье (по индексу секции), чтобы
  // slot-нумерация шла сверху вниз.
  const chosenKeys = new Set(chosen.map((c) => c.section_key));
  let slot = 2;
  for (const c of candidates) {
    if (!chosenKeys.has(c.section_key)) continue;
    delete c._score;
    plan.push({ ...c, slot });
    slot += 1;
  }

  // Отклонённые слоты тоже возвращаем (need_image=false) — они нужны для
  // логирования «почему слот отклонён» и для аудита, но НЕ генерируются.
  for (const c of candidates) {
    if (chosenKeys.has(c.section_key)) continue;
    delete c._score;
    plan.push({ ...c, slot: null });
  }

  return plan;
}

module.exports = {
  planImageIntents,
  planCover,
  pickIntent,
  INTENT_REASON,
  BASE_MIN_SCORE,
};
