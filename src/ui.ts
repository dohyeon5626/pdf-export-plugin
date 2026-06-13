import {
  PDFDocument,
  PDFName,
  PDFNumber,
  PDFRawStream,
  PDFRef,
} from 'pdf-lib';

// Map the quality slider to a re-encode preset. Size is reduced mainly by
// lowering resolution (scale); JPEG quality is kept in a safe band (0.6–0.85)
// so images just look softer instead of breaking up into blocky artifacts.
// 100 means "Original" — skip recompression. Vector content is never affected.
function presetFor(value: number): { scale: number; quality: number } | null {
  if (value >= 100) return null;
  return {
    scale: Math.min(1, 0.1 + 0.009 * value),
    quality: 0.6 + 0.0025 * value,
  };
}

interface FrameInfo {
  id: string;
  name: string;
  width: number;
  height: number;
  thumbnail: number[];
}

let frames: FrameInfo[] = [];

const listEl = document.getElementById('frame-list') as HTMLDivElement;
const exportBtn = document.getElementById('export') as HTMLButtonElement;
const statusEl = document.getElementById('status') as HTMLDivElement;
const emptyEl = document.getElementById('empty') as HTMLDivElement;
const countEl = document.getElementById('count') as HTMLSpanElement;
const qualityEl = document.getElementById('quality') as HTMLInputElement;
const qualityValueEl = document.getElementById('quality-value') as HTMLSpanElement;

qualityEl.addEventListener('input', () => {
  const v = Number(qualityEl.value);
  qualityValueEl.textContent = v >= 100 ? 'Original' : `${v}%`;
});

let draggedIndex: number | null = null;

function setStatus(text: string, type: 'loading' | 'success' | 'error' = 'loading') {
  statusEl.textContent = text;
  statusEl.className = 'status' + (text ? ` ${type}` : '');
}

function render() {
  listEl.innerHTML = '';

  if (frames.length === 0) {
    emptyEl.style.display = 'flex';
    exportBtn.disabled = true;
    countEl.textContent = '';
    return;
  }

  emptyEl.style.display = 'none';
  exportBtn.disabled = false;
  countEl.textContent = `${frames.length} frame${frames.length !== 1 ? 's' : ''}`;

  frames.forEach((frame, index) => {
    const item = document.createElement('div');
    item.className = 'frame-item';
    item.draggable = true;
    item.dataset.index = String(index);

    const orderNum = document.createElement('div');
    orderNum.className = 'order-num';
    orderNum.textContent = String(index + 1);

    const thumb = document.createElement('img');
    thumb.className = 'thumbnail';
    const blob = new Blob([new Uint8Array(frame.thumbnail)], { type: 'image/png' });
    thumb.src = URL.createObjectURL(blob);

    const info = document.createElement('div');
    info.className = 'frame-info';

    const name = document.createElement('div');
    name.className = 'frame-name';
    name.textContent = frame.name;

    const size = document.createElement('div');
    size.className = 'frame-size';
    size.textContent = `${frame.width} \u00d7 ${frame.height}`;

    info.appendChild(name);
    info.appendChild(size);

    const handle = document.createElement('div');
    handle.className = 'drag-handle';
    handle.innerHTML =
      '<svg width="8" height="14" viewBox="0 0 8 14" fill="currentColor">' +
      '<circle cx="1.5" cy="2" r="1"/><circle cx="6.5" cy="2" r="1"/>' +
      '<circle cx="1.5" cy="7" r="1"/><circle cx="6.5" cy="7" r="1"/>' +
      '<circle cx="1.5" cy="12" r="1"/><circle cx="6.5" cy="12" r="1"/>' +
      '</svg>';

    item.appendChild(orderNum);
    item.appendChild(thumb);
    item.appendChild(info);
    item.appendChild(handle);

    item.addEventListener('dragstart', (e) => {
      draggedIndex = index;
      item.classList.add('dragging');
      e.dataTransfer!.effectAllowed = 'move';
    });

    item.addEventListener('dragend', () => {
      item.classList.remove('dragging');
      draggedIndex = null;
      listEl.querySelectorAll('.frame-item').forEach((el) =>
        el.classList.remove('drag-over'),
      );
    });

    item.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'move';
      if (draggedIndex !== null && draggedIndex !== index) {
        item.classList.add('drag-over');
      }
    });

    item.addEventListener('dragleave', () => {
      item.classList.remove('drag-over');
    });

    item.addEventListener('drop', (e) => {
      e.preventDefault();
      item.classList.remove('drag-over');
      if (draggedIndex === null || draggedIndex === index) return;
      const [moved] = frames.splice(draggedIndex, 1);
      frames.splice(index, 0, moved);
      render();
    });

    listEl.appendChild(item);
  });
}

