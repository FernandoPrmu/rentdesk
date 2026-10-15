import {
  describeSetting,
  FIELD,
  formatSettingInput,
  GROUP_LABEL,
  SETTING_FIELDS,
  SETTING_GROUPS,
  type SettingGroup,
  type SettingKey,
  type SettingsValues,
  type SettingValue,
} from "./rules.ts";

/** The settings editors' groups and fields, as plain data for the client form. Pure. */

export interface SettingFormField {
  key: string;
  label: string;
  help?: string;
  kind: "int" | "list" | "bool" | "money" | "weekday";
  unit?: string;
  value: string;
  platform?: string;
  inherited?: boolean;
}

export function platformForm(values: SettingsValues, groups: readonly SettingGroup[] = SETTING_GROUPS) {
  return groups.map((g) => ({
    title: GROUP_LABEL[g],
    fields: SETTING_FIELDS.filter((f) => f.group === g).map(
      (f): SettingFormField => ({ key: f.key, label: f.label, help: f.help, kind: f.kind, unit: f.unit, value: formatSettingInput(f, values[f.key]) }),
    ),
  }));
}

/** Owner overrides: each field shows the owner's value or, when following it, the platform default. */
export function ownerForm(platform: SettingsValues, overrides: Partial<Record<SettingKey, SettingValue | null>>, groups: readonly SettingGroup[]) {
  return groups.map((g) => ({
    title: GROUP_LABEL[g],
    fields: SETTING_FIELDS.filter((f) => f.group === g && f.owner).map((f): SettingFormField => {
      const own = overrides[f.key];
      const inherited = own === null || own === undefined;
      return {
        key: f.key,
        label: f.label,
        help: f.help,
        kind: f.kind,
        unit: f.unit,
        value: formatSettingInput(f, inherited ? platform[f.key] : own),
        platform: describeSetting(f, platform[f.key]),
        inherited,
      };
    }),
  }));
}

/** Owner "Reminders and deadlines" (the late fee has its own Billing page). */
export const OWNER_REMINDER_GROUPS: readonly SettingGroup[] = ["meter", "review", "payment", "slip", "service", "agreement"];

export const ownerKeysIn = (groups: readonly SettingGroup[]): SettingKey[] => SETTING_FIELDS.filter((f) => f.owner && groups.includes(f.group)).map((f) => f.key);
export const platformKeysIn = (groups: readonly SettingGroup[] = SETTING_GROUPS): SettingKey[] => SETTING_FIELDS.filter((f) => groups.includes(f.group)).map((f) => f.key);

export const settingLabel = (key: string) => (key in FIELD ? FIELD[key as SettingKey].label : key);
