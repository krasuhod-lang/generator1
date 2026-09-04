import assert from 'node:assert/strict';
import { JSDOM } from 'jsdom';
import { buildAcfFromHtml, buildAcfSections } from '../../frontend/src/utils/acfDeterministicBuilder.js';

const dom = new JSDOM('<!doctype html><html><body></body></html>');
globalThis.DOMParser = dom.window.DOMParser;

const longHeading = 'Очень длинный заголовок секции без сокращения: подробное описание услуги, условий, этапов, ограничений и результата для целевой аудитории';
const longParagraph = 'Этот абзац содержит полный фактический текст, артикул ZX-2026-ALPHA, сумму 185 000 рублей и завершающую часть, которая раньше могла исчезнуть после ограничения длины поля или ответа модели.';
const longListItem = 'Пункт списка с подробным описанием результата, состава работ, сроков, гарантий, ограничений и условий сопровождения клиента без потери хвостовой части строки';

const html = [
  `<h2>${longHeading}</h2>`,
  `<p>${longParagraph}</p>`,
  '<figure><img src="data:image/png;base64,AAAA" alt="служебное изображение"><figcaption>Подпись к изображению с важным пояснением, которую нельзя терять при очистке media</figcaption></figure>',
  '<h2>Стоимость и состав работ</h2>',
  '<table><thead><tr><th>Услуга</th><th>Цена</th></tr></thead><tbody>',
  `<tr><td>${longListItem}</td><td>185 000 ₽</td></tr>`,
  '</tbody></table>',
  '<h2>Этапы выполнения</h2>',
  `<ol><li>${longListItem}</li></ol>`,
].join('');

const sections = buildAcfSections(html);
const result = buildAcfFromHtml(html);
const serialized = JSON.stringify(result);

assert.equal(sections.length, 3, 'HTML должен быть разделён на три h2-секции');
assert(serialized.includes(longHeading), 'длинный заголовок полностью сохранён в JSON');
assert(serialized.includes(longParagraph), 'длинный абзац полностью сохранён в JSON');
assert(serialized.includes('Подпись к изображению с важным пояснением, которую нельзя терять при очистке media'), 'текстовая подпись figure сохранена в JSON');
assert(serialized.includes(longListItem), 'длинный пункт списка полностью сохранён в JSON');
assert(serialized.includes('185 000 ₽'), 'цена полностью сохранена в JSON');
assert(!serialized.includes(`${longHeading.slice(0, 89)}…`), 'заголовок не должен быть усечён лимитом title');
assert(!serialized.includes(`${longListItem.slice(0, 59)}…`), 'пункт списка не должен быть усечён лимитом title');

console.log('ACF_BUILDER_PRESERVATION_OK');
console.log(`blocks=${result.length}; json_chars=${serialized.length}`);
