import { getState } from '../state/store'
import { notifyTask, taskIsBackground, updateTask } from '../state/tabs'
import { agentFromTitle } from '../logic/agents'
import { memo, useEffect, useRef } from 'react'
import { Terminal } from '@xterm/xterm'
import { FitAddon } from '@xterm/addon-fit'
import { SearchAddon } from '@xterm/addon-search'
import { WebLinksAddon } from '@xterm/addon-web-links'
import { WebglAddon } from '@xterm/addon-webgl'
import '@xterm/xterm/css/xterm.css'
import { api, errorText, patch, toast, useAppSelector } from '../state'
import { translate } from '../i18n'
import { attachTerminal, detachTerminal, searchOf, terminalOf } from '../terminal/registry'
import { TERMINAL_FONT, terminalTheme } from '../terminal/theme'
import { installOscPolicy } from '../terminal/osc'
import { themeOf } from '../state'
import { useT } from './ui'
import { ShellMarks, shellMarks, notifyShellMarks } from '../terminal/marks'

export const TerminalStack = memo(function TerminalStack() {
  const tabs = useAppSelector((state) => state.tabs)
  const activeId = useAppSelector((state) => state.activeId)
  const visible = useAppSelector(state => state.route.page === 'sessions')
  return (
    <div className="relative min-h-0 flex-1">
      {tabs.map((tab) => (
        <TerminalView key={tab.id} id={tab.id} kind={tab.kind} active={visible && tab.id === activeId} />
      ))}
      <FindBar />
    </div>
  )
})

const TerminalView = memo(function TerminalView({ id, kind, active }: { id: string; kind: 'ssh' | 'local'; active: boolean }) {
  const ref = useRef<HTMLDivElement>(null)
  const fontSize = useAppSelector((state) => state.settings?.fontSize ?? 13)
  const dark = useAppSelector(themeOf) === 'dark'

  useEffect(() => {
    const parent = ref.current
    if (!parent) return
    const term = new Terminal({
      fontFamily: TERMINAL_FONT,
      fontSize,
      lineHeight: 1.35,
      cursorBlink: false,
      cursorStyle: 'bar',
      cursorWidth: 2,
      scrollback: 8000,
      minimumContrastRatio: 3,
      theme: terminalTheme(dark),
      allowProposedApi: true
    })
    let progressTimer: ReturnType<typeof setTimeout> | undefined
    const marks = new ShellMarks(term, () => {
      const state = getState(), tab = state.tabs.find((tab) => tab.id === id)
      return tab?.shellHostname ?? state.hosts.find((host) => host.id === tab?.hostId)?.host ?? ''
    })
    shellMarks.set(id, marks)
    marks.subscribe(notifyShellMarks); notifyShellMarks()
    const disposeOscPolicy = installOscPolicy(term, {
      openExternal: (uri) => api().shell.openExternal(uri), sessionId: id,
      title: () => getState().tabs.find((tab) => tab.id === id)?.title ?? 'HopLine',
      isBackground: () => taskIsBackground(id), onNotify: notifyTask,
      onTitle: (title) => updateTask(id, { agent: agentFromTitle(title) }),
      onProgress: (progress) => {
        clearTimeout(progressTimer); updateTask(id, { progress })
        if (progress) progressTimer = setTimeout(() => updateTask(id, { progress: null }), 30_000)
      }
    })
    const fit = new FitAddon()
    const search = new SearchAddon()
    term.loadAddon(fit)
    term.loadAddon(search)
    term.loadAddon(
      new WebLinksAddon((event, uri) => {
        event.preventDefault()
        if (uri.startsWith('https://') || uri.startsWith('http://')) void api().shell.openExternal(uri)
      })
    )
    term.open(parent)
    if (canUseWebgl()) {
      try {
        const webgl = new WebglAddon()
        webgl.onContextLoss(() => webgl.dispose())
        term.loadAddon(webgl)
      } catch {
        // The canvas renderer is already active.
      }
    }
    attachTerminal(id, term, search)
    const resize = () => {
      if (parent.clientWidth < 2 || parent.clientHeight < 2) return
      fit.fit()
      if (kind === 'ssh') api().ssh.resize(id, term.cols, term.rows)
      else api().pty.resize(id, term.cols, term.rows)
    }
    const observer = new ResizeObserver(() => resize())
    observer.observe(parent)
    requestAnimationFrame(resize)
    const data = term.onData((chunk) => {
      if (kind === 'ssh') api().ssh.write(id, chunk)
      else api().pty.write(id, chunk)
    })
    const windows = api().platform === 'win32'
    const onPaste = (event: ClipboardEvent) => {
      event.preventDefault()
      event.stopPropagation()
      pasteIntoTerminal(id, term, event.clipboardData?.getData('text/plain') ?? '')
    }
    if (windows) parent.addEventListener('paste', onPaste, true)
    term.attachCustomKeyEventHandler((event) => {
      if (event.metaKey && ['ArrowUp', 'ArrowDown'].includes(event.key) && marks.active) return false
      const mod = event.metaKey || (event.ctrlKey && event.shiftKey)
      if (event.type === 'keydown' && ((mod && event.key.toLowerCase() === 'c') || (event.ctrlKey && !event.shiftKey && event.key === 'Insert')) && term.hasSelection()) {
        void api().clipboard.write(term.getSelection())
        return false
      }
      if (event.type === 'keydown' && (((event.metaKey || (event.ctrlKey && event.shiftKey)) && event.key.toLowerCase() === 'v') || (event.shiftKey && !event.ctrlKey && event.key === 'Insert'))) {
        if (windows) {
          event.preventDefault()
          void pasteWindowsClipboard(id, term)
        } else void api().clipboard.read().then((text) => { if (text) term.paste(text) })
        return false
      }
      if (event.metaKey && event.key.toLowerCase() === 'k') return false
      return true
    })
    return () => {
      if (windows) parent.removeEventListener('paste', onPaste, true)
      observer.disconnect()
      data.dispose()
      clearTimeout(progressTimer)
      disposeOscPolicy()
      marks.dispose(); shellMarks.delete(id)
      notifyShellMarks()
      detachTerminal(id)
    }
    // Recreate only when the session id changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  useEffect(() => {
    const term = terminalOf(id)
    if (!term) return
    term.options.fontSize = fontSize
    term.options.theme = terminalTheme(dark)
    term.refresh(0, term.rows - 1)
  }, [id, fontSize, dark])

  useEffect(() => {
    if (!active) return
    const frame = requestAnimationFrame(() => {
      if (!document.querySelector('[role=dialog]')) terminalOf(id)?.focus()
    })
    return () => cancelAnimationFrame(frame)
  }, [id, active])

  return (
    <div
      ref={ref}
      className={`terminal-surface absolute inset-0 bg-term ${active ? '' : 'invisible'}`}
      onContextMenuCapture={(event) => {
        if (api().platform !== 'win32') return
        const term = terminalOf(id)
        if (!term) return
        event.preventDefault()
        event.stopPropagation()
        term.focus()
        if (term.hasSelection()) {
          void api().clipboard.write(term.getSelection())
          term.clearSelection()
        } else {
          void pasteWindowsClipboard(id, term)
        }
      }}
    />
  )
})

