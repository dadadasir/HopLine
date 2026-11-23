import { Component, type ReactNode } from 'react'
import { patch } from '../state'

/** A failed view must not unmount the navigation or live terminals. */
export class ViewBoundary extends Component<{ children: ReactNode; resetKey?: string; root?: boolean }, { failed: boolean; generation: number }> {
  state = { failed: false, generation: 0 }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) { console.error('HopLine view failed', error) }
  componentDidUpdate(previous: Readonly<{ resetKey?: string }>) {
    if (this.state.failed && previous.resetKey !== this.props.resetKey) this.setState({ failed: false })
  }
  render() {
    if (!this.state.failed) return <div key={this.state.generation} className="contents">{this.props.children}</div>
    return <section role="alert" className="flex min-h-40 flex-1 flex-col items-center justify-center gap-4 p-8 text-center text-[13px]">
      <h2 className="text-lg font-medium">此视图暂时无法显示</h2>
      <p className="text-muted">请重试，或导出诊断以排查问题。</p>
      <div className="flex gap-3"><button className="rounded-md bg-accent px-3 py-2 text-accent-ink" onClick={() => this.setState({ failed: false, generation: this.state.generation + 1 })}>重新加载此视图</button>
      <button className="rounded-md border border-line px-3 py-2" onClick={() => this.props.root ? window.location.reload() : patch({ diagnosticsOpen: true })}>{this.props.root ? '重新加载应用' : '导出诊断'}</button></div>
    </section>
  }
}
