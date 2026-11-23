import { Component, createElement, type ReactNode } from 'react'

export class ExtensionErrorBoundary extends Component<{ locale: 'zh' | 'en'; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(error: Error) { console.error('Extension render failed', error) }
  render() {
    return this.state.failed
      ? createElement('p', { role: 'alert' }, this.props.locale === 'zh' ? '扩展页面加载失败' : 'Extension page failed to load')
      : this.props.children
  }
}
