'use strict';

/**
 * eatAnalyzer/eatScorer — детерминированная оценка E-E-A-T шаблона страницы
 * (п.5 ТЗ). Каждая из 4 граней (Experience / Expertise / Authoritativeness /
 * Trust) даёт 0..25, сумма 0..100, плюс список «чего не хватает» (gaps).
 *
 * Опирается на блоки из blockDetector + сигналы микроразметки + (опционально)
 * сигнал авторитетности из ссылочного слоя (linkAudit: есть ли бэклинки на URL).
 */

/**
 * @param {object} detected — результат blockDetector.detectBlocks
 * @param {object} [opts] { hasBacklinks:boolean, template:string }
 * @returns {{score:number, dimensions:object, gaps:string[], strengths:string[]}}
 */
function scoreEat(detected, opts = {}) {
  const b = (detected && detected.blocks) || {};
  const gaps = [];
  const strengths = [];

  // ── Experience (опыт): медиа, кейсы, отзывы клиентов ──
  let experience = 0;
  if (detected && detected.has_media) { experience += 10; strengths.push('media'); }
  else gaps.push('Добавьте собственные фото/видео (сигнал реального опыта).');
  if (b.cases) { experience += 8; strengths.push('cases'); }
  else gaps.push('Добавьте блок кейсов / примеров работ / «до-после».');
  if (b.reviews) { experience += 7; strengths.push('reviews'); }
  else gaps.push('Добавьте отзывы клиентов (UGC) с указанием авторов.');
  experience = Math.min(25, experience);

  // ── Expertise (экспертность): автор + регалии + FAQ ──
  let expertise = 0;
  if (b.author) { expertise += 10; strengths.push('author'); }
  else gaps.push('Добавьте автора/эксперта с биографией и регалиями.');
  if (detected && detected.has_author_schema) { expertise += 6; strengths.push('author_schema'); }
  else gaps.push('Разметьте автора через JSON-LD Person/author.');
  if (b.faq) { expertise += 5; strengths.push('faq'); }
  else gaps.push('Добавьте FAQ-блок с разметкой FAQPage.');
  if (b.certificates) { expertise += 4; strengths.push('certificates'); }
  expertise = Math.min(25, expertise);

  // ── Authoritativeness (авторитетность): сертификаты, ссылки, бренд ──
  let authority = 0;
  if (b.certificates) { authority += 8; strengths.push('certificates'); }
  else gaps.push('Добавьте сертификаты / лицензии / награды.');
  if (opts.hasBacklinks) { authority += 9; strengths.push('backlinks'); }
  else gaps.push('Нарастите авторитет страницы внешними ссылками (см. ссылочную стратегию).');
  if (detected && detected.has_review_schema) { authority += 4; strengths.push('rating_schema'); }
  if (b.social) { authority += 4; strengths.push('social'); }
  else gaps.push('Добавьте ссылки на соцсети/мессенджеры (sameAs).');
  authority = Math.min(25, authority);

  // ── Trust (доверие): контакты, юр.инфо, гарантии, оплата ──
  let trust = 0;
  if (b.contacts) { trust += 7; strengths.push('contacts'); }
  else gaps.push('Добавьте контакты, адрес и режим работы.');
  if (b.legal) { trust += 6; strengths.push('legal'); }
  else gaps.push('Добавьте юр.реквизиты (ООО/ИП, ИНН/ОГРН), политику и оферту.');
  if (b.guarantees) { trust += 6; strengths.push('guarantees'); }
  else gaps.push('Добавьте блок гарантий / возврата.');
  if (b.delivery) { trust += 3; strengths.push('delivery'); }
  if (detected && detected.has_breadcrumb_schema) { trust += 3; strengths.push('breadcrumbs'); }
  else gaps.push('Добавьте «хлебные крошки» с разметкой BreadcrumbList.');
  trust = Math.min(25, trust);

  const score = experience + expertise + authority + trust;
  return {
    score,
    dimensions: { experience, expertise, authoritativeness: authority, trust },
    gaps,
    strengths: Array.from(new Set(strengths)),
  };
}

/** Текстовая метка уровня E-E-A-T по score. */
function scoreLabel(score) {
  if (score >= 80) return 'сильный';
  if (score >= 60) return 'хороший';
  if (score >= 40) return 'средний';
  if (score >= 20) return 'слабый';
  return 'критически слабый';
}

module.exports = { scoreEat, scoreLabel };
