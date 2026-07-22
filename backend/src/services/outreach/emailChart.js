'use strict';
/**
 * emailChart — детерминированный рендер графика динамики видимости
 * в тело письма (Блок 5 ТЗ).
 *
 * Почтовые клиенты НЕ исполняют JS (ECharts не подходит), поэтому график
 * рисуется как inline-SVG: линия «было → сейчас» по данным keys.so
 * (dynamics_detail). Красная линия — падение, зелёная — рост, серая —
 * стагнация. Цифры берутся ТОЛЬКО из dynamics_detail (не выдумываются LLM),
 * поэтому график всегда совпадает с таблицей динамики.
 *
 * Экспортирует buildDynamicsChart(detail) → { html } (html === '' если
 * числовых данных нет — вызывающий код просто не вставляет график).
 */

const CHART_W = 520;
const CHART_H = 180;
const PAD_L = 46;
const PAD_R = 16;
const PAD_T = 24;
const PAD_B = 40;

const COLORS = {
  decline: '#D32F2F',
  growth: '#2E7D32',
  stagnation: '#757575',
};
const LABELS = { yandex: 'Яндекс', google: 'Google' };

function _esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * Собирает точки серии из записи движка dynamics_detail.
 * Использует промежуточные точки (series[]), если они есть, иначе
 * строит линию из first → last.
 * @returns {{engine:string,label:string,trend:string,points:number[],pct:number}|null}
 */
function _seriesFromEngine(engine, d) {
  if (!d) return null;
  const first = d.first && Number.isFinite(Number(d.first.value)) ? Number(d.first.value) : null;
  const last = d.last && Number.isFinite(Number(d.last.value)) ? Number(d.last.value) : null;
  if (first == null || last == null) return null;

  let points;
  if (Array.isArray(d.series) && d.series.length >= 2) {
    points = d.series
      .map((p) => (typeof p === 'object' ? Number(p.value) : Number(p)))
      .filter((v) => Number.isFinite(v));
    if (points.length < 2) points = [first, last];
  } else {
    points = [first, last];
  }

  return {
    engine,
    label: LABELS[engine] || engine,
    trend: d.trend || 'stagnation',
    points,
    pct: Number(d.deviation_pct),
  };
}

/**
 * @param {object|null} detail — dynamics_detail (yandex/google записи keys.so)
 * @returns {{html:string}}
 */
function buildDynamicsChart(detail) {
  if (!detail || typeof detail !== 'object') return { html: '' };

  const series = [];
  for (const engine of ['yandex', 'google']) {
    const s = _seriesFromEngine(engine, detail[engine]);
    if (s) series.push(s);
  }
  if (!series.length) return { html: '' };

  // Общий вертикальный масштаб по всем сериям.
  let maxVal = 0;
  for (const s of series) {
    for (const v of s.points) if (v > maxVal) maxVal = v;
  }
  if (maxVal <= 0) return { html: '' };
  const yMax = maxVal * 1.15;

  const plotW = CHART_W - PAD_L - PAD_R;
  const plotH = CHART_H - PAD_T - PAD_B;

  const xFor = (i, n) => PAD_L + (n <= 1 ? 0 : (plotW * i) / (n - 1));
  const yFor = (v) => PAD_T + plotH - (plotH * v) / yMax;

  // Сетка (3 горизонтальные линии + подписи оси Y).
  const gridLines = [];
  for (let g = 0; g <= 2; g += 1) {
    const val = (yMax / 2) * g;
    const y = yFor(val);
    gridLines.push(
      `<line x1="${PAD_L}" y1="${y.toFixed(1)}" x2="${(CHART_W - PAD_R).toFixed(1)}" y2="${y.toFixed(1)}" stroke="#eee" stroke-width="1"/>` +
      `<text x="${PAD_L - 8}" y="${(y + 4).toFixed(1)}" font-family="Arial,sans-serif" font-size="10" fill="#999" text-anchor="end">${Math.round(val)}</text>`,
    );
  }

  const paths = [];
  const dots = [];
  const legend = [];
  let li = 0;
  for (const s of series) {
    const color = COLORS[s.trend] || COLORS.stagnation;
    const n = s.points.length;
    const coords = s.points.map((v, i) => `${xFor(i, n).toFixed(1)},${yFor(v).toFixed(1)}`);
    paths.push(
      `<polyline points="${coords.join(' ')}" fill="none" stroke="${color}" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/>`,
    );
    // Точки на концах.
    for (const idx of [0, n - 1]) {
      const [cx, cy] = coords[idx].split(',');
      dots.push(`<circle cx="${cx}" cy="${cy}" r="3.5" fill="${color}"/>`);
    }
    // Легенда.
    const arrow = s.trend === 'decline' ? '▼' : s.trend === 'growth' ? '▲' : '●';
    const sign = Number.isFinite(s.pct) && s.pct > 0 ? '+' : '';
    const pctTxt = Number.isFinite(s.pct) ? ` ${arrow} ${sign}${s.pct.toFixed(1)}%` : '';
    const lx = PAD_L + li * 180;
    legend.push(
      `<rect x="${lx}" y="${(CHART_H - 16).toFixed(1)}" width="10" height="10" rx="2" fill="${color}"/>` +
      `<text x="${lx + 16}" y="${(CHART_H - 7).toFixed(1)}" font-family="Arial,sans-serif" font-size="11" fill="#333">${_esc(s.label)}${_esc(pctTxt)}</text>`,
    );
    li += 1;
  }

  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${CHART_W}" height="${CHART_H}" viewBox="0 0 ${CHART_W} ${CHART_H}" role="img" aria-label="Динамика видимости сайта в топ-50">` +
    `<rect x="0" y="0" width="${CHART_W}" height="${CHART_H}" fill="#ffffff"/>` +
    gridLines.join('') +
    `<text x="${PAD_L}" y="14" font-family="Arial,sans-serif" font-size="11" fill="#666">Запросы сайта в топ-50 (динамика)</text>` +
    paths.join('') +
    dots.join('') +
    legend.join('') +
    `</svg>`;

  const html =
    `<div style="margin:18px 0 6px;">` +
    svg +
    `</div>` +
    `<div style="font-family:Arial,sans-serif;font-size:11px;color:#999;margin:0 0 14px;">` +
    `График построен по данным сервиса аналитики keys.so (количество запросов вашего сайта в топ-50 поисковой выдачи).` +
    `</div>`;

  return { html };
}

module.exports = { buildDynamicsChart };
