/// <reference types="vite/client" />

import type { HoplineApi } from '@shared/api'

declare global {
  var __HOPLINE_EDITION__: 'community' | 'pro'
  interface Window {
    hopline: HoplineApi
  }
}

export {}
