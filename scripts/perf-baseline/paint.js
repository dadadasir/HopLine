// Static empty document is ready; same double-rAF -> preload IPC endpoint.
requestAnimationFrame(() => requestAnimationFrame(() => window.baselinePaint()))
