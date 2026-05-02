import type { AssetEntity, SpaceEntity } from './types';
import {
  DEFAULT_BUILDING_MAP_THEME,
  type AssetThemeStyle,
  type BuildingMapTheme,
  type BuildingMapThemeDictionary,
  type BuildingMapThemeOverrides,
  type DeepPartial,
  type SpaceThemeStyle,
} from './buildingMapTheme';

export function normalizeBrickKey(value?: string): string {
  if (!value) {
    return '';
  }

  const lowered = value.toLowerCase();
  const hashSplit = lowered.split('#').pop() ?? lowered;
  const slashSplit = hashSplit.split('/').pop() ?? hashSplit;
  return slashSplit.split(':').pop() ?? slashSplit;
}

function mergeStyleMap<T extends object>(
  defaults: Record<string, Partial<T>>,
  overrides?: DeepPartial<Record<string, Partial<T>>>,
): Record<string, Partial<T>> {
  if (!overrides) {
    return { ...defaults };
  }

  const result: Record<string, Partial<T>> = { ...defaults };
  for (const [key, value] of Object.entries(overrides)) {
    if (!value || typeof value !== 'object') {
      continue;
    }
    result[key.toLowerCase()] = {
      ...(result[key.toLowerCase()] ?? {}),
      ...(value as Partial<T>),
    };
  }
  return result;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function deepMerge(base: unknown, patch: unknown): unknown {
  if (!isRecord(base) || !isRecord(patch)) {
    return patch === undefined ? base : patch;
  }

  const merged: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) {
      continue;
    }

    merged[key] = key in merged ? deepMerge(merged[key], value) : value;
  }
  return merged;
}

export function resolveTheme(
  typedOverrides?: BuildingMapThemeOverrides,
  dictionaryOverrides?: BuildingMapThemeDictionary,
): BuildingMapTheme {
  if (!typedOverrides && !dictionaryOverrides) {
    return DEFAULT_BUILDING_MAP_THEME;
  }

  const combinedOverrides = deepMerge(
    typedOverrides ?? {},
    dictionaryOverrides ?? {},
  ) as BuildingMapThemeOverrides;

  return {
    ...DEFAULT_BUILDING_MAP_THEME,
    ...combinedOverrides,
    spaceDefaults: {
      ...DEFAULT_BUILDING_MAP_THEME.spaceDefaults,
      ...(combinedOverrides.spaceDefaults ?? {}),
    },
    assetDefaults: {
      ...DEFAULT_BUILDING_MAP_THEME.assetDefaults,
      ...(combinedOverrides.assetDefaults ?? {}),
    },
    spaceStyles: mergeStyleMap<SpaceThemeStyle>(
      DEFAULT_BUILDING_MAP_THEME.spaceStyles,
      combinedOverrides.spaceStyles,
    ),
    assetStyles: mergeStyleMap<AssetThemeStyle>(
      DEFAULT_BUILDING_MAP_THEME.assetStyles,
      combinedOverrides.assetStyles,
    ),
  };
}

export function resolveSpaceStyle(theme: BuildingMapTheme, space: SpaceEntity): SpaceThemeStyle {
  const fullKey = (space.brickClass ?? '').toLowerCase();
  const localKey = normalizeBrickKey(space.brickClass);

  let match =
    (fullKey && theme.spaceStyles[fullKey]) ||
    (localKey && theme.spaceStyles[localKey]) ||
    undefined;

  if (!match && localKey.includes('room')) {
    match = theme.spaceStyles.room;
  }
  if (!match && localKey.includes('hall')) {
    match = theme.spaceStyles.hallway;
  }

  return {
    ...theme.spaceDefaults,
    ...(match ?? {}),
  };
}

export function resolveAssetStyle(theme: BuildingMapTheme, asset: AssetEntity): AssetThemeStyle {
  const fullClass = (asset.brickClass ?? '').toLowerCase();
  const localClass = normalizeBrickKey(asset.brickClass);
  const typeKey = (asset.type ?? '').toLowerCase();

  let match =
    (fullClass && theme.assetStyles[fullClass]) ||
    (localClass && theme.assetStyles[localClass]) ||
    (typeKey && theme.assetStyles[typeKey]) ||
    undefined;

  if (!match && localClass.includes('door')) {
    match = theme.assetStyles.door_equipment;
  }
  if (!match && localClass.includes('window')) {
    match = theme.assetStyles.window_equipment;
  }

  if (!match && (localClass.includes('sensor') || typeKey.includes('sensor'))) {
    match = theme.assetStyles.sensor;
  }
  if (!match && (localClass.includes('actuator') || typeKey.includes('actuator'))) {
    match = theme.assetStyles.actuator;
  }
  if (!match && (localClass.includes('equipment') || typeKey.includes('equipment'))) {
    match = theme.assetStyles.equipment;
  }

  return {
    ...theme.assetDefaults,
    ...(match ?? {}),
  };
}

export function formatBrickTypeLabel(brickClass?: string): string | undefined {
  const key = normalizeBrickKey(brickClass);
  if (!key) {
    return undefined;
  }

  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (value) => value.toUpperCase());
}