async function pasteWindowsClipboard(id: string, term: Terminal) {
  try {
    pasteIntoTerminal(id, term, await api().clipboard.read())
  } catch (error) {
    toast(errorText(error), 'err')
  }
}

function pasteIntoTerminal(id: string, term: Terminal, text: string) {
  const current = getState()
  const isActive = () => getState().route.page === 'sessions' && getState().activeId === id && terminalOf(id) === term
  if (!text || current.confirm || !isActive()) return
  if (/[\r\n]/.test(text)) {
    const locale = current.settings?.language ?? 'zh'
    patch({ confirm: {
      title: translate(locale, 'terminal.pasteTitle'),
      body: translate(locale, 'terminal.pasteBody'),
      confirm: translate(locale, 'terminal.pasteAction'),
      run: async () => { if (isActive()) term.paste(text) }
    } })
  } else {
    term.paste(text)
    term.focus()
  }
}

function canUseWebgl(): boolean {
  try {
    const canvas = document.createElement('canvas')
    const gl = canvas.getContext('webgl2')
    if (!gl) return false
    gl.getExtension('WEBGL_lose_context')?.loseContext()
    return true
  } catch {
    return false
  }
}

function FindBar() {
  const open = useAppSelector((state) => state.findOpen)
  const activeId = useAppSelector((state) => state.activeId)
  const t = useT()
  const input = useRef<HTMLInputElement>(null)
  useEffect(() => {
    if (open) input.current?.focus()
  }, [open])
  if (!open) return null
  const run = (back = false) => {
    const query = input.current?.value ?? ''
    const search = searchOf(activeId)
    if (!search || !query) return
    const options = { caseSensitive: Boolean((document.getElementById('find-case') as HTMLInputElement | null)?.checked) }
    if (back) search.findPrevious(query, options)
    else search.findNext(query, options)
  }
  return (
    <form
      className="pop absolute top-3 right-3 z-10 flex items-center gap-1 rounded-xl border border-line bg-panel px-2 py-1 shadow-lg"
      onSubmit={(event) => {
        event.preventDefault()
        const shift = 'shiftKey' in event.nativeEvent && Boolean((event.nativeEvent as { shiftKey?: boolean }).shiftKey)
        run(shift)
      }}
    >
      <input id="find-query" ref={input} placeholder={t('term.search')} className="h-7 w-44 border-0 bg-transparent px-1 shadow-none" />
      <label className="flex items-center gap-1 px-1 text-[11px] text-muted">
        <input id="find-case" type="checkbox" />
        {t('term.case')}
      </label>
      <button type="button" className="rounded-md px-2 py-1 text-[12px] text-muted hover:bg-black/5" onClick={() => run(true)}>{t('term.prev')}</button>
      <button type="submit" className="rounded-md px-2 py-1 text-[12px] text-muted hover:bg-black/5">{t('term.next')}</button>
      <button type="button" className="rounded-md px-2 py-1 text-[12px] text-muted" onClick={() => patch({ findOpen: false })}>×</button>
    </form>
  )
}
