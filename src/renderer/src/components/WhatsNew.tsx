import { useEffect, useState } from 'react'
import { api, getState, toast, useAppSelector } from '../state'
import { translate } from '../i18n'
import type { VersionChange } from '@shared/api'
import { releaseNotesBetween } from '../whats-new'
import { Modal, useT } from './ui'

export function WhatsNew() {
  const [version, setVersion] = useState<VersionChange | null>(null)
  const ready = useAppSelector((s) => s.ready && !s.bootError)
  const locale = useAppSelector((s) => s.settings?.language ?? 'zh')
  const t = useT()
  useEffect(() => {
    if (!ready) return
    let active = true
    void api().app.versionChange().then((change) => {
      if (!active || !change) return
      const language = getState().settings?.language ?? 'zh'
      toast(translate(language, 'whatsNew.updated', { version: change.current }), 'ok', {
        duration: 0,
        action: { label: translate(language, 'whatsNew.view'), run: async () => { setVersion(change) } }
      })
    }).catch(() => {})
    return () => { active = false }
  }, [ready])
  const entries = version ? releaseNotesBetween(version.previous, version.current, locale) : []
  return <Modal open={!!version} title={`${t('whatsNew.title')} · ${version?.current ?? ''}`} onClose={() => setVersion(null)} width="w-[480px]">
    {entries.length ? <div className="space-y-5">{entries.map(({ version, notes }) => <section key={version}><h2 className="mb-3 font-medium">{version}</h2><ul className="list-disc space-y-3 pl-5 text-[13px]">{notes.map((entry) => <li key={entry}>{entry}</li>)}</ul></section>)}</div> : <p className="text-[13px] text-muted">{t('whatsNew.unlisted')}</p>}
  </Modal>
}