let selectedQualityValue = 100;

exportBtn.addEventListener('click', () => {
  if (frames.length === 0) return;
  exportBtn.disabled = true;
  setStatus('Exporting\u2026', 'loading');
  selectedQualityValue = Number(qualityEl.value);
  const order = frames.map((f) => f.id);
  parent.postMessage({ pluginMessage: { type: 'export-pdf', order } }, '*');
});

// Inflate a zlib (PDF FlateDecode) stream using the browser's built-in
// DecompressionStream, so we don't need a third-party inflate dependency.
async function inflate(data: Uint8Array): Promise<Uint8Array> {
  const ds = new DecompressionStream('deflate');
  const stream = new Blob([data as BlobPart]).stream().pipeThrough(ds);
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

// Walk every image XObject in the PDF and re-encode it as a smaller JPEG.
// Vector content is untouched. Images used as masks (which carry transparency
// as grayscale) are skipped so we don't corrupt them. Returns stats so the UI
// can report how many images were actually shrunk.
async function recompressImages(
  pdf: PDFDocument,
  preset: { scale: number; quality: number },
): Promise<{ total: number; done: number; saved: number }> {
  const objects = pdf.context.enumerateIndirectObjects();

  // Collect refs referenced as a soft mask or stencil mask; those images must
  // stay grayscale and are left alone.
  const maskTags = new Set<string>();
  for (const [, obj] of objects) {
    if (!(obj instanceof PDFRawStream)) continue;
    for (const key of ['SMask', 'Mask']) {
      const m = obj.dict.get(PDFName.of(key));
      if (m instanceof PDFRef) maskTags.add(m.toString());
    }
  }

  let total = 0;
  let done = 0;
  let saved = 0;

  for (const [ref, obj] of objects) {
    if (!(obj instanceof PDFRawStream)) continue;
    const dict = obj.dict;

    if (dict.lookup(PDFName.of('Subtype'))?.toString() !== '/Image') continue;
    if (maskTags.has(ref.toString())) continue;
    if (dict.lookup(PDFName.of('ImageMask'))?.toString() === 'true') continue;

    const width = dict.lookup(PDFName.of('Width'), PDFNumber)?.asNumber();
    const height = dict.lookup(PDFName.of('Height'), PDFNumber)?.asNumber();
    if (!width || !height) continue;

    const bpc = dict.lookup(PDFName.of('BitsPerComponent'), PDFNumber);
    if (bpc && bpc.asNumber() !== 8) continue;

    const filterStr = dict.lookup(PDFName.of('Filter'))?.toString() ?? '';
    total++;

    try {
      let bitmap: ImageBitmap;

      if (filterStr.includes('DCTDecode')) {
        // Already a JPEG (any color space) — let the browser decode it.
        bitmap = await createImageBitmap(
          new Blob([obj.contents as BlobPart], { type: 'image/jpeg' }),
        );
      } else if (
        filterStr.includes('FlateDecode') &&
        !filterStr.includes('ASCII') &&
        !dict.lookup(PDFName.of('DecodeParms'))
      ) {
        // Raw deflated samples (no PNG predictor). Infer the channel count
        // from the decoded length and only handle 3-channel RGB.
        const raw = await inflate(obj.contents);
        if (Math.floor(raw.length / (width * height)) !== 3) continue;
        const rgba = new Uint8ClampedArray(width * height * 4);
        for (let i = 0; i < width * height; i++) {
          rgba[i * 4] = raw[i * 3];
          rgba[i * 4 + 1] = raw[i * 3 + 1];
          rgba[i * 4 + 2] = raw[i * 3 + 2];
          rgba[i * 4 + 3] = 255;
        }
        bitmap = await createImageBitmap(new ImageData(rgba, width, height));
      } else {
        continue; // Unsupported filter (e.g. predictor'd Flate).
      }

      const targetW = Math.max(1, Math.round(width * preset.scale));
      const targetH = Math.max(1, Math.round(height * preset.scale));

      const canvas = document.createElement('canvas');
      canvas.width = targetW;
      canvas.height = targetH;
      const ctx = canvas.getContext('2d')!;
      ctx.imageSmoothingEnabled = true;
      ctx.imageSmoothingQuality = 'high';
      ctx.drawImage(bitmap, 0, 0, targetW, targetH);
      bitmap.close();

      const jpegBlob = await new Promise<Blob | null>((resolve) =>
        canvas.toBlob(resolve, 'image/jpeg', preset.quality),
      );
      if (!jpegBlob) continue;
      const jpegBytes = new Uint8Array(await jpegBlob.arrayBuffer());

      // Keep the original if re-encoding didn't actually save space.
      if (jpegBytes.length >= obj.contents.length) continue;

      dict.set(PDFName.of('Filter'), PDFName.of('DCTDecode'));
      dict.set(PDFName.of('Width'), PDFNumber.of(targetW));
      dict.set(PDFName.of('Height'), PDFNumber.of(targetH));
      dict.set(PDFName.of('BitsPerComponent'), PDFNumber.of(8));
      dict.set(PDFName.of('ColorSpace'), PDFName.of('DeviceRGB'));
      dict.delete(PDFName.of('DecodeParms'));
      dict.delete(PDFName.of('Decode'));
      dict.set(PDFName.of('Length'), PDFNumber.of(jpegBytes.length));

      pdf.context.assign(ref, PDFRawStream.of(dict, jpegBytes));
      done++;
      saved += obj.contents.length - jpegBytes.length;
    } catch {
      // On any failure, leave the original image untouched.
      continue;
    }
  }

  return { total, done, saved };
}

window.onmessage = async (event) => {
  const msg = event.data.pluginMessage;
  if (!msg) return;

  if (msg.type === 'selection') {
    frames = msg.frames;
    setStatus('');
    render();
  }

  if (msg.type === 'export-done') {
    try {
      const mergedPdf = await PDFDocument.create();

      for (const file of msg.files) {
        const pdfBytes = new Uint8Array(file.bytes);
        const pdf = await PDFDocument.load(pdfBytes);
        const pages = await mergedPdf.copyPages(pdf, pdf.getPageIndices());
        pages.forEach((page) => mergedPdf.addPage(page));
      }

      // Recompress embedded images to shrink the file. Vector content (text,
      // shapes) is left untouched.
      let stats: { total: number; done: number; saved: number } | null = null;
      const preset = presetFor(selectedQualityValue);
      if (preset) {
        stats = await recompressImages(mergedPdf, preset);
      }

      const finalBytes = await mergedPdf.save();
      const blob = new Blob([finalBytes.buffer as ArrayBuffer], { type: 'application/pdf' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `${frames[0].name}.pdf`;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      const sizeMB = (finalBytes.length / 1048576).toFixed(2);
      let detail = '';
      if (stats) {
        const savedMB = (stats.saved / 1048576).toFixed(2);
        detail = ` · ${stats.done}/${stats.total} imgs · saved ${savedMB} MB`;
      }
      setStatus(`${sizeMB} MB (${msg.files.length}p)${detail}`, 'success');
    } catch (err) {
      setStatus(`Export failed: ${err}`, 'error');
    }
    exportBtn.disabled = false;
  }

  if (msg.type === 'error') {
    setStatus(msg.message, 'error');
    exportBtn.disabled = false;
  }
};
