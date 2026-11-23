import { afterEach, expect, it, vi } from 'vitest'
import { finishOnboarding, onboardingStep, readOnboardingDone } from '../src/renderer/src/logic/onboarding'

afterEach(() => vi.unstubAllGlobals())

it('advances through adding, connecting and checking, and hides when done', () => {
  expect(onboardingStep(false, false, false)).toBe(1)
  expect(onboardingStep(false, true, false)).toBe(2)
  expect(onboardingStep(false, true, true)).toBe(3)
  expect(onboardingStep(true, false, false)).toBeNull()
  expect(onboardingStep(true, true, true)).toBeNull()
  expect(onboardingStep(false, false, true)).toBe(1)
})

it('persists completion under the layout-independent onboarding key', () => {
  const values = new Map<string, string>()
  vi.stubGlobal('localStorage', { getItem: (key: string) => values.get(key) ?? null, setItem: (key: string, value: string) => values.set(key, value) })
  expect(readOnboardingDone()).toBe(false)
  finishOnboarding()
  expect(values).toEqual(new Map([['hopline.onboarding.v1', 'true']]))
  expect(readOnboardingDone()).toBe(true)
})

it('hides onboarding when storage cannot be read and tolerates failed writes', () => {
  vi.stubGlobal('localStorage', { getItem: () => { throw new Error('denied') }, setItem: () => { throw new Error('quota') } })
  expect(onboardingStep(readOnboardingDone(), false, false)).toBeNull()
  expect(finishOnboarding).not.toThrow()
})

it('also handles a throwing localStorage property getter', () => {
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'localStorage')
  Object.defineProperty(globalThis, 'localStorage', { configurable: true, get: () => { throw new Error('denied') } })
  try {
    expect(readOnboardingDone()).toBe(true)
    expect(finishOnboarding).not.toThrow()
  } finally {
    if (previous) Object.defineProperty(globalThis, 'localStorage', previous)
    else Reflect.deleteProperty(globalThis, 'localStorage')
  }
})
