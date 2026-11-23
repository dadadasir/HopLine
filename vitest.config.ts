import { defineConfig } from 'vitest/config'

const SUBPROCESS_TESTS = [
  'tests/*-live.test.ts',
  'tests/agent-auth.test.ts',
  'tests/billing-timezone.test.ts',
  'tests/atomic-edit.test.ts',
  'tests/ci-scripts.test.ts',
  'tests/cleanup-df.test.ts',
  'tests/cleanup-diagnostics.test.ts',
  'tests/cleanup-docker-logs.test.ts',
  'tests/cleanup-files.test.ts',
  'tests/cleanup-portability.test.ts',
  'tests/cleanup-runbook.test.ts',
  'tests/collect-script.test.ts',
  'tests/connection-pool.test.ts',
  'tests/distro-skip.test.ts',
  'tests/export-public.test.ts',
  'tests/host-files.test.ts',
  'tests/init-runbook.test.ts',
  'tests/local-pty-lifecycle.test.ts',
  'tests/m1h-prompts.test.ts',
  'tests/master-password.test.ts',
  'tests/mini-sshd.test.ts',
  'tests/perf-runtime.test.ts',
  'tests/persistent-sessions.test.ts',
  'tests/release-preparation.test.ts',
  'tests/runbook-sample.test.ts',
  'tests/security-script.test.ts',
  'tests/sessions-transfer.test.ts',
  'tests/sftp-safety.test.ts',
  'tests/sftp-transfer.test.ts',
  'tests/shell-integration-runbook.test.ts',
  'tests/shell-integration-scripts.test.ts',
  'tests/shell-integration-sessions.test.ts'
]

const sharedTestConfig = {
  environment: 'node' as const,
  testTimeout: 30_000,
  hookTimeout: 30_000
}

export default defineConfig({
  test: {
    ...sharedTestConfig,
    projects: [
      {
        extends: true,
        test: {
          ...sharedTestConfig,
          name: 'unit',
          pool: 'threads',
          sequence: { groupOrder: 0 },
          include: ['tests/**/*.test.ts'],
          exclude: ['tests/distro/**', ...SUBPROCESS_TESTS]
        }
      },
      {
        extends: true,
        test: {
          ...sharedTestConfig,
          name: 'subprocess',
          pool: 'forks',
          // Loopback SSH, PTY and POSIX shell fixtures spawn child processes that contend under full worker fan-out.
          maxWorkers: 2,
          sequence: { groupOrder: 1 },
          include: SUBPROCESS_TESTS,
          exclude: ['tests/distro/**']
        }
      }
    ]
  }
})
