'use strict';

/**
 * siteCrawler/sectionClassifier.js — классификация верхнеуровневых разделов
 * сайта (Блог/Услуги/Новости/Каталог/О компании/Контакты…) по первому
 * сегменту URL. Нужна для читаемого «дерева сайта» на фронте (задача B):
 * каждому узлу проставляем sectionType + иконку + цвет.
 *
 * Чистая функция, без I/O. Словарь RU/EN синонимов расширяемый.
 */

// section key → { label, icon, color, synonyms:[...] }
const SECTIONS = [
  { key: 'blog',     label: 'Блог',        icon: '📝', color: '#7c3aed',
    syn: ['blog', 'блог', 'articles', 'article', 'статьи', 'статья', 'posts', 'journal', 'магазин-статей'] },
  { key: 'news',     label: 'Новости',     icon: '📰', color: '#0ea5e9',
    syn: ['news', 'новости', 'novosti', 'press', 'пресс', 'press-center', 'media', 'события', 'events'] },
  { key: 'services', label: 'Услуги',      icon: '🛠️', color: '#f59e0b',
    syn: ['services', 'service', 'услуги', 'uslugi', 'usluga', 'sluzhby'] },
  { key: 'catalog',  label: 'Каталог',     icon: '🗂️', color: '#16a34a',
    syn: ['catalog', 'catalogue', 'каталог', 'katalog', 'shop', 'store', 'магазин', 'products', 'product',
          'tovary', 'товары', 'goods', 'category', 'categories', 'kategorii'] },
  { key: 'about',    label: 'О компании',  icon: '🏢', color: '#0891b2',
    syn: ['about', 'about-us', 'о-компании', 'o-kompanii', 'o-nas', 'о-нас', 'company', 'kompaniya',
          'team', 'команда', 'история', 'history'] },
  { key: 'contacts', label: 'Контакты',    icon: '📞', color: '#dc2626',
    syn: ['contact', 'contacts', 'контакты', 'kontakty', 'kontakt'] },
  { key: 'prices',   label: 'Цены',        icon: '💰', color: '#ca8a04',
    syn: ['price', 'prices', 'pricing', 'цены', 'ceny', 'price-list', 'прайс', 'prajs', 'tariffs', 'тарифы', 'tarify'] },
  { key: 'portfolio',label: 'Портфолио',   icon: '🎨', color: '#db2777',
    syn: ['portfolio', 'портфолио', 'works', 'работы', 'raboty', 'cases', 'кейсы', 'keysy', 'projects', 'проекты'] },
  { key: 'faq',      label: 'FAQ',         icon: '❓', color: '#6366f1',
    syn: ['faq', 'вопросы', 'voprosy', 'help', 'помощь', 'support', 'поддержка', 'q-and-a'] },
  { key: 'reviews',  label: 'Отзывы',      icon: '⭐', color: '#eab308',
    syn: ['reviews', 'review', 'отзывы', 'otzyvy', 'testimonials'] },
  { key: 'delivery', label: 'Доставка',    icon: '🚚', color: '#0d9488',
    syn: ['delivery', 'доставка', 'dostavka', 'payment', 'оплата', 'oplata', 'shipping'] },
  { key: 'vacancies',label: 'Вакансии',    icon: '💼', color: '#7c3aed',
    syn: ['vacancy', 'vacancies', 'вакансии', 'vakansii', 'career', 'careers', 'карьера', 'jobs'] },
];

const _index = (() => {
  const m = new Map();
  for (const s of SECTIONS) for (const w of s.syn) m.set(w, s);
  return m;
})();

const DEFAULT_SECTION = { key: 'other', label: 'Другое', icon: '📄', color: '#64748b' };

/** Классифицирует по значению первого сегмента пути (без учёта регистра). */
function classifySegment(segment) {
  if (!segment) return DEFAULT_SECTION;
  const s = String(segment).toLowerCase().trim();
  if (_index.has(s)) return _index.get(s);
  // Мягкое совпадение: содержит синоним как подстроку (например blog-2024).
  for (const [w, sec] of _index) {
    if (s.length >= 3 && (s.startsWith(w) || s.includes(w))) return sec;
  }
  return DEFAULT_SECTION;
}

/**
 * Аннотирует дерево из treeBuilder.buildTree: детям корня и всем их потомкам
 * проставляет sectionType/sectionLabel/sectionIcon/sectionColor (наследуется от
 * верхнеуровневого раздела). Также считает pageCount (число реальных, не
 * virtual, страниц в поддереве). Мутирует и возвращает то же дерево.
 */
function annotate(tree) {
  if (!tree) return tree;

  function count(node) {
    let n = node.isVirtual ? 0 : 1;
    for (const c of (node.children || [])) n += count(c);
    node.pageCount = n;
    return n;
  }
  count(tree);

  for (const top of (tree.children || [])) {
    const sec = classifySegment(top.segment);
    applySection(top, sec);
  }
  // Корню — нейтральный тип.
  tree.sectionType = 'root';
  return tree;
}

function applySection(node, sec) {
  node.sectionType  = sec.key;
  node.sectionLabel = sec.label;
  node.sectionIcon  = sec.icon;
  node.sectionColor = sec.color;
  for (const c of (node.children || [])) applySection(c, sec);
}

module.exports = { classifySegment, annotate, SECTIONS, DEFAULT_SECTION };
