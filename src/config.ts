import type { ConfigGroup, ConfigProperty } from 'cortico/core/types.ts';
import type { Language } from 'cortico/core/language.ts';
import { configLabels, strings } from './strings.ts';

export type CollectionBackend = 'ego' | 'tavily' | 'browser';

export interface DreamConfigSection {
  enabled: boolean;
  idleEnabled: boolean;
  idleMinutes: number;
  sleepMinutes: number;
  dreamMode: 'always' | 'probability';
  dreamProbability: number;
  maxDreamMinutes: number;
  daydreamEnabled: boolean;
  daydreamTimes: string;
  sleepScheduleEnabled: boolean;
  sleepTimes: string;
  qqUsers: string;
  dreamTalkEnabled: boolean;
  dreamTalkGroups: string;
  dreamTalkPrivates: string;
  /** null migrates the legacy mode once; an empty list disables collection. */
  collectorOrder: CollectionBackend[] | null;
  backend: 'auto' | 'ego' | 'tavily' | 'browser';
  egoExecutableFile: string;
  egoEnabled: boolean;
  egoSpaceName: string;
  egoRequestTimeoutMs: number;
  egoMaxChars: number;
  egoRestoreMinimized: boolean;
  egoConnectionMode: 'auto' | 'direct' | 'helper';
  egoHelperDir: string;
  browserExecutableFile: string;
  searchUrlTemplate: string;
  allowedDomains: string;
  timeoutMs: number;
  maxResults: number;
  maxSourcesPerDream: number;
  maxSourcesPerDay: number;
}

export const DEFAULT_SEARCH_URL = 'https://html.duckduckgo.com/html/?q={query}&df=d';
export const DEFAULT_SEARCH_DOMAINS = 'html.duckduckgo.com';

export const DREAM_SECRET = 'CORTICO_DREAM_TAVILY_API_KEY';
export const DREAM_DEFAULTS: DreamConfigSection = {
  enabled: false, idleEnabled: false, idleMinutes: 30, sleepMinutes: 10,
  dreamMode: 'always', dreamProbability: 0.5, maxDreamMinutes: 5,
  daydreamEnabled: false, daydreamTimes: '', sleepScheduleEnabled: false, sleepTimes: '',
  qqUsers: '', dreamTalkEnabled: false, dreamTalkGroups: '', dreamTalkPrivates: '',
  collectorOrder: null, backend: 'auto', egoExecutableFile: 'ego-browser', egoEnabled: false, egoSpaceName: '',
  egoRequestTimeoutMs: 45000, egoMaxChars: 16000, egoRestoreMinimized: true, egoConnectionMode: 'auto', egoHelperDir: '', browserExecutableFile: '',
  searchUrlTemplate: DEFAULT_SEARCH_URL, allowedDomains: DEFAULT_SEARCH_DOMAINS, timeoutMs: 30000, maxResults: 5,
  maxSourcesPerDream: 5, maxSourcesPerDay: 20,
};

