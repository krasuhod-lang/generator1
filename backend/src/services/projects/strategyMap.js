'use strict';

/**
 * projects/strategyMap — детерминированная визуальная схема стратегии (ТЗ п.5):
 * «нужна схема внутри с прорисовкой, визуально понятная по стратегии — что
 * сделать, чтобы достигнуть наилучших позиций и лучших конверсий».
 *
 * Не вызывает LLM и сеть. Берёт уже посчитанные факторы ранжирования
 * (rankingFactors.buildRankingFactors → {factors[], gaps[], score}) и
 * раскладывает их по 5 последовательным этапам стратегии (воронка работ):
 *
 *   1. Фундамент   — техника и индексация (tech/schema/mobile);
 *   2. Контент     — релевантность, глубина, контентные дыры, деградация;
 *   3. SERP/CTR    — кликабельность сниппета, запросы у входа в топ;
 *   4. Доверие     — E-E-A-T и коммерческие факторы (конверсии);
 *   5. Авторитет   — ссылочный профиль и видимость в нейровыдаче.
 *
 * Каждый этап получает статус (critical/gap/ok) как агрегат входящих факторов,
 * список конкретных действий и ожидаемый эффект. Фронтенд рисует это как
 * связанную диаграмму (этап → этап → KPI).
 */

const { getProjectsConfig } = require('./config');

// Соответствие group факторов → этап стратегии. Порядок этапов = порядок работ.
const STAGES = [
  {
    id: 'foundation',
    title: 'Фундамент',
    subtitle: 'Техника и индексация',
    groups: ['tech', 'structure'],
    outcome: 'Поисковик корректно сканирует и индексирует сайт',
  },
  {
    id: 'content',
    title: 'Контент',
    subtitle: 'Релевантность и полнота',
    groups: ['content'],
    outcome: 'Страницы закрывают интент и спрос лучше конкурентов',
  },
  {
    id: 'serp',
    title: 'SERP и CTR',
    subtitle: 'Сниппеты и вход в топ',
    groups: ['serp'],
    outcome: 'Больше кликов с текущих показов, дотягивание в топ-10',
  },
  {
    id: 'trust',
    title: 'Доверие и конверсии',
    subtitle: 'E-E-A-T и коммерческие факторы',
    groups: ['trust', 'aeo'],
    outcome: 'Выше доверие и конверсия посетителя в заявку',
  },
  {
    id: 'authority',
    title: 'Авторитет',
    subtitle: 'Ссылки и нейровыдача',
    groups: ['authority'],
    outcome: 'Рост авторитета домена и устойчивость позиций',
  },
];

// Худший статус «выигрывает» при агрегации этапа.
const STATUS_RANK = { critical: 3, gap: 2, ok: 1, unknown: 0 };

function _worst(a, b) {
  return (STATUS_RANK[b] || 0) > (STATUS_RANK[a] || 0) ? b : a;
}

function _arr(v) { return Array.isArray(v) ? v : []; }

/**
 * Строит визуальную схему стратегии из факторов ранжирования.
 * @param {object} rankingFactors — результат buildRankingFactors
 * @returns {{available:boolean, score:number|null, goal:string, stages:Array, kpis:Array}}
 */
function buildStrategyMap(rankingFactors) {
  const cfg = getProjectsConfig().strategyMap;
  if (cfg && cfg.enabled === false) return { available: false, reason: 'feature_disabled' };
  if (!rankingFactors || rankingFactors.available === false) {
    return { available: false, reason: 'no_ranking_factors' };
  }
  const factors = _arr(rankingFactors.factors);
  if (!factors.length) return { available: false, reason: 'no_factors' };

  const byGroup = new Map();
  for (const f of factors) {
    const g = f.group || 'other';
    if (!byGroup.has(g)) byGroup.set(g, []);
    byGroup.get(g).push(f);
  }

  const stages = STAGES.map((stage, idx) => {
    const items = [];
    let status = 'unknown';
    for (const g of stage.groups) {
      for (const f of (byGroup.get(g) || [])) {
        status = _worst(status, f.status);
        // В действия попадают только незакрытые зоны (gap/critical) с действием.
        if ((f.status === 'gap' || f.status === 'critical') && f.action) {
          items.push({
            key: f.key,
            label: f.label,
            status: f.status,
            action: f.action,
            finding: f.finding || '',
          });
        }
      }
    }
    // Приоритет действий: critical раньше gap, затем по алфавиту меток.
    items.sort((a, b) => {
      if (a.status !== b.status) return a.status === 'critical' ? -1 : 1;
      return String(a.label).localeCompare(String(b.label), 'ru');
    });
    return {
      step: idx + 1,
      id: stage.id,
      title: stage.title,
      subtitle: stage.subtitle,
      status: status === 'unknown' ? 'ok' : status,
      outcome: stage.outcome,
      actions: items,
      action_count: items.length,
    };
  });

  // KPI-цели стратегии — что меняем измеримо.
  const kpis = [
    { key: 'positions', label: 'Средняя позиция', target: 'Рост в топ-10 по приоритетным запросам' },
    { key: 'ctr', label: 'CTR сниппета', target: 'Выше бенчмарка по позиции' },
    { key: 'conversions', label: 'Конверсии', target: 'Сильные коммерческие факторы и доверие' },
  ];

  return {
    available: true,
    score: rankingFactors.score != null ? rankingFactors.score : null,
    goal: 'Наилучшие позиции и лучшие конверсии',
    summary: rankingFactors.summary || '',
    stages,
    kpis,
  };
}

module.exports = { buildStrategyMap, STAGES };
