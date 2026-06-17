export async function collectReportChartImages(rootEl) {
  const nodes = Array.from(rootEl?.querySelectorAll?.('[data-report-chart] svg') || []);
  const out = [];
  for (const svg of nodes) {
    const section = svg.closest('[data-report-chart]');
    const key = section?.getAttribute('data-report-chart') || 'chart';
    const title = section?.getAttribute('data-report-chart-title') || key;
    const dataUrl = await svgToPngDataUrl(svg);
    if (dataUrl) out.push({ key, title, data_url: dataUrl });
  }
  return out;
}

async function svgToPngDataUrl(svgEl) {
  if (!svgEl) return null;
  const clone = svgEl.cloneNode(true);
  clone.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
  const serialized = new XMLSerializer().serializeToString(clone);
  const blob = new Blob([serialized], { type: 'image/svg+xml;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  try {
    const img = await loadImage(url);
    const viewBox = svgEl.viewBox?.baseVal;
    const width = Math.max(1, Math.round(viewBox?.width || svgEl.clientWidth || 920));
    const height = Math.max(1, Math.round(viewBox?.height || svgEl.clientHeight || 320));
    const canvas = document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, width, height);
    ctx.drawImage(img, 0, 0, width, height);
    return canvas.toDataURL('image/png');
  } catch (_) {
    return null;
  } finally {
    URL.revokeObjectURL(url);
  }
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = reject;
    img.src = src;
  });
}

export function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}
