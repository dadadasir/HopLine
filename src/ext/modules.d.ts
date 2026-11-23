declare module '@hopline/pro-main' {
  const extensions: import('./api').MainExtension[]
  export default extensions
}

declare module '@hopline/pro-renderer' {
  const extensions: import('../renderer/src/ext/registry').RendererExtension[]
  export default extensions
}

declare module '*?asset' { const path: string; export default path }
