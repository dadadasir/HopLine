import type { Runbook } from '../../../core/runbook/types'
import { getState, patch } from './store'

export interface RunbookState { runbookTarget: { book: Runbook; hostId: string } | null; opLogHost: string | null }
export function openRunbook(book: Runbook, hostId = ''): void { patch({ runbookTarget: { book, hostId }, paletteOpen: false }) }
export function openOpLog(hostId: string): void { patch({ opLogHost: hostId, paletteOpen: false }) }

export interface RunbookState { initHost?: string | null }
export function openInit(hostId: string): void { patch({ initHost: hostId, paletteOpen: false }) }

export interface RunbookState { cleanupHost?: string | null; cleanupHidden?: boolean }
export function openCleanup(hostId: string): void { patch({ cleanupHost: getState().cleanupHost ?? hostId, cleanupHidden: false, paletteOpen: false }) }
