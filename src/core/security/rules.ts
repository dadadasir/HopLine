import { REMINDER_WINDOW_DAYS, DAY_MS } from '../reminders'
import type { Section } from '../../shared/types'
import type { SecurityIgnores, SecurityResult, SecuritySnapshot } from './types'

export const EOL_DATA_DATE = '2026-10-27'
// Standard/community support only: debian.org/releases, ubuntu.com/about/release-cycle,
// centos.org/centos-linux, alpinelinux.org/releases. Unknown versions stay unknown.
const supportEnds: Record<string, string> = {
  'debian:11': '2026-08-31', 'debian:12': '2028-06-30', 'debian:13': '2030-06-30',
  'ubuntu:20.04': '2025-05-31', 'ubuntu:22.04': '2027-05-31', 'ubuntu:24.04': '2029-05-31',
  'centos:9': '2027-05-31', 'centos-stream:9': '2027-05-31',
  'alpine:3.18': '2025-05-09', 'alpine:3.19': '2025-11-01', 'alpine:3.20': '2026-04-01',
  'alpine:3.21': '2026-11-01', 'alpine:3.22': '2027-05-01', 'alpine:3.23': '2027-11-01', 'alpine:3.24': '2028-06-01'
}
const data = <T>(s: Section<T>): T | undefined => s.status === 'unavailable' ? undefined : s.data
const port = (value: unknown) => typeof value === 'string' && /^\d{1,5}$/.test(value) && +value > 0 && +value <= 65535 ? String(+value) : null
const usernames = (values: string[] = []) => values.filter((name) => /^[a-z_][a-z0-9_-]{0,31}\$?$/i.test(name))
const points = { high: 20, medium: 10, low: 3 }
export const securityScore = (results: SecurityResult[]) => Math.max(0, 100 - results.reduce((sum, r) => sum + (r.status === 'fail' && r.id !== 'ssh-default-port' ? points[r.severity] : 0), 0))

