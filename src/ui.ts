import { PDFDocument } from 'pdf-lib';

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

exportBtn.addEventListener('click', () => {
  if (frames.length === 0) return;
  exportBtn.disabled = true;
  setStatus('Exporting\u2026', 'loading');
  const order = frames.map((f) => f.id);
  parent.postMessage({ pluginMessage: { type: 'export-pdf', order } }, '*');
});

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

      setStatus(`Exported ${msg.files.length} page(s).`, 'success');
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
