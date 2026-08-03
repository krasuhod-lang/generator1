'use strict';
/**
 * aggregatorBlacklistV2 — ДОПОЛНИТЕЛЬНЫЙ (к общему domainBlacklist) список
 * агрегаторов/справочников/маркетплейсов услуг, которые часто стоят ВЫШЕ
 * локального бизнеса в выдаче, но НЕ являются его «прямым конкурентом».
 *
 * Нужен провокационному режиму (V2): и конкурент лида, и наш «кейс» должны быть
 * НАСТОЯЩИМ сайтом бизнеса, а не порталом-агрегатором (docdoc, prodoctorov,
 * 2gis, profi.ru …). Общий domainBlacklist их не ловит, а трогать его нельзя
 * (он в классике) — поэтому фильтр держим ОТДЕЛЬНО, только для V2.
 *
 * Матчинг — по регистрируемому домену (perm.docdoc.ru → docdoc.ru), функцию
 * getRegistrableDomain переиспользуем из общего модуля (её не меняем).
 */
const { getRegistrableDomain } = require('../../serpB2b/domainBlacklist');

// Ниша-агностик: агрегаторы/каталоги/маркетплейсы услуг и отзовики, которые
// перехватывают трафик локального бизнеса, но не конкуренты ему.
const AGGREGATOR_DOMAINS = new Set([
  // Медицина
  'docdoc.ru', 'prodoctorov.ru', 'napopravku.ru', 'sberhealth.ru', 'doctu.ru',
  'infodoctor.ru', 'medbooking.com', '32top.ru', 'krasotaimedicina.ru',
  'doctorpiter.ru', 'health.mail.ru', 'medhouse.ru', 'zapiskdoktoru.ru',
  'gorzdrav.org', 'emiliaclinic.ru', 'stomatologclub.ru', 'stom-firms.ru',
  // Справочники / карты / каталоги организаций
  '2gis.ru', 'yell.ru', 'spr.ru', 'blizko.ru', 'orgpage.ru', 'zoon.ru',
  'rusprofile.ru', 'list-org.com', 'flamp.ru', 'gis.ru', 'yandex.ru',
  'uslugi.yandex.ru', 'firmika.ru', 'bldr.ru', 'tomesto.ru',
  // Маркетплейсы услуг
  'profi.ru', 'youdo.com', 'avito.ru', 'yudu.ru', 'remontnik.ru',
  // Отзовики
  'otzovik.com', 'irecommend.ru', 'otzyvru.com',
  // Юридические порталы
  '9111.ru', 'pravoved.ru', 'garant.ru', 'consultant.ru', 'sudact.ru',
  'nalog.ru', 'gosuslugi.ru',
  // Недвижимость
  'cian.ru', 'domclick.ru', 'avito.ru', 'domofond.ru',
]);

/**
 * Является ли хост агрегатором/справочником (по V2-списку).
 * @param {string} host — hostname (можно с www/субдоменом)
 * @returns {boolean}
 */
function isAggregatorV2(host) {
  if (!host) return false;
  const h = String(host).toLowerCase().replace(/^www\./, '').replace(/:.*$/, '');
  if (AGGREGATOR_DOMAINS.has(h)) return true;
  const reg = getRegistrableDomain(h);
  return !!reg && AGGREGATOR_DOMAINS.has(reg);
}

module.exports = { isAggregatorV2, AGGREGATOR_DOMAINS };
