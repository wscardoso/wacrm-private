import {
  Coins,
  FileText,
  KeyRound,
  LayoutGrid,
  Palette,
  PlugZap,
  Shield,
  Tags,
  User,
  UsersRound,
  type LucideIcon,
} from 'lucide-react';

/**
 * Settings information architecture for the redesigned page.
 *
 * The flat tab strip became a grouped left rail with a new Overview
 * landing. The URL query param stays `?tab=` (deep-linkable, and it
 * keeps the existing links in sidebar.tsx / header.tsx working) — we
 * just map the old values onto the new sections.
 */
export const SETTINGS_SECTIONS = [
  'overview',
  'profile',
  'security',
  'appearance',
  'whatsapp',
  'templates',
  'fields',
  'deals',
  'members',
  'api',
] as const;

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number];

export const DEFAULT_SECTION: SettingsSection = 'overview';

/** Rail grouping. `adminOnly` items are hidden for non-admins. */
export interface SectionMeta {
  id: SettingsSection;
  label: string;
  icon: LucideIcon;
  group: 'top' | 'account' | 'workspace';
}

// `label` holds an i18n key resolved against the `settings.tabs`
// namespace (see settings-rail.tsx / settings-overview.tsx), not
// display text — keeps this module locale-agnostic.
export const SECTION_META: Record<SettingsSection, SectionMeta> = {
  overview: { id: 'overview', label: 'overview', icon: LayoutGrid, group: 'top' },
  profile: { id: 'profile', label: 'profile', icon: User, group: 'account' },
  security: { id: 'security', label: 'security', icon: Shield, group: 'account' },
  appearance: { id: 'appearance', label: 'appearance', icon: Palette, group: 'account' },
  whatsapp: { id: 'whatsapp', label: 'whatsapp', icon: PlugZap, group: 'workspace' },
  templates: { id: 'templates', label: 'templates', icon: FileText, group: 'workspace' },
  fields: { id: 'fields', label: 'fields_tags', icon: Tags, group: 'workspace' },
  deals: { id: 'deals', label: 'deals', icon: Coins, group: 'workspace' },
  members: { id: 'members', label: 'members', icon: UsersRound, group: 'workspace' },
  api: { id: 'api', label: 'api_keys', icon: KeyRound, group: 'workspace' },
};

// `label` here is an i18n key against `settings.groups` (null for the
// ungrouped top section, which renders no header at all).
export const RAIL_GROUPS: { label: string | null; group: SectionMeta['group'] }[] = [
  { label: null, group: 'top' },
  { label: 'account', group: 'account' },
  { label: 'workspace', group: 'workspace' },
];

function isSection(value: string | null): value is SettingsSection {
  return !!value && (SETTINGS_SECTIONS as readonly string[]).includes(value);
}

/**
 * Resolve a raw `?tab=` value to a section. Legacy tabs from the old
 * flat layout collapse onto their new home (Tags + Custom fields → the
 * merged "Fields & tags" section). Anything unknown falls back to the
 * Overview landing.
 */
export function resolveSection(raw: string | null): SettingsSection {
  if (raw === 'tags' || raw === 'custom-fields') return 'fields';
  if (isSection(raw)) return raw;
  return DEFAULT_SECTION;
}
