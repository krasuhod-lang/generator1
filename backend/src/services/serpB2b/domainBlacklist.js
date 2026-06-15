'use strict';

/**
 * Список доменов, которые нужно отбрасывать на этапе SERP-фильтрации.
 * Это маркетплейсы / агрегаторы / справочники / соцсети — даже если они
 * выпадают по B2B-запросу, контактов нужного нам поставщика на их
 * страницах нет (там либо листинг чужих компаний, либо профили частных
 * лиц). Сравнение идёт по «зарегистрированному» домену 2-го уровня
 * (без поддоменов), плюс отдельные точные хосты.
 */

const BLACKLIST_DOMAINS = new Set([
  // Маркетплейсы / агрегаторы товаров
  'avito.ru', 'youla.ru', 'drom.ru', 'auto.ru', 'farpost.ru',
  'ozon.ru', 'wildberries.ru', 'aliexpress.ru', 'aliexpress.com',
  'market.yandex.ru', 'megamarket.ru', 'goods.ru', 'sbermarket.ru',
  'kazanexpress.ru', 'lamoda.ru', 'detmir.ru', 'dns-shop.ru',
  'mvideo.ru', 'eldorado.ru', 'citilink.ru', 'leroymerlin.ru',
  'petrovich.ru', 'vseinstrumenti.ru', '220-volt.ru',
  // B2B/оптовые агрегаторы / тендерные площадки
  'flagma.ru', 'pulscen.ru', 'tiu.ru', 'all.biz', 'rosfirm.ru',
  'satom.ru', 'supl.biz', 'blizko.ru', 'tender.pro', 'b2b-center.ru',
  'rutender.ru', 'zakupki.gov.ru', 'roseltorg.ru', 'sberbank-ast.ru',
  'fabrikant.ru', 'tendery.ru', 'rts-tender.ru', 'opt-union.ru',
  'optlist.ru', 'optomarket.su', 'wholesale.ru',
  // Недвижимость (ЦИАН и пр.)
  'cian.ru', 'realty.yandex.ru', 'domclick.ru', 'n1.ru', 'mirkvartir.ru',
  'irr.ru', 'gdeetotdom.ru', 'restate.ru', 'novostroy.ru',
  // Услуги / фриланс / job
  'youdo.com', 'profi.ru', 'remontnik.ru', 'tiu.ru', 'fl.ru',
  'kwork.ru', 'freelance.ru', 'workzilla.com',
  'hh.ru', 'superjob.ru', 'rabota.ru', 'zarplata.ru', 'avitojobs.ru',
  // Туризм / билеты / отели
  'tutu.ru', 'aviasales.ru', 'aviasales.com', 'skyscanner.ru',
  'booking.com', 'ostrovok.ru', 'tripadvisor.ru', 'tripadvisor.com',
  'level.travel', 'travelata.ru', 'sletat.ru',
  // Справочники / карты / поисковики
  'yandex.ru', 'maps.yandex.ru', 'yandex.com', 'yandex.kz', 'yandex.by',
  '2gis.ru', '2gis.com', 'spravka.city', 'orgs.ru',
  'google.com', 'google.ru', 'maps.google.com', 'youtube.com',
  'wikipedia.org', 'ru.wikipedia.org', 'bing.com', 'mail.ru',
  'rambler.ru', 'duckduckgo.com', 'sputnik.ru',
  // Соцсети / мессенджеры / видеохостинги
  'vk.com', 'vk.ru', 'ok.ru', 'facebook.com', 'instagram.com',
  't.me', 'telegram.me', 'telegram.org', 'twitter.com', 'x.com',
  'rutube.ru', 'dzen.ru', 'zen.yandex.ru', 'pikabu.ru',
  'tiktok.com', 'pinterest.com', 'pinterest.ru', 'linkedin.com',
  'whatsapp.com', 'wa.me', 'viber.com',
  // Отзовики и обзоры
  'otzovik.com', 'irecommend.ru', 'flamp.ru', 'zoon.ru', 'orgpage.ru',
  'spravker.ru', 'yell.ru', 'rusprofile.ru', 'list-org.com',
  'sbis.ru', 'kontur.ru', 'focus.kontur.ru', 'spark-interfax.ru',
  'tinkoff.ru', 'bank.tinkoff.ru', 'checko.ru', 'ofd.nalog.ru',
  'nalog.gov.ru', 'nalog.ru', 'audit-it.ru', 'rusbase.com',
  // Информационные/новостные/каталоги статей
  'habr.com', 'vc.ru', 'lenta.ru', 'rbc.ru', 'kommersant.ru',
  'forbes.ru', 'tass.ru', 'ria.ru', 'gazeta.ru', 'kp.ru',
  'livejournal.com', 'medium.com', 'reddit.com',
  // Q&A / форумы
  'otvet.mail.ru', 'thequestion.ru', 'quora.com', 'forum.ixbt.com',
  // Почтовые сервисы
  'gmail.com', 'outlook.com', 'icloud.com',
]);

const BLACKLIST_HOST_PREFIXES = [
  'maps.', 'm.maps.', 'translate.', 'docs.google.', 'drive.google.',
];

function _stripWww(host) {
  return host.replace(/^www\./i, '');
}

const _COMPOUND_SUFFIXES = [
  'co.uk', 'co.il', 'co.jp', 'co.kr',
  'com.ua', 'com.tr', 'com.cn', 'com.au', 'com.br',
  'org.ru', 'net.ru', 'com.ru', 'pp.ru', 'msk.ru', 'spb.ru',
  'org.ua', 'net.ua', 'kiev.ua',
];

function getRegistrableDomain(host) {
  if (!host) return '';
  const h = _stripWww(String(host).toLowerCase()).replace(/:.*$/, '');
  for (const sfx of _COMPOUND_SUFFIXES) {
    if (h === sfx || h.endsWith('.' + sfx)) {
      const head = h.slice(0, h.length - sfx.length).replace(/\.$/, '');
      const lastLabel = head.split('.').pop() || '';
      return lastLabel ? `${lastLabel}.${sfx}` : sfx;
    }
  }
  const parts = h.split('.');
  if (parts.length <= 2) return h;
  return parts.slice(-2).join('.');
}

function isBlacklistedHost(host) {
  if (!host) return true;
  const h = _stripWww(String(host).toLowerCase());
  if (BLACKLIST_DOMAINS.has(h)) return true;
  const reg = getRegistrableDomain(h);
  if (reg && BLACKLIST_DOMAINS.has(reg)) return true;
  for (const p of BLACKLIST_HOST_PREFIXES) {
    if (h.startsWith(p)) return true;
  }
  return false;
}

function isBlacklistedUrl(url) {
  try {
    const u = new URL(url);
    if (!/^https?:$/i.test(u.protocol)) return true;
    return isBlacklistedHost(u.hostname);
  } catch (_) {
    return true;
  }
}

module.exports = {
  isBlacklistedHost,
  isBlacklistedUrl,
  getRegistrableDomain,
  BLACKLIST_DOMAINS,
};
