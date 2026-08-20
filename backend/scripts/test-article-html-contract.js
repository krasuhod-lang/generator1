'use strict';

const assert = require('assert');
const {
  validateArticleHtmlContract,
} = require('../src/services/content/articleHtmlContract');
const { checkHtmlContract } = require('../src/services/qualityCore/checkers');
const { finalize } = require('../src/services/qualityCore/qualityGate');

const outline = {
  sections: [
    { index: 1, h2: 'Что входит в конструкцию' },
    { index: 2, h2: 'Как проверить совместимость' },
  ],
};

const validHtml = [
  '<h1>Двухсоставной тормозной диск</h1>',
  '<p class="byline">Автор: Редакция, редакционная команда. Обновлено: <time datetime="2026-08-20">2026-08-20</time></p>',
  '<p class="lead-answer">Двухсоставной тормозной диск состоит из ротора и колокола, соединённых крепежом; конкретные допуски проверяют по спецификации производителя.</p>',
  '<nav class="toc"><ol><li><a href="#sec-1">Что входит в конструкцию</a></li><li><a href="#sec-2">Как проверить совместимость</a></li><li><a href="#sec-faq">FAQ</a></li><li><a href="#sec-summary">Итоги</a></li><li><a href="#sec-conclusion">Заключение</a></li></ol></nav>',
  '<h2 id="sec-1">Что входит в конструкцию</h2>',
  '<p class="answer-lead">Конструкция включает ротор, колокол и крепёж.</p>',
  '<p>Ротор работает с колодками, а колокол соединяет диск со ступицей.</p>',
  '<h2 id="sec-2">Как проверить совместимость</h2>',
  '<p class="answer-lead">Совместимость проверяют по каталожному номеру, ступице и суппорту.</p>',
  '<ul><li>Проверьте штатный размер и вылет.</li><li>Сверьте спецификацию.</li></ul>',
  '<blockquote class="expert-opinion"><p><strong>Мнение эксперта.</strong> При монтаже сначала очищают посадочную поверхность и измеряют биение.</p><footer>— <cite>практикующий специалист по теме материала</cite></footer></blockquote>',
  '<h2 id="sec-faq">Часто задаваемые вопросы</h2>',
  '<h3>Какой момент затяжки нужен?</h3><p>Точный момент берут из спецификации конкретного крепежа.</p>',
  '<h3>Как проверить люфт?</h3><p>Используют процедуру производителя и подходящий измерительный инструмент.</p>',
  '<h3>Что делать при вибрации?</h3><p>Проверяют ступицу, посадку, подшипник и биение.</p>',
  '<h3>Подходит ли диск для города?</h3><p>Решение зависит от режима эксплуатации и стоимости владения.</p>',
  '<section class="summary"><h2 id="sec-summary">Итоги</h2><ul><li>Ротор и колокол имеют разные функции.</li><li>Допуски берут из спецификации.</li><li>Совместимость проверяют до покупки.</li></ul></section>',
  '<h2 id="sec-conclusion">Заключение</h2><p>Выбор зависит от автомобиля, режима и документации.</p>',
].join('');

const valid = validateArticleHtmlContract(validHtml, {
  pipeline: 'info',
  outline,
  currentYear: 2026,
  today: '2026-08-20',
});
assert.strictEqual(valid.ok, true, valid.issueTexts.join('\n'));
assert.strictEqual(checkHtmlContract(valid).pass, true);

const badHtml = [
  '<h1>Двухсоставной тормозной диск</h1>',
  '<nav class="toc"><a href="#sec-7">Ответы</a><a href="#sec-faq">FAQ</a></nav>',
  '<h2 id="sec-1">Конструкция</h2><p>Описание без atomic lead.</p>',
].join('');

const bad = validateArticleHtmlContract(badHtml, {
  pipeline: 'link',
  outline,
  currentYear: 2026,
  today: '2026-08-20',
});
assert.strictEqual(bad.ok, false);
for (const category of ['byline', 'lead_answer', 'expert_opinion', 'faq_block', 'summary_block', 'conclusion']) {
  assert.ok(
    bad.issues.some((item) => item.category === category),
    `Expected blocker category ${category}`,
  );
}
assert.strictEqual(checkHtmlContract(bad).pass, false);
assert.strictEqual(checkHtmlContract(bad).blocking, true);
const gate = finalize('info', { htmlContractReport: bad, html: badHtml });
assert.strictEqual(gate.canPublish, false);
assert.ok(gate.blockers.some((item) => item.name === 'html_contract'));

const future = validateArticleHtmlContract(
  validHtml.replace('2026-08-20">2026-08-20', '2027-01-01">2027-01-01'),
  { pipeline: 'info', outline, currentYear: 2026, today: '2026-08-20' },
);
assert.ok(future.issues.some((item) => item.category === 'future_date'));

console.log('test-article-html-contract: 3 scenarios passed');
