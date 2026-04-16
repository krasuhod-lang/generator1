'use strict';

/**
 * parseTZ.js — парсер DOCX-файла технического задания.
 *
 * Извлекает из текста ТЗ поля для формы задачи:
 *   - input_target_service  (Главный запрос)
 *   - input_min_chars       (минимум символов)
 *   - input_max_chars       (максимум символов)
 *   - input_competitor_urls (список конкурентов, первые 4)
 *   - input_raw_lsi         (обязательные LSI — только слова, без вводного текста)
 *   - input_ngrams          (фразы из блока "Вписать фразы" — каждая строка отдельно)
 *   - input_tfidf_json      (из блока "Добавить на страницу важные слова")
 */

const mammoth = require('mammoth');

async function extractText(filePath) {
  const result = await mammoth.extractRawText({ path: filePath });
  return result.value || '';
}

async function parseTZ(filePath) {
  const text = await extractText(filePath);
  const lines = text.split('\n').map(l => l.trim()).filter(Boolean);

  const result = {
    input_target_service:  '',
    input_min_chars:       800,
    input_max_chars:       3500,
    input_competitor_urls: '',
    input_raw_lsi:         '',
    input_ngrams:          '',
    input_tfidf_json:      '[]',
  };

  // ── 1. Главный запрос ────────────────────────────────────────────────────────
  const targetMatch = text.match(/Главный\s+запрос\s*[:\-–—]\s*(.+)/i);
  if (targetMatch) {
    result.input_target_service = targetMatch[1].trim();
  } else {
    const themeMatch = text.match(/Тем[аы][^\u00AB]*[«"]([^»"]+)[»"]/i);
    if (themeMatch) result.input_target_service = themeMatch[1].trim();
  }

  // ── 2. Размер текста ─────────────────────────────────────────────────────────
  const sizeMatch = text.match(/от\s+(\d[\d\s]*)\s+до\s+(\d[\d\s]*)\s+символ/i);
  if (sizeMatch) {
    const minVal = parseInt(sizeMatch[1].replace(/\s/g, ''));
    const maxVal = parseInt(sizeMatch[2].replace(/\s/g, ''));
    if (minVal > 200)    result.input_min_chars = minVal;
    if (maxVal > minVal) result.input_max_chars = maxVal;
  } else {
    const rangeMatch = text.match(/(\d{3,6})\s*[-–—]\s*(\d{3,6})\s*символ/i);
    if (rangeMatch) {
      const minVal = parseInt(rangeMatch[1]);
      const maxVal = parseInt(rangeMatch[2]);
      if (minVal > 200)    result.input_min_chars = minVal;
      if (maxVal > minVal) result.input_max_chars = maxVal;
    }
  }

  // ── 3. URL конкурентов (первый блок "Список конкурентов") ────────────────────
  // Берём ПЕРВОЕ вхождение "Список конкурентов" — в блоке копирайтера
  const competitorSectionIdx = lines.findIndex(l =>
    /список\s+конкурентов/i.test(l)
  );

  if (competitorSectionIdx !== -1) {
    const urls = [];
    for (let i = competitorSectionIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      if (/^(Общие|Обязательные|Дополнительные|LSI|Технические|Структура|Общие требования)/i.test(line)) break;
      const urlMatch = line.match(/(https?:\/\/[^\s,;]+)/i);
      if (urlMatch) urls.push(urlMatch[1]);
      if (urls.length >= 4) break;
    }
    result.input_competitor_urls = urls.join('\n');
  }

  // ── 4. Обязательные LSI — только слова после вводного текста ────────────────
  // Структура в DOCX:
  //   "Обязательные LSI слова"           ← заголовок секции
  //   "Это слова, которые задают..."     ← вводный текст (пропускаем!)
  //   "желательно использовать их..."    ← ещё вводный текст (пропускаем!)
  //   "увидеть, истории, много, ..."     ← САМИ СЛОВА (берём)
  //   "Удобный сервис..."                ← стоп

  const mandatoryLsiIdx = lines.findIndex(l =>
    /Обязательные\s+LSI/i.test(l)
  );

  if (mandatoryLsiIdx !== -1) {
    const lsiWords = [];
    for (let i = mandatoryLsiIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      // Стоп — следующая секция
      if (/^(Дополнительные|LSI\s+слова,|Удобный|Вписать|Рекомендации|Промт)/i.test(line)) break;
      // Пропускаем вводные предложения (длинные фразы без запятых между короткими словами)
      // Признак вводного текста: начинается с "Это", "желательно", "Если"
      if (/^(Это\s|желательно|Если\s|Работайте|Важно)/i.test(line)) continue;
      // Пропускаем ссылки
      if (/https?:\/\//i.test(line)) continue;
      // Строка со словами: разбиваем по запятым
      const words = line.split(/[,;]+/).map(w => w.trim()).filter(w =>
        w.length > 1 && !/^https?/i.test(w) && !/^\d+$/.test(w)
      );
      if (words.length > 0) lsiWords.push(...words);
    }
    result.input_raw_lsi = lsiWords.join('\n');
  }

  // ── 5. N-граммы — из блока "Вписать фразы" ──────────────────────────────────
  // Структура в DOCX:
  //   "Вписать фразы"                    ← заголовок
  //   "Из этих словосочетаний можно..."  ← вводный текст (пропускаем)
  //   "Встречаются у многих..."          ← вводный текст (пропускаем)
  //   "кипарисовое озеро"                ← ФРАЗА (берём)
  //   "цветочных часов"                  ← ФРАЗА (берём)
  //   ...каждая строка = одна фраза...
  //   "В эту выгрузку могут попадать..." ← стоп

  const phrasesIdx = lines.findIndex(l =>
    /^Вписать\s+фразы/i.test(l)
  );

  if (phrasesIdx !== -1) {
    const phrases = [];
    for (let i = phrasesIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      // Стоп — следующие блоки
      if (/^(Рекомендации|Промт|Добавить|Сократить|Медианное|ТЗ для|Общие требования|В эту выгрузку)/i.test(line)) break;
      // Пропускаем вводные предложения
      if (/^(Из этих|Встречаются|Если вы|Это слова)/i.test(line)) continue;
      // Пропускаем ссылки
      if (/https?:\/\//i.test(line)) continue;
      // Каждая оставшаяся строка — фраза
      const phrase = line.trim();
      if (phrase.length > 1) phrases.push(phrase);
    }
    result.input_ngrams = phrases.join(', ');
  }

  // ── 6. TF-IDF — из блока "Добавить на страницу важные слова" ────────────────
  // Структура в DOCX:
  //   "Добавить на страницу важные слова"  ← заголовок
  //   "Важно делать это после..."          ← вводный текст (пропускаем)
  //   "Слово (...) места у вас повторяется 1 раз(а), а лучший диапазон для него это от 2 и до 8..."
  //   Извлекаем: слово + min + max → { term, rangeMin, rangeMax }

  const addWordsIdx = lines.findIndex(l =>
    /Добавить\s+на\s+страницу\s+важные\s+слова/i.test(l)
  );

  if (addWordsIdx !== -1) {
    const tfidfItems = [];
    for (let i = addWordsIdx + 1; i < lines.length; i++) {
      const line = lines[i];
      // Стоп — следующий блок
      if (/^(Сократить|Промт|Рекомендации|Медианное|ТЗ для|Можно ориентироваться)/i.test(line)) break;
      // Парсим строки вида:
      // "Слово (...) места у вас повторяется ... от 2 и до 8..."
      const m = line.match(/Слово\s+\([^)]+\)\s+(\S+)\s+у вас.*?от\s+(\d+)\s+и\s+до\s+(\d+)/i);
      if (m) {
        const term    = m[1].trim();
        const rangeMin = parseInt(m[2]);
        const rangeMax = parseInt(m[3]);
        tfidfItems.push({ term, rangeMin, rangeMax });
      }
    }
    if (tfidfItems.length > 0) {
      result.input_tfidf_json = JSON.stringify(tfidfItems);
    }
  }

  return result;
}

module.exports = { parseTZ };
