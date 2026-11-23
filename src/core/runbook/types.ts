export interface RunbookStep {
  id: string
  title: string
  description?: string
  sudo: boolean
  /** Checks must be read-only; review scripts before registering a runbook. */
  check: string
  apply: string
  verify: string
  rollback?: string
  gate?: 'login-as-new-user'
  /** Secret parameter delivered as one stdin line to apply only. */
  stdin?: string
  dangerous?: boolean
}
export interface Runbook {
  id: string
  title: string
  steps: RunbookStep[]
  params?: { name: string; label: string; pattern: string; secret?: boolean }[]
}
export type Params = Record<string, string>
export type SudoMode = 'root' | 'nopass' | 'password' | 'missing'
export interface PlannedStep { id: string; status: 'already' | 'needed' | 'unknown'; reason: string; command: string }
export interface RunbookPlan { steps: PlannedStep[]; sudo: SudoMode }
export interface StepResult {
  stepId: string; title: string; status: 'executed' | 'already' | 'skipped' | 'unavailable' | 'failed'
  gate?: { name: 'login-as-new-user'; ok: boolean; reason?: string }
  reason: string; durationMs: number; output: string; rollback?: boolean
}
export type RunbookSummary = Record<StepResult['status'], number>
export interface ExecResult { code: number | null; stdout: string; stderr: string; timedOut?: boolean; signal?: string | null }
export type Exec = (script: string, options: { stdin?: string; env: Params }) => Promise<ExecResult>

export type GateResult = { ok: true } | { ok: false; reason: string }
export type Gates = Partial<Record<NonNullable<RunbookStep['gate']>, (params: Params) => Promise<GateResult>>>
