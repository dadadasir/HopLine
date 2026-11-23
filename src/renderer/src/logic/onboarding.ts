const onboardingKey = 'hopline.onboarding.v1'

export function readOnboardingDone(): boolean {
  try { return localStorage.getItem(onboardingKey) !== null } catch { return true }
}

export function finishOnboarding(): void {
  try { localStorage.setItem(onboardingKey, 'true') } catch { /* Storage is optional. */ }
}

export function onboardingStep(done: boolean, hasHost: boolean, connected: boolean): 1 | 2 | 3 | null {
  return done ? null : !hasHost ? 1 : connected ? 3 : 2
}

const progressKey = 'hopline.onboarding.progress'

export function readOnboardingProgress(): string | null {
  try { return localStorage.getItem(progressKey) } catch { return null }
}

export function saveOnboardingProgress(hostId = ''): void {
  try { localStorage.setItem(progressKey, hostId) } catch { /* Storage is optional. */ }
}
