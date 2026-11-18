import type { Settings, SettingsInput } from '../../shared/types';

export type SettingsMutation = SettingsInput & { expectedEnabledRevision?: number };
const GENERAL_SETTINGS = ['agentName', 'ownerName', 'mission', 'enabled', 'maxOutputContinuations', 'maxStepsPerRun', 'timezone'] as const;

/** Untouched snapshot fields cannot overwrite changes accepted while this form was open. */
export function settingsPatch(initial: Settings, form: SettingsInput): SettingsMutation {
  const values = Object.fromEntries(GENERAL_SETTINGS.flatMap(key =>
    form[key] !== undefined && form[key] !== initial[key] ? [[key, form[key]]] : [])) as SettingsInput;
  return { ...values, ...(values.enabled === undefined ? {} : { expectedEnabledRevision: initial.enabledRevision }) };
}