export function dreamConfigGroups(language: Language = 'zh'): ConfigGroup[] {
  const names = configLabels(language);
  const t = strings(language);
  const sections: Array<{ id: string; title: string; keys: Array<Exclude<keyof DreamConfigSection, 'collectorOrder'>> }> = [
    { id: 'world:dream', title: t.groupSleepTitle, keys: [
      'idleEnabled', 'idleMinutes', 'sleepMinutes', 'sleepScheduleEnabled', 'sleepTimes',
      'dreamMode', 'dreamProbability', 'maxDreamMinutes', 'daydreamEnabled',
    ] },
    { id: 'world:dream:collection', title: t.groupCollectionTitle, keys: ['maxSourcesPerDream', 'maxSourcesPerDay', 'timeoutMs', 'maxResults'] },
    { id: 'world:dream:ego', title: t.egoTitle, keys: [
      'egoExecutableFile', 'egoSpaceName', 'egoRequestTimeoutMs', 'egoMaxChars',
      'egoRestoreMinimized', 'egoConnectionMode', 'egoHelperDir',
    ] },
  ];
  const limits: Partial<Record<keyof DreamConfigSection, [number, number]>> = {
    idleMinutes: [1, 1440], sleepMinutes: [1, 1440], dreamProbability: [0, 1],
    maxDreamMinutes: [1, 60], timeoutMs: [1000, 120000], maxResults: [1, 20],
    maxSourcesPerDream: [1, 20], maxSourcesPerDay: [1, 1000],
    egoRequestTimeoutMs: [5000, 120000], egoMaxChars: [1000, 60000],
  };
  const descriptions: Partial<Record<keyof DreamConfigSection, string>> = {
    daydreamEnabled: t.daydreamEnabledDescription,
  };
  return sections.map(({ id, title, keys }) => {
    const properties: Record<string, ConfigProperty> = {};
    for (const key of keys) {
      const value = DREAM_DEFAULTS[key];
      properties[`worlds.dream.${key}`] = {
        type: ['egoRequestTimeoutMs', 'egoMaxChars', 'timeoutMs', 'maxResults', 'maxSourcesPerDream', 'maxSourcesPerDay'].includes(key) ? 'integer' : typeof value as 'boolean' | 'number' | 'string', title: names[key], 'x-hot': true,
        ...(descriptions[key] ? { description: descriptions[key] } : {}),
        ...(limits[key] ? { minimum: limits[key]![0], maximum: limits[key]![1] } : {}),
        ...(key === 'dreamMode' ? { enum: ['always', 'probability'] } : {}),
        ...(key === 'backend' ? { enum: ['auto', 'ego', 'tavily', 'browser'] } : {}),
        ...(key === 'egoConnectionMode' ? { enum: ['auto', 'direct', 'helper'] } : {}),
        ...(key === 'egoHelperDir' ? { 'x-path': { kind: 'directory' } } : {}),
        ...(key.endsWith('Times') ? { pattern: '^$|^(?:[01][0-9]|2[0-3]):[0-5][0-9](?:[, ]+(?:[01][0-9]|2[0-3]):[0-5][0-9])*$' } : {}),
        ...(key.endsWith('File') ? { 'x-path': { kind: 'file' } } : {}),
      };
    }
    return { id, owner: 'world:dream', schema: { type: 'object', title, properties } };
  });
}

export function splitList(value: string): string[] { return value.split(/[\s,，]+/u).filter(Boolean); }
export const QQ_CONFIG_FIELDS = ['qqUsers', 'dreamTalkEnabled', 'dreamTalkGroups', 'dreamTalkPrivates'] as const;
export type QQConfig = Pick<DreamConfigSection, typeof QQ_CONFIG_FIELDS[number]>;
export const QQ_ID = /^[1-9][0-9]{0,19}$/u;

export function qqConfig(config: DreamConfigSection): QQConfig {
  return Object.fromEntries(QQ_CONFIG_FIELDS.map(field => [field, config[field]])) as QQConfig;
}

/** QQ command owners and dream-sharing destinations are separate lists of decimal identifiers. */
export function qqConfigPatch(value: unknown): Partial<QQConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid QQ configuration.');
  const patch: Partial<QQConfig> = {};
  for (const [key, item] of Object.entries(value)) {
    if (!(QQ_CONFIG_FIELDS as readonly string[]).includes(key)) throw new Error('Unknown QQ configuration field.');
    if (key === 'dreamTalkEnabled') {
      if (typeof item !== 'boolean') throw new Error('Invalid dream-sharing switch.');
      patch.dreamTalkEnabled = item;
    } else {
      if (typeof item !== 'string') throw new Error('Invalid QQ identifier list.');
      const ids = [...new Set(splitList(item))];
      if (!ids.every(id => QQ_ID.test(id))) throw new Error('Invalid QQ identifier.');
      patch[key as Exclude<keyof QQConfig, 'dreamTalkEnabled'>] = ids.join(',');
    }
  }
  return patch;
}

export function bounded(value: unknown, min: number, max: number, label: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`Invalid ${label}.`);
  return value;
}
