import { lazy, Suspense, useState, type ComponentType } from 'react'
import { useAppSelector } from '../state/store'

type TerminalModule = { TerminalStack: ComponentType }
const loadTerminal = (): Promise<TerminalModule> => import('./TerminalPane')

/** Mounted only while sessions exist; navigation keeps this instance alive. */
export function DeferredTerminalStack({ load = loadTerminal }: { load?: () => Promise<TerminalModule> }) {
  // A ViewBoundary retry remounts us. Give that attempt a fresh lazy instance,
  // because React otherwise keeps a rejected import forever on the lazy type.
  const [Stack] = useState(() => lazy(() => load().then(({ TerminalStack }) => ({ default: TerminalStack }))))
  const english = useAppSelector(state => state.settings?.language === 'en')
  return <Suspense fallback={<div role="status" className="grid min-h-40 flex-1 place-items-center text-[13px] text-muted">
    {english ? 'Loading terminal…' : '正在加载终端…'}
  </div>}><Stack /></Suspense>
}
