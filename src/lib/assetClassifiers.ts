import type { AssetEntity, SpaceEntity } from './types';
import { normalizeBrickKey } from './themeUtils';

export function isDoorAsset(asset: AssetEntity): boolean {
  const type = normalizeBrickKey(asset.brickClass);
  return type.includes('door');
}

export function isWindowAsset(asset: AssetEntity): boolean {
  const type = normalizeBrickKey(asset.brickClass);
  return type.includes('window');
}

export function isFloorPlanAsset(asset: AssetEntity): boolean {
  return isDoorAsset(asset) || isWindowAsset(asset);
}

export function isSensorAsset(asset: AssetEntity): boolean {
  const localClass = normalizeBrickKey(asset.brickClass);
  const typeKey = (asset.type ?? '').toLowerCase();
  // Thermostats go in the sensor layer by explicit design decision.
  if (localClass.includes('thermostat')) return true;
  return typeKey === 'sensor' || localClass.includes('sensor');
}

export function isHvacAsset(asset: AssetEntity): boolean {
  return !isFloorPlanAsset(asset) && !isSensorAsset(asset);
}

export function isPlenumSpace(space: SpaceEntity): boolean {
  return normalizeBrickKey(space.brickClass) === 'plenum';
}
