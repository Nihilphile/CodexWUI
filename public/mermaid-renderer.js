(() => {
  const config = {
    startOnLoad: false, securityLevel: 'strict', theme: 'dark',
    htmlLabels: false, flowchart: { htmlLabels: false },
    fontFamily: 'system-ui, sans-serif', maxTextSize: 50000, maxEdges: 500,
    suppressErrorRendering: true,
    secure: ['secure', 'securityLevel', 'startOnLoad', 'maxTextSize', 'maxEdges', 'suppressErrorRendering', 'htmlLabels', 'flowchart'],
  };
  const send = value => parent.postMessage({ codexMermaid: 1, ...value }, '*');
  let queue = Promise.resolve();
  addEventListener('message', event => {
    const data = event.data;
    if (event.source !== parent || data?.codexMermaid !== 1 || !Number.isSafeInteger(data.id) || typeof data.source !== 'string' || data.source.length > 50000) return;
    queue = queue.then(async () => {
      try {
        // Reset per diagram so directives cannot affect subsequent messages.
        mermaid.initialize(config);
        const { svg } = await mermaid.render(`mermaid-${data.id}`, data.source);
        const image = new DOMParser().parseFromString(svg, 'image/svg+xml').documentElement;
        const box = image.viewBox.baseVal;
        if (box.width > 0 && box.height > 0) {
          image.setAttribute('width', String(Math.ceil(box.width)));
          image.setAttribute('height', String(Math.ceil(box.height)));
        }
        send({ id: data.id, svg: new XMLSerializer().serializeToString(image) });
      } catch { send({ id: data.id, error: true }); }
    });
  });
  send({ ready: true });
})();
