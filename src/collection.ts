import { isAbsolute } from 'node:path';
import type { Language } from 'cortico/core/language.ts';
import type { CollectionBackend, DreamConfigSection } from './config.ts';
import { configLabels, strings, type ConfigLabelKey } from './strings.ts';

export const COLLECTOR_FIELDS = [
  'collectorOrder', 'egoExecutableFile', 'egoSpaceName', 'egoRequestTimeoutMs', 'egoMaxChars',
  'egoRestoreMinimized', 'egoConnectionMode', 'egoHelperDir',
  'timeoutMs', 'maxResults', 'maxSourcesPerDream', 'maxSourcesPerDay',
] as const;
export type CollectorConfig = Pick<DreamConfigSection, typeof COLLECTOR_FIELDS[number]>;
const backends: readonly CollectionBackend[] = ['ego', 'tavily', 'browser'];

function validOrder(value: unknown): value is CollectionBackend[] {
  return Array.isArray(value) && value.length <= backends.length && new Set(value).size === value.length
    && value.every(item => backends.includes(item));
}

/** Legacy selection is used only until the World persists its first ordered list. */
export function selectedBackends(config: DreamConfigSection): CollectionBackend[] {
  if (config.collectorOrder != null) return validOrder(config.collectorOrder) ? [...config.collectorOrder] : [];
  if (config.backend === 'auto') return config.egoEnabled ? ['ego', 'tavily'] : ['tavily'];
  if (config.backend === 'ego') return config.egoEnabled ? ['ego'] : [];
  return config.backend === 'tavily' || config.backend === 'browser' ? [config.backend] : [];
}

/** Readiness describes saved fields. It does not contact a backend or include its runtime failures. */
export function collectorReadiness(config: DreamConfigSection, key: string, language: Language) {
  const labels = configLabels(language);
  const t = strings(language);
  const common: ConfigLabelKey[] = [];
  const quotas: ConfigLabelKey[] = [];
  if (!Number.isInteger(config.maxSourcesPerDream) || config.maxSourcesPerDream < 1 || config.maxSourcesPerDream > 20) quotas.push('maxSourcesPerDream');
  if (!Number.isInteger(config.maxSourcesPerDay) || config.maxSourcesPerDay < 1 || config.maxSourcesPerDay > 1000) quotas.push('maxSourcesPerDay');
  if (!Number.isInteger(config.timeoutMs) || config.timeoutMs < 1000 || config.timeoutMs > 120000) common.push('timeoutMs');
  if (!Number.isInteger(config.maxResults) || config.maxResults < 1 || config.maxResults > 20) common.push('maxResults');
  const egoFields: ConfigLabelKey[] = [...quotas];
  const executable = config.egoExecutableFile.trim();
  if ((executable && !isAbsolute(executable) && !/^[a-zA-Z0-9._-]+$/.test(executable))
    || /[\u0000-\u001f]/.test(config.egoExecutableFile)) egoFields.push('egoExecutableFile');
  if (!Number.isInteger(config.egoRequestTimeoutMs) || config.egoRequestTimeoutMs < 5000 || config.egoRequestTimeoutMs > 120000) egoFields.push('egoRequestTimeoutMs');
  if (!Number.isInteger(config.egoMaxChars) || config.egoMaxChars < 1000 || config.egoMaxChars > 60000) egoFields.push('egoMaxChars');
  if (!['auto', 'direct', 'helper'].includes(config.egoConnectionMode)) egoFields.push('egoConnectionMode');
  if (config.egoHelperDir.trim() && !isAbsolute(config.egoHelperDir.trim())) egoFields.push('egoHelperDir');
  if (config.egoSpaceName.length > 256 || /[\u0000-\u001f]/.test(config.egoSpaceName)) egoFields.push('egoSpaceName');
  const keyConfigured = Boolean(key.trim()) && !/\s/.test(key) && key.length <= 1024;
  const egoMissing = egoFields.map(field => labels[field]);
  const browserMissing = [...quotas, ...common].map(field => labels[field]);
  const tavilyMissing = [...quotas, ...common].map(field => labels[field]).concat(keyConfigured ? [] : [t.keyTitle]);
  const egoConfigured = !egoMissing.length;
  const browserConfigured = !browserMissing.length;
  const missingByBackend = { ego: egoMissing, tavily: tavilyMissing, browser: browserMissing };
  const order = selectedBackends(config);
  const backend = order.find(item => !missingByBackend[item].length) ?? null;
  const names = { ego: t.egoTitle, tavily: 'Tavily', browser: t.browserTitle };
  const invalid = config.collectorOrder != null && !validOrder(config.collectorOrder);
  const missing = invalid ? [t.collectorOrderInvalid] : !order.length ? [t.collectionNoneSelected]
    : order.flatMap(item => missingByBackend[item].map(field => `${names[item]}: ${field}`));
  return { egoConfigured, keyConfigured, browserConfigured, activeBackend: backend, egoMissing, tavilyMissing, browserMissing,
    readiness: { ready: backend !== null, backend, missing } };
}

export function collectorConfig(config: DreamConfigSection): CollectorConfig {
  return { ...Object.fromEntries(COLLECTOR_FIELDS.map(field => [field, config[field]])), collectorOrder: selectedBackends(config) } as CollectorConfig;
}

/** Public writes accept collection settings and an ordered, duplicate-free list of selected backends. */
export function collectorPatch(value: unknown): Partial<CollectorConfig> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid collection configuration.');
  const patch = value as Record<string, unknown>;
  for (const [key, item] of Object.entries(patch)) {
    if (!(COLLECTOR_FIELDS as readonly string[]).includes(key)) throw new Error('Unknown collection configuration field.');
    if (key === 'collectorOrder') {
      if (!validOrder(item)) throw new Error('Invalid collection order.');
    } else if (key === 'egoConnectionMode') {
      if (typeof item !== 'string' || !['auto', 'direct', 'helper'].includes(item)) throw new Error('Invalid ego connection mode.');
    } else if (key === 'egoRestoreMinimized') {
      if (typeof item !== 'boolean') throw new Error('Invalid ego switch.');
    } else if (['timeoutMs', 'maxResults', 'egoRequestTimeoutMs', 'egoMaxChars', 'maxSourcesPerDream', 'maxSourcesPerDay'].includes(key)) {
      const limits: Record<string, [number, number]> = { timeoutMs: [1000, 120000], maxResults: [1, 20], egoRequestTimeoutMs: [5000, 120000], egoMaxChars: [1000, 60000], maxSourcesPerDream: [1, 20], maxSourcesPerDay: [1, 1000] };
      const [min, max] = limits[key]!;
      if (typeof item !== 'number' || !Number.isInteger(item) || item < min || item > max) throw new Error('Invalid collection limit.');
    } else if (typeof item !== 'string' || item.length > (key === 'egoSpaceName' ? 256 : 4096)
      || /[\u0000-\u001f]/.test(item)) throw new Error('Invalid collection text.');
    if (key === 'egoHelperDir' && typeof item === 'string' && item.trim() && !isAbsolute(item.trim())) throw new Error('Invalid helper directory.');
  }

  return Object.fromEntries(Object.entries(patch).map(([key, item]) => [key,
    typeof item === 'string' ? item.trim() : Array.isArray(item) ? [...item] : item])) as Partial<CollectorConfig>;
}
