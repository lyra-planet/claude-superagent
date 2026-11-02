/**
 * Deployment settings: setup problems, the state directory and the machine limits. The limits live in `config.json` in the state
 * directory, which the management API does not write, so the page shows them read-only.
 */
import { LIMITS } from '../limits.ts'
import type { SetupView } from './api.ts'
import { InfoTip, Input } from './controls.tsx'
import { usePanel } from './provider.tsx'
import { Field } from './settings-kit.tsx'
import { CheckSetupButton, Hint, Section, SetupMessage } from './widgets.tsx'

type MachineLimit = 'promptMaxChars' | 'admissionContextMaxPages' | 'admissionContextTimeoutMs'

export function DeploymentPage({ setup }: { setup: SetupView }) {
  const { t } = usePanel()
  const limit = (key: MachineLimit, label: string) => <Field label={label}>
    <Input type="number" min={LIMITS[key].min} max={LIMITS[key].max} step={1} value={String(setup.machine[key])} disabled readOnly />
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
    <Section title={t('deploymentLimits')} hint={t('deploymentLimitsHint')}>
      {limit('promptMaxChars', t('deploymentPromptMaxChars'))}
      {limit('admissionContextMaxPages', t('deploymentContextPages'))}
      {limit('admissionContextTimeoutMs', t('deploymentContextTimeout'))}
    </Section>
  </div>
}
