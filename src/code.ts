figma.showUI(__html__, { width: 320, height: 460 });

const ALLOWED_TYPES = ['FRAME', 'COMPONENT', 'INSTANCE'];

async function sendSelection() {
  const selection = figma.currentPage.selection.filter((node) =>
    ALLOWED_TYPES.includes(node.type),
  );

  const frames = await Promise.all(
    selection.map(async (node) => ({
      id: node.id,
      name: node.name,
      width: Math.round(node.width),
      height: Math.round(node.height),
      thumbnail: Array.from(
        await node.exportAsync({
          format: 'PNG',
          constraint: { type: 'HEIGHT', value: 48 },
        }),
      ),
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