export function evaluate(s: SecuritySnapshot, ignores: SecurityIgnores = {}, now = Date.now()): SecurityResult[] {
  const results: SecurityResult[] = [], ssh = data(s.sshd), listeners = data(s.listeners), updates = data(s.updates), accounts = data(s.accounts)
  const add = (id: string, severity: SecurityResult['severity'], section: Section<unknown>, bad: boolean | undefined, evidence: unknown, commands = '') => {
    const status = bad === undefined || section.status === 'unavailable' ? 'unknown' : bad ? 'fail' : section.status === 'partial' ? 'unknown' : 'pass'
    results.push({ id, severity, title: `security.${id}`, status: Object.hasOwn(ignores, id) ? 'ignored' : status,
      evidence: JSON.stringify({ key: `security.evidence.${id}`, params: { raw: (typeof evidence === 'string' ? evidence : JSON.stringify(evidence) ?? '').slice(0, 8000), state: status, reason: section.status === 'unavailable' ? section.reason : '' }, note: section.note?.slice(0, 1000) }),
      ...(bad ? { fix: { explain: `security.fix.${id}`, commands } } : {}) })
  }
  const sshSetting = (key: string) => ssh?.[key] === 'yes' ? true : ssh?.[key] && /^(no|prohibit-password|without-password|forced-commands-only)$/.test(ssh[key]) ? false : undefined
  for (const [id, key, value] of [['ssh-root-login', 'permitrootlogin', 'prohibit-password'], ['ssh-password-auth', 'passwordauthentication', 'no'], ['ssh-empty-passwords', 'permitemptypasswords', 'no']]) {
    add(id, 'high', s.sshd, s.sshd.status === 'partial' ? undefined : sshSetting(key), ssh?.[key],
      `# security.command.ssh-first\n# security.command.ssh-setting ${key} ${value}\nsudoedit /etc/ssh/sshd_config\n# security.command.ssh-validate\nsudo sshd -t && (sudo systemctl reload sshd || sudo systemctl reload ssh)`)
  }
  const sshPort = s.sshd.status === 'complete' ? port(ssh?.port) : null
  add('firewall-off', 'high', s.firewall, data(s.firewall) ? !data(s.firewall)!.active : undefined, data(s.firewall), sshPort
    ? `# security.command.firewall-first\n# security.command.ufw\nsudo ufw allow ${sshPort}/tcp && sudo ufw enable\n# security.command.firewalld\nsudo firewall-offline-cmd --add-port=${sshPort}/tcp && sudo systemctl enable --now firewalld\n# security.command.firewall-verify\nsudo firewall-cmd --list-all`
    : '# security.command.port-unknown')
  const exposed = listeners?.filter((l) => ['0.0.0.0', '::', '*'].includes(l.address) && [3306, 5432, 6379, 27017, 9200, 11211, 5984].includes(l.port))
  add('db-exposed', 'high', s.listeners, exposed && exposed.length > 0, exposed, (exposed ?? []).map((l) => port(String(l.port))).filter(Boolean).map((p) => `# security.command.database\nsudo ufw deny ${p}/tcp`).join('\n'))
  add('docker-api-exposed', 'high', s.listeners, listeners?.some((l) => l.port === 2375), listeners?.filter((l) => l.port === 2375), '# security.command.docker\nsudoedit /etc/docker/daemon.json\n# security.command.docker-systemd\nsudo systemctl cat docker')
  const miners = data(s.processes)?.filter((line) => /xmrig|kdevtmpfsi|kinsing|minerd|cpuminer|--donate-level/i.test(line))
  add('miner-process', 'high', s.processes, miners && miners.length > 0, miners, '# security.command.miner\nps -A -o pid,ppid,user,pcpu,comm,args\n# security.command.network\nsudo ss -tpn\n# security.command.cron\nsudo crontab -l')
  const extra = accounts?.uid0.filter((name) => name !== 'root')
  add('uid0-accounts', 'high', s.accounts, accounts?.uid0.length ? !!extra?.length : undefined, extra, usernames(extra).map((name) => `# security.command.uid\nid '${name}'`).join('\n'))
  add('empty-password-accounts', 'high', s.accounts, accounts?.empty ? accounts.empty.length > 0 : undefined, accounts?.empty ?? null, usernames(accounts?.empty ?? []).map((name) => `# security.command.lock\nsudo passwd -l '${name}'`).join('\n'))
  const os = data(s.os), version = os?.version?.match(/^\d+(?:\.\d+)*$/)?.[0], major = Number(version?.split('.')[0])
  const release = /^(debian|centos|centos-stream)$/.test(os?.id ?? '') ? String(major) : version?.split('.').slice(0, 2).join('.')
  const end = supportEnds[`${os?.id}:${release}`]
  const old = os?.id === 'debian' && major <= 10 || os?.id === 'ubuntu' && Number(release) <= 18.04 || /^(centos|centos-stream)$/.test(os?.id ?? '') && major <= 8 || os?.id === 'alpine' && (major < 3 || major === 3 && Number(release?.split('.')[1]) <= 17)
  const eol = version && old ? true : end ? now > Date.parse(`${end}T23:59:59Z`) : undefined
  add('os-eol', 'medium', s.os, eol, { os: os?.id, version: os?.version, date: EOL_DATA_DATE })
  add('auto-updates-off', 'medium', s.updates, updates?.auto == null ? undefined : !updates.auto, updates?.auto, '# security.command.auto-apt\nsudo apt-get install unattended-upgrades && sudo dpkg-reconfigure unattended-upgrades\n# security.command.auto-dnf\nsudo dnf install dnf-automatic\nsudoedit /etc/dnf/automatic.conf\nsudo systemctl enable --now dnf-automatic.timer')
  add('security-updates-pending', 'medium', s.updates, updates?.pending == null ? undefined : updates.pending > 0, updates?.pending, '# security.command.upgrade-apt\nsudo apt-get update && sudo apt-get upgrade\n# security.command.upgrade-dnf\nsudo dnf upgrade --security')
  add('reboot-required', 'low', s.updates, updates?.reboot ?? undefined, updates?.reboot, '# security.command.reboot\nsudo reboot')
  const password = s.sshd.status === 'complete' ? sshSetting('passwordauthentication') : undefined
  add('no-bruteforce-guard', 'low', password === false ? s.sshd : s.bruteforce, password === false ? false : password === undefined || !data(s.bruteforce) ? undefined : !data(s.bruteforce)!.active, { password, guard: data(s.bruteforce) }, '# security.command.guard\nsudo apt-get install fail2ban\nsudoedit /etc/fail2ban/jail.local\nsudo systemctl enable --now fail2ban')
  const certs = data(s.tls)?.filter((c) => c.unreferenced === false), expiring = certs?.filter((c) => c.expiresAt !== null && c.expiresAt <= now + REMINDER_WINDOW_DAYS * DAY_MS)
  add('tls-expiring', 'medium', s.tls, certs?.some((c) => c.expiresAt === null) ? expiring?.length ? true : undefined : expiring && expiring.length > 0, expiring, '# security.command.tls\nsudo certbot renew --dry-run\n# security.command.tls-timer\nsudo nginx -T\nsystemctl status certbot.timer')
  add('ssh-default-port', 'low', s.sshd, sshPort ? sshPort === '22' : undefined, ssh?.port)
  return results.sort((a, b) => points[b.severity] - points[a.severity])
}
