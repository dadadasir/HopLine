import type { HoplineApi } from '../../../../src/shared/api'
import type { RendererExtension } from '../../../../src/ext/api'

export default [{
  id: 'fixture',
  paletteActions: [{
    id: 'fixture-ping',
    label: { zh: '测试扩展 Ping', en: 'Test extension Ping' },
    keywords: ['HOPLINE_PRO_FIXTURE_MARKER', 'ping'],
    async run() {
      const { hopline } = (globalThis as unknown as { window: { hopline: HoplineApi } }).window
      const result = await hopline.pro.invoke('ping')
      if (result !== 'pong') throw new Error('测试扩展响应异常 / Unexpected fixture response')
      console.info('HOPLINE_PRO_FIXTURE_MARKER', result)
    }
  }]
}] satisfies RendererExtension[]
