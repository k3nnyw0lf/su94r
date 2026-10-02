// The glucose report as a real PDF, made in the page with no library: the report is drawn to a
// canvas (through an SVG <foreignObject> with the report's own CSS), cut into US Letter pages,
// and each page is a JPEG image in a small hand-written PDF. Text is not selectable, but it
// prints and opens everywhere, and it can go to Drive or Telegram without a print dialog.

const PAGE_W = 612, PAGE_H = 792, MARGIN = 28;            // points (1/72 inch), US Letter

/** Draws `node` (and its CSS) onto a canvas `scale` times its CSS size. */
export async function rasterize(node, cssText, { scale = 2 } = {}) {
  const width = Math.ceil(node.getBoundingClientRect().width);
  const height = Math.ceil(node.scrollHeight);
  const clone = node.cloneNode(true);
  clone.style.margin = '0';
  const wrap = document.createElement('div');
  wrap.setAttribute('xmlns', 'http://www.w3.org/1999/xhtml');
  wrap.style.width = `${width}px`;
  wrap.style.background = '#fff';
  const style = document.createElement('style');
  // Named fonts: inside an SVG image the system-ui keyword falls back to a serif face.
  style.textContent = `${cssText}
.report, .report * { font-family: "Segoe UI", Roboto, Arial, Helvetica, sans-serif; }`;
  wrap.append(style, clone);
  const xhtml = new XMLSerializer().serializeToString(wrap);
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}"><foreignObject x="0" y="0" width="100%" height="100%">${xhtml}</foreignObject></svg>`;
  const img = new Image();
  img.decoding = 'sync';
  await new Promise((resolve, reject) => {
    img.onload = resolve;
    img.onerror = () => reject(new Error('Could not draw the report.'));
    img.src = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
  });
  const canvas = document.createElement('canvas');
  canvas.width = Math.ceil(width * scale);
  canvas.height = Math.ceil(height * scale);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, canvas.width, canvas.height);
  ctx.drawImage(img, 0, 0, canvas.width, canvas.height);
  return canvas;
}

/** Cuts a tall canvas into page-sized JPEGs: [{ bytes, w, h }]. */
export async function pagesFrom(canvas, { quality = 0.85 } = {}) {
  const usableW = PAGE_W - 2 * MARGIN;
  const usableH = PAGE_H - 2 * MARGIN;
  const pxPerPt = canvas.width / usableW;
  const slice = Math.floor(usableH * pxPerPt);
  const pages = [];
  for (let y = 0; y < canvas.height; y += slice) {
    const h = Math.min(slice, canvas.height - y);
    const part = document.createElement('canvas');
    part.width = canvas.width;
    part.height = h;
    const c = part.getContext('2d');
    c.fillStyle = '#fff';
    c.fillRect(0, 0, part.width, h);
    c.drawImage(canvas, 0, y, canvas.width, h, 0, 0, canvas.width, h);
    const blob = await new Promise((r) => part.toBlob(r, 'image/jpeg', quality));
    pages.push({ bytes: new Uint8Array(await blob.arrayBuffer()), w: part.width, h });
  }
  return pages;
}

/** A PDF with one JPEG per page, each drawn at the top of a Letter page with margins. */
export function jpegPdf(pages, { title = 'Glucose report' } = {}) {
  const enc = (s) => Uint8Array.from(s, (ch) => ch.charCodeAt(0) & 0xff);
  const parts = [];
  const offsets = [];
  let length = 0;
  const push = (chunk) => { const b = typeof chunk === 'string' ? enc(chunk) : chunk; parts.push(b); length += b.length; };
  const obj = (n, body) => { offsets[n] = length; push(`${n} 0 obj\n`); for (const b of [].concat(body)) push(b); push('\nendobj\n'); };

  push('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n');
  const n = pages.length;
  const pageIds = pages.map((_, i) => 4 + i * 3);
  obj(1, '<< /Type /Catalog /Pages 2 0 R >>');
  obj(2, `<< /Type /Pages /Count ${n} /Kids [${pageIds.map((id) => `${id} 0 R`).join(' ')}] >>`);
  obj(3, `<< /Title (${title.replace(/[()\\]/g, '')}) /Producer (su94r Mini) >>`);
  pages.forEach((p, i) => {
    const pageId = 4 + i * 3, contentId = pageId + 1, imageId = pageId + 2;
    const scale = (PAGE_W - 2 * MARGIN) / p.w;
    const drawW = (p.w * scale).toFixed(2), drawH = (p.h * scale).toFixed(2);
    const x = MARGIN, y = (PAGE_H - MARGIN - p.h * scale).toFixed(2);
    const content = `q ${drawW} 0 0 ${drawH} ${x} ${y} cm /Im0 Do Q`;
    obj(pageId, `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /XObject << /Im0 ${imageId} 0 R >> >> /Contents ${contentId} 0 R >>`);
    obj(contentId, [`<< /Length ${content.length} >>\nstream\n`, content, '\nendstream']);
    obj(imageId, [`<< /Type /XObject /Subtype /Image /Width ${p.w} /Height ${p.h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${p.bytes.length} >>\nstream\n`, p.bytes, '\nendstream']);
  });
  const total = 4 + n * 3;
  const xref = length;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let i = 1; i < total; i++) push(`${String(offsets[i]).padStart(10, '0')} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R /Info 3 0 R >>\nstartxref\n${xref}\n%%EOF\n`);
  const out = new Uint8Array(length);
  let at = 0;
  for (const b of parts) { out.set(b, at); at += b.length; }
  return out;
}

/** The report element as PDF bytes. */
export async function reportPdf(node, cssText, opts = {}) {
  const canvas = await rasterize(node, cssText, { scale: opts.scale || 2 });
  return jpegPdf(await pagesFrom(canvas, opts), opts);
}

export function toBase64(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
