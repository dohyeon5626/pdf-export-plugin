figma.showUI(__html__, { width: 320, height: 460 });

const ALLOWED_TYPES = ['FRAME', 'COMPONENT', 'INSTANCE'];

// Tracks the order in which nodes were selected. figma.currentPage.selection
// only reports layer (z-index) order, so we accumulate ids ourselves.
let orderedIds: string[] = [];

// Caches rendered thumbnails by node id so we only export newly added nodes
// on each selection change instead of re-rendering the whole list.
const thumbnailCache = new Map<string, number[]>();

async function renderThumbnail(node: SceneNode): Promise<number[]> {
  const cached = thumbnailCache.get(node.id);
  if (cached) return cached;

  const thumbnail = Array.from(
    await node.exportAsync({
      format: 'PNG',
      constraint: { type: 'HEIGHT', value: 48 },
    }),
  );
  thumbnailCache.set(node.id, thumbnail);
  return thumbnail;
}

async function sendSelection() {
  const selected = figma.currentPage.selection.filter((node) =>
    ALLOWED_TYPES.includes(node.type),
  );

  const nodeById = new Map(selected.map((node) => [node.id, node]));

  // Drop ids that are no longer selected, keeping the existing order.
  orderedIds = orderedIds.filter((id) => nodeById.has(id));

  // Evict cached thumbnails for nodes that are no longer selected.
  for (const id of thumbnailCache.keys()) {
    if (!nodeById.has(id)) thumbnailCache.delete(id);
  }

  // Newly added ids (selected since the last change) are appended. When
  // several appear at once, order them by name with natural number sorting.
  const newIds = selected
    .filter((node) => !orderedIds.includes(node.id))
    .sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true }))
    .map((node) => node.id);

  orderedIds.push(...newIds);

  const selection = orderedIds.map((id) => nodeById.get(id)!);

  const frames = await Promise.all(
    selection.map(async (node) => ({
      id: node.id,
      name: node.name,
      width: Math.round(node.width),
      height: Math.round(node.height),
      thumbnail: await renderThumbnail(node),
    })),
  );

  figma.ui.postMessage({ type: 'selection', frames });
}

sendSelection();

figma.on('selectionchange', sendSelection);

figma.ui.onmessage = async (msg: { type: string; order?: string[] }) => {
  if (msg.type === 'export-pdf') {
    const order = msg.order || [];

    try {
      const files: { id: string; bytes: number[] }[] = [];

      for (const id of order) {
        const node = await figma.getNodeByIdAsync(id);
        if (node && 'exportAsync' in node) {
          const bytes = await (node as SceneNode & ExportMixin).exportAsync({
            format: 'PDF',
          });
          files.push({ id, bytes: Array.from(bytes) });
        }
      }

      figma.ui.postMessage({ type: 'export-done', files });
    } catch (err) {
      figma.ui.postMessage({ type: 'error', message: `Export failed: ${err}` });
    }
  }

  if (msg.type === 'close') {
    figma.closePlugin();
  }
};
