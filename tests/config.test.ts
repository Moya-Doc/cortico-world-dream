import { describe, expect, it } from 'vitest';
import { DREAM_DEFAULTS, dreamConfigGroups, qqConfig, qqConfigPatch, QQ_CONFIG_FIELDS, type CollectionBackend, type DreamConfigSection } from '../src/config.ts';
import { COLLECTOR_FIELDS, collectorConfig, collectorPatch, collectorReadiness, selectedBackends } from '../src/collection.ts';
import { configLabels, DREAM_LANGUAGES, strings } from '../src/strings.ts';

describe('Dream configuration groups', () => {
  it('declares all editable settings exactly once without Profile or video configuration', () => {
    const groups = dreamConfigGroups('en');
    const properties = groups.flatMap(group => Object.keys(group.schema.properties));
    const panelOrLegacy = ['enabled', 'daydreamTimes', 'collectorOrder', 'backend', 'egoEnabled', 'browserExecutableFile', 'searchUrlTemplate', 'allowedDomains', ...QQ_CONFIG_FIELDS];
    const expected = Object.keys(DREAM_DEFAULTS).filter(key => !panelOrLegacy.includes(key)).map(key => `worlds.dream.${key}`);
    expect(properties.sort()).toEqual(expected.sort());
    expect(new Set(properties).size).toBe(properties.length);
    expect(new Set(groups.map(group => group.id)).size).toBe(groups.length);
    expect(groups.every(group => group.owner === 'world:dream')).toBe(true);
    expect(DREAM_DEFAULTS).not.toHaveProperty('egoProfileId');
    expect(properties.some(key => /video|danmaku|bilibili/i.test(key))).toBe(false);
  });
  it('keeps ego connection settings without duplicate selection or obsolete Chrome settings', () => {
    const groups = dreamConfigGroups('en');
    const ego = groups.find(group => group.id === 'world:dream:ego')!.schema.properties;
    expect(Object.keys(ego).every(path => path.startsWith('worlds.dream.ego'))).toBe(true);
    expect(ego).toHaveProperty('worlds.dream.egoConnectionMode');
    expect(ego).not.toHaveProperty('worlds.dream.searchUrlTemplate');
    expect(ego).not.toHaveProperty('worlds.dream.egoEnabled');
    expect(groups.some(group => group.id === 'world:dream:browser')).toBe(false);
    expect(groups[0]!.schema.properties).toHaveProperty('worlds.dream.dreamProbability');
    expect(groups[0]!.schema.properties).toHaveProperty('worlds.dream.sleepMinutes');
  });
  it('provides translated group and field titles in every host language', () => {
    for (const language of DREAM_LANGUAGES) {
      const groups = dreamConfigGroups(language), t = strings(language), labels = configLabels(language);
      expect(groups.map(group => group.schema.title)).toEqual([
        t.groupSleepTitle, t.groupCollectionTitle, t.archive, t.egoTitle,
      ]);
      for (const group of groups) for (const [path, property] of Object.entries(group.schema.properties)) {
        expect(property.title).toBe(labels[path.slice('worlds.dream.'.length) as keyof typeof labels]);
        expect(property.title.trim()).toBeTruthy();
      }
    }
  });
  it('declares ego numeric bounds, modes, optional helper directory and existing schedule bounds', () => {
    const fields = Object.assign({}, ...dreamConfigGroups('en').map(group => group.schema.properties));
    expect(fields['worlds.dream.egoRequestTimeoutMs']).toMatchObject({ minimum: 5000, maximum: 120000 });
    expect(fields['worlds.dream.egoMaxChars']).toMatchObject({ minimum: 1000, maximum: 60000 });
    expect(fields['worlds.dream.egoConnectionMode'].enum).toEqual(['auto', 'direct', 'helper']);
    expect(fields['worlds.dream.egoHelperDir']['x-path']).toEqual({ kind: 'directory' });
    expect(fields['worlds.dream.sleepMinutes']).toMatchObject({ minimum: 1, maximum: 1440, 'x-hot': true });
    expect(fields['worlds.dream.dreamProbability']).toMatchObject({ minimum: 0, maximum: 1 });
    const pattern = new RegExp(fields['worlds.dream.sleepTimes'].pattern);
    expect(pattern.test('08:00,22:30')).toBe(true); expect(pattern.test('24:00')).toBe(false);
  });
  it('makes public web search ready without browser paths or custom search URLs', () => {
    const config: DreamConfigSection = { ...DREAM_DEFAULTS, collectorOrder: ['browser'], browserExecutableFile: '', searchUrlTemplate: '', allowedDomains: '' };
    expect(collectorReadiness(config, '', 'en').readiness).toEqual({ ready: true, backend: 'browser', missing: [] });
  });
  it('provides one hot archive threshold with integer bounds and translated promotion rules', () => {
    for (const language of DREAM_LANGUAGES) {
      const archive = dreamConfigGroups(language).find(group => group.id === 'world:dream:archive')!;
      const field = archive.schema.properties['worlds.dream.deepDreamThreshold'];
      expect(Object.keys(archive.schema.properties)).toEqual(['worlds.dream.deepDreamThreshold']);
      expect(field).toMatchObject({ type: 'integer', minimum: 0, maximum: 1000, 'x-hot': true,
        title: configLabels(language).deepDreamThreshold, description: strings(language).deepDreamThresholdDescription });
      expect(DREAM_DEFAULTS.deepDreamThreshold).toBeGreaterThanOrEqual(field.minimum!);
      expect(DREAM_DEFAULTS.deepDreamThreshold).toBeLessThanOrEqual(field.maximum!);
      for (const key of ['archiveRetentionHint', 'deepDreamLabel', 'dreamScore', 'deepDreamThresholdDescription'] as const) {
        expect(strings(language)[key].trim()).toBeTruthy();
      }
    }
  });
  it('validates article quotas for every backend independently of per-search result limits', () => {
    const fields = Object.assign({}, ...dreamConfigGroups('en').map(group => group.schema.properties));
    expect(fields['worlds.dream.maxSourcesPerDream']).toMatchObject({ type: 'integer', minimum: 1, maximum: 20, 'x-hot': true });
    expect(fields['worlds.dream.maxSourcesPerDay']).toMatchObject({ type: 'integer', minimum: 1, maximum: 1000, 'x-hot': true });
    const patch = { maxSourcesPerDream: 3, maxSourcesPerDay: 12 };
    expect(collectorPatch(patch)).toEqual(patch);
    for (const invalid of [{ maxSourcesPerDream: 0 }, { maxSourcesPerDream: 21 }, { maxSourcesPerDay: 0 }, { maxSourcesPerDay: 1001 }, { maxSourcesPerDay: 2.5 }]) {
      expect(() => collectorPatch(invalid)).toThrow();
      for (const backend of ['ego', 'tavily', 'browser'] as const) {
        const status = collectorReadiness({ ...DREAM_DEFAULTS, collectorOrder: [backend], ...invalid }, 'fixture-key', 'en');
        expect(status.readiness.ready).toBe(false);
      }
    }
  });
});

