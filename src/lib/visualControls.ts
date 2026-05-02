import type {
  AssetEntity,
  AssetVisualOverride,
  IconImageSpec,
  IconSpec,
  IconTextSpec,
  SpaceEntity,
  VisualControlState,
} from './types';
import type { AssetThemeStyle, SpaceThemeStyle } from './buildingMapTheme';
import { normalizeBrickKey } from './themeUtils';

type ResolvedSpaceVisual = SpaceThemeStyle & {
  iconSpec?: IconSpec;
};

type ResolvedAssetVisual = AssetThemeStyle & {
  iconSpec?: IconSpec;
  rotationDegrees: number;
};

function pickClassOverride<T extends object>(
  overrides: Record<string, T> | undefined,
  keys: string[],
): T | undefined {
  if (!overrides) {
    return undefined;
  }
  for (const key of keys) {
    if (!key) {
      continue;
    }
    const found = overrides[key.toLowerCase()];
    if (found) {
      return found;
    }
  }
  return undefined;
}

function normalizeIconSpec(icon: string | IconSpec | undefined): IconSpec | undefined {
  if (!icon) {
    return undefined;
  }
  if (typeof icon === 'string') {
    return { kind: 'text', text: icon };
  }
  return icon;
}

function resolveRotationDegrees(
  rotation: AssetVisualOverride['rotation'] | undefined,
  clockMs: number,
): number {
  if (!rotation) {
    return 0;
  }
  if (typeof rotation.angleDegrees === 'number') {
    return rotation.angleDegrees;
  }
  if (typeof rotation.velocityDegreesPerSecond !== 'number') {
    return rotation.baseDegrees ?? 0;
  }

  const start = rotation.startTimeMs ?? 0;
  const elapsedSeconds = Math.max(0, (clockMs - start) / 1000);
  return (rotation.baseDegrees ?? 0) + elapsedSeconds * rotation.velocityDegreesPerSecond;
}

export function hasVelocityRotation(visualControls?: VisualControlState): boolean {
  if (!visualControls) {
    return false;
  }

  const classAssetValues = Object.values(visualControls.classes?.assets ?? {});
  const assetValues = Object.values(visualControls.assets ?? {});
  return [...classAssetValues, ...assetValues].some(
    (value) => typeof value.rotation?.velocityDegreesPerSecond === 'number',
  );
}

export function collectVisualControlImageUrls(visualControls?: VisualControlState): string[] {
  if (!visualControls) {
    return [];
  }

  const urls = new Set<string>();
  const collect = (icon?: string | IconSpec) => {
    const spec = normalizeIconSpec(icon);
    if (spec?.kind === 'image' && spec.url) {
      urls.add(spec.url);
    }
  };

  Object.values(visualControls.classes?.spaces ?? {}).forEach((value) => collect(value.icon));
  Object.values(visualControls.classes?.assets ?? {}).forEach((value) => collect(value.icon));
  Object.values(visualControls.spaces ?? {}).forEach((value) => collect(value.icon));
  Object.values(visualControls.assets ?? {}).forEach((value) => collect(value.icon));

  return Array.from(urls);
}

export function resolveSpaceVisual(
  space: SpaceEntity,
  baseStyle: SpaceThemeStyle,
  visualControls: VisualControlState | undefined,
): ResolvedSpaceVisual {
  if (!visualControls) {
    return {
      ...baseStyle,
      iconSpec: normalizeIconSpec(baseStyle.icon),
    };
  }

  const fullClass = (space.brickClass ?? '').toLowerCase();
  const localClass = normalizeBrickKey(space.brickClass);

  const classOverride = pickClassOverride(visualControls.classes?.spaces, [fullClass, localClass]);
  const instanceOverride = visualControls.spaces?.[space.id];
  const merged = {
    ...classOverride,
    ...instanceOverride,
  };
  const { icon: mergedIcon, ...mergedStyle } = merged;
  const iconSpec = normalizeIconSpec(mergedIcon ?? baseStyle.icon);

  return {
    ...baseStyle,
    ...mergedStyle,
    icon: getIconText(iconSpec) ?? baseStyle.icon,
    iconSpec,
  };
}

export function resolveAssetVisual(
  asset: AssetEntity,
  baseStyle: AssetThemeStyle,
  visualControls: VisualControlState | undefined,
  clockMs: number,
): ResolvedAssetVisual {
  if (!visualControls) {
    return {
      ...baseStyle,
      iconSpec: normalizeIconSpec(baseStyle.icon),
      rotationDegrees: 0,
    };
  }

  const fullClass = (asset.brickClass ?? '').toLowerCase();
  const localClass = normalizeBrickKey(asset.brickClass);
  const typeKey = (asset.type ?? '').toLowerCase();

  const classOverride = pickClassOverride(visualControls.classes?.assets, [fullClass, localClass, typeKey]);
  const instanceOverride = visualControls.assets?.[asset.id];
  const merged = {
    ...classOverride,
    ...instanceOverride,
  };
  const { icon: mergedIcon, rotation, ...mergedStyle } = merged;
  const iconSpec = normalizeIconSpec(mergedIcon ?? baseStyle.icon);
  const resolvedRotation = resolveRotationDegrees(rotation, clockMs);

  return {
    ...baseStyle,
    ...mergedStyle,
    icon: getIconText(iconSpec) ?? baseStyle.icon,
    iconSpec,
    rotationDegrees: resolvedRotation,
  };
}

export function getIconText(spec?: IconSpec): string | undefined {
  if (!spec || spec.kind !== 'text') {
    return undefined;
  }
  return (spec as IconTextSpec).text;
}

export function isImageIcon(spec?: IconSpec): spec is IconImageSpec {
  return Boolean(spec && spec.kind === 'image');
}
