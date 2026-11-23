# Contributing to HopLine

HopLine is a VPS manager for developers. Review the [non-goals](#non-goals) before proposing changes. Share bug reports and feature ideas in issues; external code PRs are not accepted. Report vulnerabilities through the private channel in [SECURITY.md](SECURITY.md).

## 反馈与贡献 / Feedback and contributions

HopLine 目前只接受 issue（bug 报告、功能建议），暂不接受外部代码 PR；收到的外部代码 PR 会被礼貌关闭。欢迎在 issue 中描述问题、复现步骤、预期行为和想法，请勿粘贴大段代码，也不要包含密码、密钥或真实主机敏感信息。安全漏洞请使用 [私密报告渠道](SECURITY.md)。

HopLine currently accepts issues only: bug reports and feature suggestions. External code pull requests are not accepted and will be politely closed. Please describe the problem, reproduction steps, expected behavior and ideas in an issue; do not paste large blocks of code or include passwords, keys or sensitive host details. Report security vulnerabilities through the [private channel](SECURITY.md).

## Development setup

Use Node.js **26.12.1** from [.nvmrc](.nvmrc). Install Xcode Command Line Tools on macOS, or a C/C++ toolchain and Python 3 on Linux. Local tests require Python 3 on PATH. Electron needs a graphical session for interactive development and smoke testing. On Ubuntu, the CI configuration installs `libgtk-3-0`, `libnss3`, and `libasound2t64`. Use Xvfb for smoke tests without a graphical session. Linux desktop and packaging are unverified.

```sh
npm ci
npx --no-install install-electron
npm run dev
```

The install step rebuilds native dependencies for Electron. If a native-module ABI error occurs, run `npm run rebuild`. Create a community package with `npm run build:community`; packages appear in `release/`. macOS packages must be built on macOS and are ad-hoc signed without Developer ID signing or notarization.

## Local packaging

Use `npm run build:community` so the build checks the source modules that enter the package. Install dependencies into this checkout with `npm ci` before packaging. The default macOS target is Apple Silicon ZIP. Linux AppImage/deb and macOS Intel are unverified.

## Validation

Run checks appropriate to the change and report what you ran, what passed, and what you could not run in the local validation record.

| Command | Coverage and when to run |
| --- | --- |
| `npm run typecheck` | Main-process and renderer TypeScript checks; run for code changes. |
| `npm test` | Unit tests and local loopback SSH/SFTP integration tests; run for code changes. No Docker or real VPS is required; loopback networking must be allowed. |
| `npm run test:smoke` | Electron UI and IPC flows with a temporary profile and loopback SSH; run for UI, preload, IPC, terminal, and lifecycle changes. Requires the Electron binary and a desktop session, or Xvfb on Linux. |
| `node tests/app-lifecycle-smoke.mjs` | macOS window close and activation, PTY cleanup, saved data, and unlock state using a temporary profile. |
| `npm run perf:budget` / `npm run perf:runtime` | Package size and runtime budgets after building. Run each check separately to avoid contention. |
| `npm run perf:runtime -- --trace` | Optional startup stage diagnostics alongside the existing startup and memory measurements. |
| `node tests/packaged-startup-smoke.mjs` | macOS arm64 package startup, on-demand terminal and import empty/error states. Uses a temporary profile with simulated import results. |
| `npx --no-install vitest run -c vitest.distro.config.ts tests/distro/collect-snapshot.test.ts tests/distro/security-snapshot.test.ts` | Offline parser snapshots using fictional distribution outputs. |

For documentation-only changes, check factual claims, relative links, and template syntax. UI changes should include screenshots with fictional host information. Use test hosts for destructive workflows.

## Code and commits

- Match the surrounding TypeScript and React code. Keep changes focused, and avoid speculative abstractions.
- Keep pure logic independent of Electron where practical; add regression coverage for behavioral changes.
- Update both language strings when changing UI copy. Keep credentials and sensitive host details out of logs, fixtures, screenshots, and issues.
- Use Conventional Commits: `type(scope): description`, with an optional scope. English and Chinese descriptions are both welcome, for example `fix(sftp): preserve partial downloads on cancellation` or `docs: 更新安装说明`.
- Explain user-visible behavior, validation, and limitations in the local validation record. Disclose any added network behavior; do not introduce telemetry by default.

## Design principles

- **Quiet:** show status and reminders when they need attention; avoid repeated prompts.
- **Transparent:** preview built-in server-maintenance commands and report each step's result, with local operation records.
- **Honest:** show unavailable data and its reason instead of fabricating values or success.
- **Conservative:** skip or refuse actions whose safety cannot be established, and prefer reversible changes.

Remote output must not trigger arbitrary local actions. Keep any permitted actions narrowly scoped or subject to explicit user confirmation.

## Non-goals

These features are outside the current product scope:

- Browser access to the local terminal through a relay: it exposes a shell and adds security and operating responsibilities.
- A local shell enhancement suite: zsh plugins, completion, Smart Tab, or editor-style input editing.
- A custom GPU renderer or Lua configuration system.
- A public plugin system. Extension interfaces are reserved for the application.
- Cleaning caches or applications on the local Mac. HopLine's cleanup scope is remote servers.