describe('QQ dream-sharing configuration', () => {
  it('exposes only QQ settings and keeps command owners separate from recipients', () => {
    const config = { ...DREAM_DEFAULTS, qqUsers: '1001', dreamTalkEnabled: true, dreamTalkGroups: '2001', dreamTalkPrivates: '3001' };
    const exposed = qqConfig(config);
    expect(Object.keys(exposed)).toEqual([...QQ_CONFIG_FIELDS]);
    expect(exposed).toEqual({ qqUsers: '1001', dreamTalkEnabled: true, dreamTalkGroups: '2001', dreamTalkPrivates: '3001' });
    exposed.qqUsers = '3001';
    expect(config.qqUsers).toBe('1001');
    const generic = dreamConfigGroups('en').flatMap(group => Object.keys(group.schema.properties));
    for (const field of QQ_CONFIG_FIELDS) expect(generic).not.toContain(`worlds.dream.${field}`);
  });

  it('normalizes duplicate IDs and mixed separators without rounding long decimal identifiers', () => {
    const longId = '99999999999999999999';
    expect(qqConfigPatch({ qqUsers: ` 1001，1001\n${longId} `, dreamTalkGroups: '2001, 2002，2001', dreamTalkPrivates: '3001\t3001\n3002' }))
      .toEqual({ qqUsers: `1001,${longId}`, dreamTalkGroups: '2001,2002', dreamTalkPrivates: '3001,3002' });
    expect(qqConfigPatch({ dreamTalkEnabled: false, dreamTalkPrivates: ' \n' })).toEqual({ dreamTalkEnabled: false, dreamTalkPrivates: '' });
  });

  it('rejects unknown settings, nonstring IDs and invalid decimal identifiers before returning a patch', () => {
    for (const value of [null, [], '1001', { enabled: true }, { sleepMinutes: 1 }, { dreamTalkEnabled: 'true' }, { dreamTalkEnabled: 1 }]) {
      expect(() => qqConfigPatch(value)).toThrow();
    }
    for (const field of ['qqUsers', 'dreamTalkGroups', 'dreamTalkPrivates']) {
      for (const value of [1001, ['1001'], null, '0', '001', '-1001', '+1001', '1.5', '1e4', 'group:1001', '123456789012345678901', '1001;1002']) {
        expect(() => qqConfigPatch({ [field]: value })).toThrow();
      }
    }
  });
});

