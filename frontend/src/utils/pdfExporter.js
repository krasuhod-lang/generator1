/**
 * pdfExporter.js (PR-6 эпика premium-ui-and-client-mode-implementation).
 *
 * Клиентский экспорт PDF премиум-отчёта через html2canvas + jsPDF.
 * Параметры взяты из ТЗ §6.6:
 *   • рендер HTML-узла в canvas с scale=2 (Retina, чёткие тексты/линии);
 *   • разбиение длинного canvas на страницы A4 с сохранением aspect ratio;
 *   • контейнер логотипа — object-fit: contain + конвертация в base64,
 *     чтобы не было обрезки кросс-доменных PNG/SVG (CORS-фолбэк отдельно
 *     в `imageToDataUrl`);
 *   • вёрстка предполагает белый фон и тёмный текст (стиль печати) —
 *     этим занимается компонент PrintableReport.vue.
 *
 * Серверный экспорт (PDFKit + DejaVu) уже есть для Smart Report Builder
 * (см. backend/src/services/reports/pdfExporter.js). Здесь — отдельная
 * клиентская дорожка для премиум-дашборда, как требует ТЗ.
 *
 * jsPDF и html2canvas грузим динамически (await import) — пакеты тяжёлые
 * (~370 KB gzip), и платить за них имеет смысл только когда пользователь
 * нажал «Скачать PDF», а не на каждом заходе на дашборд.
 */

const A4_WIDTH_MM  = 210;
const A4_HEIGHT_MM = 297;
const PAGE_MARGIN_MM = 10;

/**
 * Загружает изображение по URL и конвертирует в data:URL (base64).
 * Если URL уже data:* — возвращается как есть. CORS-падения превращаются
 * в `null`, чтобы вызывающий код мог использовать плейсхолдер.
 *
 * Это решает проблему обрезки логотипа при экспорте: html2canvas не
 * может прорендерить кросс-доменное изображение, и оно превращается в
 * пустой блок, который ломает layout. Конвертация в base64 эту проблему
 * убирает.
 */
export async function imageToDataUrl(url) {
  if (!url) return null;
  if (typeof url === 'string' && url.startsWith('data:')) return url;
  try {
    const res = await fetch(url, { mode: 'cors', credentials: 'omit' });
    if (!res.ok) return null;
    const blob = await res.blob();
    return await new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.onload  = () => resolve(reader.result);
      reader.onerror = () => reject(reader.error);
      reader.readAsDataURL(blob);
    });
  } catch (_) {
    return null;
  }
}

/**
 * Рендерит DOM-узел в PDF и сохраняет (либо возвращает blob).
 *
 * opts:
 *   • filename       — имя файла, по умолчанию 'executive-summary.pdf';
 *   • scale          — масштаб html2canvas (по умолчанию 2 для Retina);
 *   • backgroundColor— фон, по умолчанию '#ffffff' (печатный белый);
 *   • returnBlob     — если true, возвращает Blob вместо save().
 */
export async function exportNodeToPdf(node, opts = {}) {
  if (!node || !(node instanceof HTMLElement)) {
    throw new Error('exportNodeToPdf: node должен быть HTMLElement');
  }
  const {
    filename = 'executive-summary.pdf',
    scale = 2,
    backgroundColor = '#ffffff',
    returnBlob = false,
  } = opts;

  // Динамический импорт тяжёлых либ — экономит ~370 KB gzip на первый
  // заход дашборда; ждать ~200 мс при клике «Скачать PDF» — нормально.
  const [{ default: html2canvas }, jsPDFModule] = await Promise.all([
    import('html2canvas'),
    import('jspdf'),
  ]);
  const jsPDF = jsPDFModule.jsPDF || jsPDFModule.default;

  // Скрытые/невидимые элементы html2canvas всё равно учитывает, но мы хотим
  // зафиксировать высоту скролла — поэтому работаем с node.scrollHeight.
  const canvas = await html2canvas(node, {
    scale,
    backgroundColor,
    useCORS: true,
    allowTaint: false,
    logging: false,
    windowWidth: node.scrollWidth,
    windowHeight: node.scrollHeight,
  });

  const pdf = new jsPDF({ unit: 'mm', format: 'a4', orientation: 'portrait', compress: true });

  // Преобразуем пиксели canvas в миллиметры А4 с учётом полей.
  const contentWidthMm  = A4_WIDTH_MM  - PAGE_MARGIN_MM * 2;
  const contentHeightMm = A4_HEIGHT_MM - PAGE_MARGIN_MM * 2;
  const pxPerMm = canvas.width / contentWidthMm; // через ширину A4 без полей
  const fullHeightMm = canvas.height / pxPerMm;

  // Разбиваем длинный canvas на страницы. На каждой странице вырезаем
  // вертикальный слайс с источника через временный canvas — это
  // надёжнее, чем играть с `addImage` смещением и крайними пикселями.
  const sliceCanvas = document.createElement('canvas');
  sliceCanvas.width = canvas.width;
  const ctx = sliceCanvas.getContext('2d');

  const pageHeightPx = Math.floor(contentHeightMm * pxPerMm);
  let consumed = 0;
  let pageIndex = 0;

  while (consumed < canvas.height) {
    const remaining = canvas.height - consumed;
    const thisSliceHeightPx = Math.min(pageHeightPx, remaining);
    sliceCanvas.height = thisSliceHeightPx;
    ctx.fillStyle = backgroundColor;
    ctx.fillRect(0, 0, sliceCanvas.width, sliceCanvas.height);
    ctx.drawImage(
      canvas,
      0, consumed, canvas.width, thisSliceHeightPx,
      0, 0,        canvas.width, thisSliceHeightPx,
    );
    if (pageIndex > 0) pdf.addPage();
    const sliceHeightMm = thisSliceHeightPx / pxPerMm;
    pdf.addImage(
      sliceCanvas.toDataURL('image/png'),
      'PNG',
      PAGE_MARGIN_MM,
      PAGE_MARGIN_MM,
      contentWidthMm,
      sliceHeightMm,
      undefined,
      'FAST',
    );
    consumed += thisSliceHeightPx;
    pageIndex += 1;
    // Защита от бесконечного цикла на странных DPR.
    if (pageIndex > 50) break;
  }

  if (returnBlob) return pdf.output('blob');
  pdf.save(filename);
  return null;
}

/**
 * Удобный wrapper: подготавливает контекст (конвертирует логотип в base64,
 * ждёт `requestAnimationFrame` для финального layout-passа), затем
 * вызывает exportNodeToPdf.
 *
 * options:
 *   • logoUrl  — внешний URL логотипа; если передан, до экспорта
 *                функция вернёт data:URL, а вы должны положить его в
 *                реактивное состояние компонента ДО вызова экспорта,
 *                чтобы html2canvas снимал уже встроенный логотип.
 */
export async function prepareLogoForExport(logoUrl) {
  return imageToDataUrl(logoUrl);
}

/** Промис, который резолвится после следующего animation frame. */
export function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}

export default {
  exportNodeToPdf,
  imageToDataUrl,
  prepareLogoForExport,
  nextFrame,
};
