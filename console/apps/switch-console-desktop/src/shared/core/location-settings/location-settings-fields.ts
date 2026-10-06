import {
  SHAREABLE_LOCATION_SETTINGS_WRITE_FIELDS,
  type ShareableLocationSettings,
  type ShareableLocationSettingsWriteField,
} from './location-settings';

type ShareableFieldAccessor = {
  get(settings: ShareableLocationSettings): unknown;
  set(settings: ShareableLocationSettings, value: unknown): void;
  clear(settings: ShareableLocationSettings): void;
};

function ensureScripts(
  settings: ShareableLocationSettings
): NonNullable<ShareableLocationSettings['scripts']> {
  settings.scripts ??= {};
  return settings.scripts;
}

function compactScripts(settings: ShareableLocationSettings): void {
  if (settings.scripts && Object.values(settings.scripts).every((value) => value === undefined)) {
    delete settings.scripts;
  }
}

export const SHAREABLE_FIELD_ACCESSORS = {
  preservePatterns: {
    get: (settings) => settings.preservePatterns,
    set: (settings, value) => {
      settings.preservePatterns = value as string[] | undefined;
    },
    clear: (settings) => {
      delete settings.preservePatterns;
    },
  },
  shellSetup: {
    get: (settings) => settings.shellSetup,
    set: (settings, value) => {
      settings.shellSetup = value as string | undefined;
    },
    clear: (settings) => {
      delete settings.shellSetup;
    },
  },
  'scripts.setup': {
    get: (settings) => settings.scripts?.setup,
    set: (settings, value) => {
      ensureScripts(settings).setup = value as string | undefined;
    },
    clear: (settings) => {
      if (settings.scripts) delete settings.scripts.setup;
      compactScripts(settings);
    },
  },
  'scripts.run': {
    get: (settings) => settings.scripts?.run,
    set: (settings, value) => {
      ensureScripts(settings).run = value as string | undefined;
    },
    clear: (settings) => {
      if (settings.scripts) delete settings.scripts.run;
      compactScripts(settings);
    },
  },
  'scripts.teardown': {
    get: (settings) => settings.scripts?.teardown,
    set: (settings, value) => {
      ensureScripts(settings).teardown = value as string | undefined;
    },
    clear: (settings) => {
      if (settings.scripts) delete settings.scripts.teardown;
      compactScripts(settings);
    },
  },
} satisfies Record<ShareableLocationSettingsWriteField, ShareableFieldAccessor>;

export function mergeShareableLocationSettings(
  ...sources: ShareableLocationSettings[]
): ShareableLocationSettings {
  const next: ShareableLocationSettings = {};

  for (const source of sources) {
    for (const field of SHAREABLE_LOCATION_SETTINGS_WRITE_FIELDS) {
      const value = SHAREABLE_FIELD_ACCESSORS[field].get(source);
      if (value !== undefined) {
        SHAREABLE_FIELD_ACCESSORS[field].set(next, value);
      }
    }
  }

  return next;
}