describe('ego collection configuration', () => {
  it('keeps default PATH discovery disabled so configured Tavily remains selected', () => {
    expect(DREAM_DEFAULTS.egoExecutableFile).toBe('ego-browser');
    expect(DREAM_DEFAULTS.egoEnabled).toBe(false);
    expect(collectorReadiness({ ...DREAM_DEFAULTS }, 'fixture-credential', 'en').readiness).toEqual({ ready: true, backend: 'tavily', missing: [] });
  });
  it.each(['', 'ego-browser', '/Applications/Fixture Browser.app'])('accepts enabled ego command %s without Profile or search URL configuration', egoExecutableFile => {
    const config: DreamConfigSection = { ...DREAM_DEFAULTS, collectorOrder: ['ego'], egoExecutableFile, searchUrlTemplate: '', allowedDomains: '', timeoutMs: 0, maxResults: 0 };
    expect(collectorReadiness(config, '', 'en').readiness).toEqual({ ready: true, backend: 'ego', missing: [] });
  });
  it.each([
    { egoExecutableFile: 'relative/path' }, { egoExecutableFile: 'command --argument' },
    { egoRequestTimeoutMs: 1 }, { egoRequestTimeoutMs: 120001 }, { egoMaxChars: 999 }, { egoMaxChars: 60001 },
    { egoHelperDir: '../helper' }, { egoSpaceName: '\u0000' },
  ])('rejects malformed ego readiness configuration %j', patch => {
    expect(collectorReadiness({ ...DREAM_DEFAULTS, collectorOrder: ['ego'], ...patch }, '', 'en').readiness.ready).toBe(false);
  });
  it('exposes and patches only declared nonsecret collector fields', () => {
    const exposed = collectorConfig({ ...DREAM_DEFAULTS });
    expect(Object.keys(exposed)).toEqual([...COLLECTOR_FIELDS]);
    const patch = { collectorOrder: ['browser', 'ego'], egoExecutableFile: '', egoConnectionMode: 'helper', egoHelperDir: '/fixture/helper', egoRequestTimeoutMs: 5000, egoMaxChars: 60000, egoRestoreMinimized: false };
    expect(collectorPatch(patch)).toEqual(patch);
    for (const value of [{ apiKey: 'secret' }, { egoProfileId: 'profile' }, { enabled: true }, { egoEnabled: true }, { backend: 'ego' }, { browserExecutableFile: '/fixture/browser' }, { searchUrlTemplate: 'https://search.example/?q={query}' }, { allowedDomains: 'search.example' }, { egoConnectionMode: 'invalid' }, { egoRequestTimeoutMs: 4999 }, { egoMaxChars: 60001 }, { egoHelperDir: 'relative' }]) {
      expect(() => collectorPatch(value)).toThrow();
    }
  });
});

