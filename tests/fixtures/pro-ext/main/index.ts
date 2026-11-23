import type { MainExtension } from '../../../../src/ext/api'

export default [{
  id: 'fixture',
  setup(ctx) {
    ctx.log.info('HOPLINE_PRO_FIXTURE_MARKER')
    ctx.handle('ping', () => 'pong')
  }
}] satisfies MainExtension[]
