import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseCollect } from '../src/core/collect/parse'
import { DISTROS } from './distro/harness'
import type { Section } from '../src/shared/types'

const now = 1_798_000_000_000
const fixture = (name: string) => fs.readFileSync(path.join(import.meta.dirname, 'fixtures/collect', name), 'utf8')
const section = (name: string, text: string) => `===HOPLINE:${name}===\n${text}\n\n#HOPLINE-END\n`
function data<T>(section: Section<T>): T {
  expect(section.status).not.toBe('unavailable')
  if (section.status === 'unavailable') throw new Error(section.note)
  return section.data
}

describe('collect parser', () => {
  const alpine = parseCollect(fixture('alpine.txt'), now)
  it('parses BusyBox output, estimates old-kernel memory and retains byte units', () => {
    expect(alpine.collectedAt).toBe(now)
    expect(data(alpine.os)).toEqual({ id: 'alpine', version: '3.20.10', name: 'Alpine Linux v3.20', kernel: 'Linux 6.1.0-demo', architecture: 'aarch64' })
    expect(data(alpine.uptime)).toEqual({ seconds: 12345.67 })
    expect(data(alpine.cpu)).toEqual({ cores: 4, usagePercent: 50 })
    expect(alpine.memory).toMatchObject({ status: 'partial', data: { totalBytes: 8388608, availableBytes: 4194304, swapTotalBytes: 4194304, swapUsedBytes: 1048576 } })
    expect(data(alpine.load)).toEqual({ one: 0.09, five: 0.2, fifteen: 0.18 })
    expect(data(alpine.disk)).toEqual([
      { filesystem: '/dev/vda1', mountpoint: '/etc/hosts', totalBytes: 1024000000, usedBytes: 102400000, availableBytes: 921600000, usagePercent: 10 },
      { filesystem: 'nfs.example.test:/volume', mountpoint: '/data files', totalBytes: 204800, usedBytes: 102400, availableBytes: 102400, usagePercent: 50 }
    ])
  })
  it('parses the netstat fallback and marks hidden processes partial', () => {
    expect(alpine.listeners).toMatchObject({ status: 'partial', data: [
      { protocol: 'tcp', address: '0.0.0.0', port: 22, process: null },
      { protocol: 'tcp6', address: '::', port: 443, process: 'nginx' }
    ] })
  })
  it('preserves unavailable reasons without fabricated data', () => {
    for (const [name, reason] of Object.entries({ docker: 'permission-denied', services: 'not-applicable', web: 'not-installed', certs: 'permission-denied' })) {
      expect(alpine[name as 'docker']).toMatchObject({ status: 'unavailable', reason })
      expect(alpine[name as 'docker']).not.toHaveProperty('data')
    }
  })
  it('parses ss, Docker JSON, systemd units, nginx/Caddy sites and certificate dates', () => {
    const snapshot = parseCollect(fixture('services.txt'), now)
    expect(snapshot.listeners.status).toBe('partial')
    expect(data(snapshot.listeners)[1]).toEqual({ protocol: 'tcp6', address: '::', port: 443, process: 'nginx' })
    expect(data(snapshot.docker)).toEqual([{ name: 'app', image: 'app:latest', status: 'Up 2 hours (healthy)', ports: '0.0.0.0:8080->80/tcp' }])
    expect(data(snapshot.services)[0]).toEqual({ name: 'nginx.service', description: 'A high performance web server' })
    expect(data(snapshot.web)).toEqual([
      { source: 'nginx', domain: 'example.com' }, { source: 'nginx', domain: 'www.example.com' },
      { source: 'caddy', domain: 'https://caddy.example.com' }, { source: 'caddy', domain: 'http://other.example.com:8080' },
      { source: 'caddy', domain: 'first.example.com' }, { source: 'caddy', domain: 'second.example.com' }
    ])
    expect(data(snapshot.certs)).toEqual([
      { domain: 'example.com', unreferenced: true, expiresAt: Date.UTC(2026, 10, 27, 10, 20, 30) },
      { domain: 'caddy.example.com', unreferenced: true, expiresAt: Date.UTC(2027, 0, 2, 3, 4, 5) }
    ])
  })
  it('treats missing and truncated sections as errors, retaining completed sections', () => {
    const snapshot = parseCollect(fixture('truncated.txt'), now)
    expect(snapshot.uptime).toEqual({ status: 'complete', data: { seconds: 42.5 } })
    expect(snapshot.os).toMatchObject({ status: 'unavailable', reason: 'error', note: 'Missing section' })
    expect(snapshot.docker).toMatchObject({ status: 'unavailable', reason: 'error', note: 'Truncated section' })
    const full = fixture('alpine.txt')
    for (let i = 0; i < full.length; i++) {
      const output = parseCollect(full.slice(0, i), now)
      expect(JSON.stringify(output)).not.toMatch(/NaN|Infinity/)
      expect(Object.keys(output)).toHaveLength(12)
    }
  })
  it('handles identical CPU samples, guest counters, reset counters and missing fields', () => {
    const sample = 'cpu 100 0 100 700 100 0 0 0 50 0'
    expect(data(parseCollect(section('cpu', `cores 4\n${sample}\n${sample}`), now).cpu).usagePercent).toBe(0)
    expect(data(parseCollect(section('cpu', `cores 4\n${sample}\ncpu 120 0 100 780 100 0 0 0 70 0`), now).cpu).usagePercent).toBe(20)
    expect(parseCollect(section('cpu', `cores 4\n${sample}`), now).cpu).toMatchObject({ status: 'partial', data: { cores: 4, usagePercent: null } })
    expect(data(parseCollect(section('cpu', `cores 4\n${sample}\ncpu 1 0 1 1`), now).cpu).usagePercent).toBeNull()
  })
  it('uses MemAvailable and null for missing swap fields; rejects invalid numerical data', () => {
    const memory = parseCollect(section('memory', 'MemTotal: 100 kB\nMemAvailable: 40 kB'), now).memory
    expect(memory).toMatchObject({ status: 'partial', data: { totalBytes: 102400, availableBytes: 40960, swapTotalBytes: null, swapUsedBytes: null } })
    expect(data(parseCollect(section('load', '1.5 broken 0.3'), now).load)).toEqual({ one: 1.5, five: null, fifteen: 0.3 })
    expect(parseCollect(section('uptime', 'NaN'), now).uptime.status).toBe('unavailable')
  })
  it('keeps readable data partial after a per-file error and caps diagnostic notes', () => {
    const snapshot = parseCollect(section('certs', `notAfter=Nov 27 10:20:30 2026 GMT\nsubject=CN = example.com\n#HOPLINE-UNAVAILABLE permission-denied ${'x'.repeat(250)}`), now)
    expect(snapshot.certs.status).toBe('partial')
    expect(snapshot.certs.note).toHaveLength(200)
    expect(data(snapshot.certs)).toHaveLength(1)
    expect(parseCollect(section('web', '#HOPLINE-SOURCE nginx\nserver_name $hostname;\ninclude extra.conf;'), now).web.status).toBe('partial')
  })
  it('distinguishes valid empty command output from missing or malformed output', () => {
    for (const name of ['listeners', 'docker', 'services', 'certs'] as const) expect(parseCollect(section(name, ''), now)[name]).toEqual({ status: 'complete', data: [] })
    expect(parseCollect(section('disk', ''), now).disk.status).toBe('unavailable')
    expect(parseCollect(section('docker', '{"Names":"broken"}'), now).docker.status).toBe('unavailable')
    expect(data(parseCollect(section('certs', 'notAfter=invalid\nsubject=O = Example'), now).certs)).toEqual([{ domain: null, expiresAt: null, unreferenced: true }])
  })
  it('handles a Caddy site without braces without treating directives as domains', () => {
    expect(parseCollect(section('web', '#HOPLINE-SOURCE caddy\nexample.com\nreverse_proxy localhost:3000\n'), now).web)
      .toEqual({ status: 'complete', data: [{ source: 'caddy', domain: 'example.com' }] })
  })
  it('rejects overflowing numeric values instead of returning zero, NaN or Infinity', () => {
    const huge = '9'.repeat(400)
    expect(data(parseCollect(section('memory', `MemTotal: ${huge} kB\nMemAvailable: 1 kB`), now).memory).totalBytes).toBeNull()
    const sample = `cpu ${'9'.repeat(308)} ${'9'.repeat(308)} 0 0`
    expect(data(parseCollect(section('cpu', `cores 1\ncpu 0 0 0 0\n${sample}`), now).cpu).usagePercent).toBeNull()
  })
})