describe('ordered collection selection', () => {
  it('accepts optional official WebSearch in the shared priority list without changing defaults', () => {
    const collectorOrder = ['websearch', 'browser', 'ego', 'tavily'];
    expect(collectorPatch({ collectorOrder })).toEqual({ collectorOrder });
    expect(selectedBackends({ ...DREAM_DEFAULTS })).not.toContain('websearch');
    expect(selectedBackends({ ...DREAM_DEFAULTS, collectorOrder: ['websearch', 'browser'] })).toEqual(['websearch', 'browser']);
  });

  it('checks only Dream quotas for official WebSearch and does not imply tool availability', () => {
    const config: DreamConfigSection = { ...DREAM_DEFAULTS, collectorOrder: ['websearch'], timeoutMs: 0, maxResults: 0, egoExecutableFile: 'invalid/path' };
    expect(collectorReadiness(config, '', 'en')).toMatchObject({ webSearchConfigured: true, webSearchMissing: [],
      readiness: { ready: true, backend: 'websearch', missing: [] } });
    expect(collectorReadiness({ ...config, maxSourcesPerDream: 0 }, '', 'en')).toMatchObject({ webSearchConfigured: false,
      readiness: { ready: false, backend: null } });
  });

  it.each([
    { backend: 'auto', egoEnabled: true, expected: ['ego', 'tavily'] },
    { backend: 'auto', egoEnabled: false, expected: ['tavily'] },
    { backend: 'ego', egoEnabled: true, expected: ['ego'] },
    { backend: 'ego', egoEnabled: false, expected: [] },
    { backend: 'tavily', egoEnabled: true, expected: ['tavily'] },
    { backend: 'browser', egoEnabled: true, expected: ['browser'] },
  ] as const)('preserves legacy selection $backend with ego enabled $egoEnabled', ({ backend, egoEnabled, expected }) => {
    expect(selectedBackends({ ...DREAM_DEFAULTS, backend, egoEnabled })).toEqual(expected);
  });
  it('keeps explicit order and an empty selection authoritative over legacy fields', () => {
    const config: DreamConfigSection = { ...DREAM_DEFAULTS, backend: 'ego', egoEnabled: true, collectorOrder: ['browser', 'tavily'] };
    expect(selectedBackends(config)).toEqual(['browser', 'tavily']);
    expect(collectorReadiness(config, 'fixture-key', 'en').activeBackend).toBe('browser');
    config.collectorOrder = [];
    const status = collectorReadiness(config, 'fixture-key', 'en');
    expect(status.readiness).toEqual({ ready: false, backend: null, missing: [strings('en').collectionNoneSelected] });
    expect(status.egoConfigured).toBe(true);
    expect(status.browserConfigured).toBe(true);
  });
  it('skips incomplete selected backends while retaining their missing configuration', () => {
    const config: DreamConfigSection = { ...DREAM_DEFAULTS, collectorOrder: ['tavily', 'ego', 'browser'], egoExecutableFile: 'invalid/path' };
    const status = collectorReadiness(config, '', 'en');
    expect(status.readiness.ready).toBe(true);
    expect(status.activeBackend).toBe('browser');
    expect(status.tavilyMissing).toContain(strings('en').keyTitle);
    expect(status.egoMissing).toContain(configLabels('en').egoExecutableFile);
    expect(status.readiness.missing).toHaveLength(2);
  });
  it('rejects duplicate, unknown, malformed and null public selections', () => {
    for (const collectorOrder of [['ego', 'ego'], ['unknown'], 'ego,tavily', null, [1], ['ego', 'tavily', 'browser', 'ego']]) {
      expect(() => collectorPatch({ collectorOrder })).toThrow('Invalid collection order');
      if (collectorOrder !== null) expect(collectorReadiness({ ...DREAM_DEFAULTS, collectorOrder } as DreamConfigSection, '', 'en').readiness)
        .toEqual({ ready: false, backend: null, missing: [strings('en').collectorOrderInvalid] });
    }
  });
  it('copies selected lists at the public configuration boundary', () => {
    const order: CollectionBackend[] = ['browser', 'ego'];
    const config: DreamConfigSection = { ...DREAM_DEFAULTS, collectorOrder: order };
    const patch = collectorPatch({ collectorOrder: order });
    const exposed = collectorConfig(config);
    order.pop();
    expect(patch.collectorOrder).toEqual(['browser', 'ego']);
    expect(exposed.collectorOrder).toEqual(['browser', 'ego']);
    expect(collectorPatch({ collectorOrder: [] })).toEqual({ collectorOrder: [] });
  });
});
