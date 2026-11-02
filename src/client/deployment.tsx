/**
 * Deployment settings: setup problems, the state directory and the machine limits. The limits live in `config.json` in the state
 * directory; saving them here writes the file, and they apply at their next use, as upstream's Plugin Manager page did.
 */
import { useState } from 'react'
import { LIMITS } from '../limits.ts'
import type { SetupView } from './api.ts'
import { Button, InfoTip, Input } from './controls.tsx'
import { useAction, usePanel, usePanelData } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { CheckSetupButton, Hint, Section, SetupMessage } from './widgets.tsx'

type MachineLimit = 'promptMaxChars' | 'admissionContextMaxPages' | 'admissionContextTimeoutMs'
const KEYS: readonly MachineLimit[] = ['promptMaxChars', 'admissionContextMaxPages', 'admissionContextTimeoutMs']

export function DeploymentPage({ setup }: { setup: SetupView }) {
  const { t, call, notify } = usePanel()
  const { reload } = usePanelData()
  const saved = Object.fromEntries(KEYS.map(key => [key, String(setup.machine[key])])) as Record<MachineLimit, string>
  const [draft, setDraft] = useState<Record<MachineLimit, string> | undefined>()
  const value = draft ?? saved
  const changed = KEYS.some(key => value[key] !== saved[key])
  const save = useAction(async () => {
    await call('PUT deployment', { body: Object.fromEntries(KEYS.map(key => [key, Number(value[key])])) as Record<MachineLimit, number> })
    setDraft(undefined); notify(t('saved'))
  }, { reload })
  const limit = (key: MachineLimit, label: string) => <Field label={label}>
    <Input type="number" min={LIMITS[key].min} max={LIMITS[key].max} step={1} required value={value[key]} disabled={save.busy}
      onChange={event => setDraft({ ...value, [key]: event.target.value })} />
  </Field>
  return <div className="dt-form">
    <Hint>{t('deploymentIntro')}</Hint>
    {setup.problem && <div className="dt-row-buttons">
      <p className="dt-error" role="status"><SetupMessage problem={setup.problem} lead /></p><CheckSetupButton />
    </div>}
    <Section title={t('deploymentMachine')}>
      <Hint>{t('deploymentReadOnly')}</Hint>
      <div className="dt-field">
        <span className="dt-field-head">{t('deploymentStateDir')}<InfoTip text={t('deploymentStateDirHint')} /></span>
        <span className="dt-mono">{setup.machine.stateDir}</span>
      </div>
    </Section>
    <form className="dt-form" onSubmit={event => { event.preventDefault(); void save.run() }}>
      <Section title={t('deploymentLimits')} hint={t('deploymentLimitsHint')}>
        {limit('promptMaxChars', t('deploymentPromptMaxChars'))}
        {limit('admissionContextMaxPages', t('deploymentContextPages'))}
        {limit('admissionContextTimeoutMs', t('deploymentContextTimeout'))}
        <div className="dt-row-buttons">
          <Button type="submit" variant="primary" size="sm" disabled={!changed || save.busy}>{t('save')}</Button>
          {changed && <Button type="button" variant="ghost" size="sm" disabled={save.busy} onClick={() => { setDraft(undefined) }}>{t('discard')}</Button>}
        </div>
      </Section>
    </form>
  </div>
}
