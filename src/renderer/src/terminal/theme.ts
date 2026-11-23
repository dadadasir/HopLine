import type { ITheme } from '@xterm/xterm'

export const TERMINAL_FONT = '"JetBrains Mono", "SF Mono", "Cascadia Mono", ui-monospace, Menlo, Consolas, "Microsoft YaHei UI", "WenQuanYi Micro Hei Mono", monospace'

export function terminalTheme(dark: boolean): ITheme {
  if (dark) {
    return {
      background: '#141413',
      foreground: '#dcdcd7',
      cursor: '#a9a8ff',
      cursorAccent: '#171638',
      selectionBackground: '#34345a',
      black: '#1c1c1a',
      red: '#f07178',
      green: '#7fd99a',
      yellow: '#e6c07b',
      blue: '#7dc4e4',
      magenta: '#d4a5e0',
      cyan: '#6ec8b4',
      white: '#d6d3d1',
      brightBlack: '#6f6a64',
      brightRed: '#ff8b8b',
      brightGreen: '#a6e8b8',
      brightYellow: '#f3d7a1',
      brightBlue: '#a9d8f0',
      brightMagenta: '#e6c4ee',
      brightCyan: '#9be0d0',
      brightWhite: '#fafaf9'
    }
  }
  return {
    background: '#fcfcfb',
    foreground: '#262624',
    cursor: '#4c46dc',
    cursorAccent: '#fcfcfb',
    selectionBackground: '#dcdcf7',
    black: '#1c1917',
    red: '#c2413a',
    green: '#0f6e56',
    yellow: '#a16207',
    blue: '#1d4e89',
    magenta: '#7e3f8f',
    cyan: '#0f766e',
    white: '#e7e5e4',
    brightBlack: '#78716c',
    brightRed: '#dc5a52',
    brightGreen: '#1a8f6e',
    brightYellow: '#ca8a04',
    brightBlue: '#2563eb',
    brightMagenta: '#a855b8',
    brightCyan: '#0d9488',
    brightWhite: '#fafaf9'
  }
}
