import { expect, it, vi } from 'vitest'
vi.mock('@hopline/pro-renderer', () => ({ default: [{ id: 'test', settingsPages: [
  { id: 'page', label: { zh: '页面', en: 'Page' }, render: () => 'ready' }
] }] }))
it('publishes renderer extensions after the asynchronous import completes', async () => {
  const module = await import('../src/renderer/src/ext')
  await module.extensionsReady
  expect(module.rendererExtensions.settingsPages.map((page) => page.render())).toEqual(['ready'])
})