const distroRoot = path.join(import.meta.dirname, 'distro/fixtures')
for (const distro of DISTROS) {
  it(`parses synthetic ${distro} basic output`, () => {
    const basic = fs.readFileSync(path.join(distroRoot, distro, 'basic.txt'), 'utf8')
    const parts = new Map([...basic.matchAll(/^===HOPLINE:([^=]+)===\n([\s\S]*?)(?=^===HOPLINE:|$(?![\s\S]))/gm)].map((match) => [match[1], match[2].trim()]))
    expect([...parts.keys()]).toEqual(['os-release', 'uname', 'id', 'df', 'memory', 'loadavg', 'listeners', 'ps'])
    expect([...basic.matchAll(/^===HOPLINE:/gm)]).toHaveLength(8)
    expect(parts.get('ps')).toMatch(/^\s*1\s+\S+\s+\S+/m)
    const uname = parts.get('uname')!.split(/\s+/)
    const machine = uname.find((part) => /^(aarch64|x86_64)$/.test(part))!
    const snapshot = parseCollect(section('os', `${parts.get('os-release')}\n${uname[0]} ${uname[2]} ${machine}`) + section('disk', parts.get('df')!) + section('load', parts.get('loadavg')!), now)
    expect(snapshot.os.status).toBe('complete')
    expect(data(snapshot.os).id).toBe(distro.split('-')[0])
    expect(data(snapshot.os).architecture).toBe(machine)
    expect(data(snapshot.os).kernel).toBe(`${uname[0]} ${uname[2]}`)
    expect(snapshot.disk.status).toBe('complete')
    expect(data(snapshot.disk).every((disk) => disk.filesystem.startsWith('/dev/'))).toBe(true)
    expect(data(snapshot.disk).length).toBeGreaterThan(0)
    expect(snapshot.load.status).toBe('complete')
  })
  const collect = path.join(distroRoot, distro, 'collect.txt')
  it(`validates synthetic ${distro} collection`, () => {
    const snapshot = parseCollect(fs.readFileSync(collect, 'utf8'), now)
    for (const [key, value] of Object.entries(snapshot)) if (key !== 'collectedAt') expect(['complete', 'partial', 'unavailable']).toContain(value.status)
    for (const key of ['os', 'uptime', 'memory', 'load', 'disk'] as const) expect(snapshot[key].status).not.toBe('unavailable')
  })
}
