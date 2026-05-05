import { useEffect, useMemo, useRef, useState } from 'react';
import { Arc, Circle, Group, Layer, Line, Rect, Stage, Text } from 'react-konva';
import type {
  AnnotationEntity,
  AssetEntity,
  CanonicalBuildingMapModel,
  LayerData,
  LayerDefinition,
  LayerDataContext,
  MarkerLayerItem,
  Ring,
  SpaceEntity,
  VisualControlState,
  XY,
} from './types';
import { createRdfStore, type RdfStore } from './rdfStore';
import { buildAssetTooltip, getNumericAssetMetadata, resolveLayerPosition, clampMarkerToSpaceBbox } from './geometryUtils';
import {
  collectLayerImageUrls,
  collectVisualControlImageUrls,
  getIconText,
  hasVelocityRotation,
  normalizeLayerIconSpec,
  resolveAssetVisual,
  resolveSpaceVisual,
} from './visualControls';
import { renderIconAt } from './iconRendering';

type DeepPartial<T> = {
  [K in keyof T]?: T[K] extends object ? DeepPartial<T[K]> : T[K];
};

export type SpaceThemeStyle = {
  fill: string;
  fillHover: string;
  fillSelected: string;
  stroke: string;
  labelColor: string;
  icon?: string;
  iconColor?: string;
};

export type AssetThemeStyle = {
  fill: string;
  stroke: string;
  labelColor: string;
  icon?: string;
  iconColor?: string;
  radius: number;
};

export type BuildingMapTheme = {
  canvasBackground: string | null;
  floorBackground: string | null;
  floorBackgroundOpacity: number;
  annotationColor: string;
  spaceDefaults: SpaceThemeStyle;
  spaceStyles: Record<string, Partial<SpaceThemeStyle>>;
  assetDefaults: AssetThemeStyle;
  assetStyles: Record<string, Partial<AssetThemeStyle>>;
};

export type BuildingMapThemeOverrides = DeepPartial<BuildingMapTheme>;
export type BuildingMapThemeDictionary = Record<string, unknown>;

export const DEFAULT_BUILDING_MAP_THEME: BuildingMapTheme = {
  // Null means fully transparent so the map inherits the parent container background.
  canvasBackground: null,
  floorBackground: null,
  floorBackgroundOpacity: 0.22,
  annotationColor: '#1f2937',
  spaceDefaults: {
    fill: '#fdf8ee',
    fillHover: '#f5e8bb',
    fillSelected: '#f9d77a',
    stroke: '#1d1c1a',
    labelColor: '#1d1c1a',
  },
  spaceStyles: {
    room: { icon: 'Room' },
    office: { fill: '#ecf5ff', fillHover: '#dbeeff', fillSelected: '#badcff', icon: 'Office' },
    kitchen: { fill: '#fff3dd', fillHover: '#ffe6c0', fillSelected: '#ffd299', icon: 'Kitchen' },
    bathroom: { fill: '#eef6ff', fillHover: '#deecff', fillSelected: '#c0dbff', icon: 'Bathroom' },
    lobby: { fill: '#f8f3ff', fillHover: '#efe4ff', fillSelected: '#ddc8ff', icon: 'Lobby' },
    foyer: { fill: '#f8f3ff', fillHover: '#efe4ff', fillSelected: '#ddc8ff', icon: 'Foyer' },
    corridor: { fill: '#f3efe8', fillHover: '#e7dece', fillSelected: '#d7c5a7', icon: 'Corridor' },
    hallway: { fill: '#f3efe8', fillHover: '#e7dece', fillSelected: '#d7c5a7', icon: 'Hallway' },
    storage: { fill: '#f5f2e8', fillHover: '#ece5d3', fillSelected: '#d7ccb3', icon: 'Storage' },
    plenum: { fill: '#e0f2fe', fillHover: '#bae6fd', fillSelected: '#7dd3fc', stroke: '#0ea5e9', labelColor: '#0369a1', icon: 'Plenum Zone' },
  },
  assetDefaults: {
    fill: '#0f172a',
    stroke: '#38bdf8',
    labelColor: '#0f172a',
    icon: '•',
    iconColor: '#f8fafc',
    radius: 5,
  },
  assetStyles: {
    door_equipment: { fill: '#111827', stroke: '#374151', icon: 'D', radius: 6 },
    window_equipment: { fill: '#0c4a6e', stroke: '#38bdf8', icon: 'W', radius: 6 },
    sensor: { fill: '#0b3b6f', stroke: '#7dd3fc', icon: 'S', radius: 5.5 },
    equipment: { fill: '#4b5563', stroke: '#cbd5e1', icon: 'E' },
    actuator: { fill: '#7c2d12', stroke: '#fdba74', icon: 'A', radius: 5.5 },
    vav_box: { fill: '#7c3aed', stroke: '#c4b5fd', icon: 'V', radius: 5.5 },
    return_air_grille: { fill: '#065f46', stroke: '#6ee7b7', icon: 'R', radius: 5 },
    air_handling_unit: { fill: '#1d4ed8', stroke: '#93c5fd', icon: 'AH', radius: 8 },
    heat_exchanger: { fill: '#92400e', stroke: '#fcd34d', icon: 'HX', radius: 7 },
    outside_air_damper: { fill: '#065f46', stroke: '#34d399', icon: 'OA', radius: 5.5 },
    return_air_damper: { fill: '#1e3a5f', stroke: '#93c5fd', icon: 'RA', radius: 5.5 },
    exhaust_air_damper: { fill: '#374151', stroke: '#9ca3af', icon: 'EX', radius: 5.5 },
  },
};

function normalizeBrickKey(value?: string): string {
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

function resolveTheme(
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

function resolveSpaceStyle(theme: BuildingMapTheme, space: SpaceEntity): SpaceThemeStyle {
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

function resolveAssetStyle(theme: BuildingMapTheme, asset: AssetEntity): AssetThemeStyle {
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

function formatBrickTypeLabel(brickClass?: string): string | undefined {
  const key = normalizeBrickKey(brickClass);
  if (!key) {
    return undefined;
  }

  return key
    .replace(/_/g, ' ')
    .replace(/\b\w/g, (value) => value.toUpperCase());
}

function isDoorAsset(asset: AssetEntity): boolean {
  const type = normalizeBrickKey(asset.brickClass);
  return type.includes('door');
}

function isWindowAsset(asset: AssetEntity): boolean {
  const type = normalizeBrickKey(asset.brickClass);
  return type.includes('window');
}

function isFloorPlanAsset(asset: AssetEntity): boolean {
  return isDoorAsset(asset) || isWindowAsset(asset);
}

export type BuildingMapProps = {
  model: CanonicalBuildingMapModel;
  rdfStore?: RdfStore;
  width: number;
  height: number;
  northDirectionDegrees?: number;
  padding?: number;
  minZoom?: number;
  maxZoom?: number;
  resetToken?: number;
  selectedSpaceId?: string;
  onViewportChange?: (viewport: { x: number; y: number; scale: number }) => void;
  onSpaceClick?: (space: SpaceEntity) => void;
  onAssetClick?: (asset: AssetEntity) => void;
  /** External layer definitions provided by the consuming application. */
  layers?: LayerDefinition[];
  /** Visibility state keyed by external layer id. */
  visibleLayers?: Record<string, boolean>;
  onLayerToggle?: (layerId: string) => void;
  // Typed partial overrides for TypeScript consumers.
  theme?: BuildingMapThemeOverrides;
  // Dictionary overrides for runtime-configurable theming sources.
  themeOverrides?: BuildingMapThemeDictionary;
  /** External visual state (class + instance overrides, icon and rotation control). */
  visualControls?: VisualControlState;
  /** Component-level control visibility (not part of toggleable map layers). */
  controls?: {
    enabled?: boolean;
    zoomToFit?: boolean;
    fullScreen?: boolean;
    layerPanel?: boolean;
    compass?: boolean;
  };
  /**
   * When true, selecting a space zooms and centers the viewport to fit that space.
   * Deselecting (selectedSpaceId becomes undefined) restores the zoom-to-fit-all view.
   */
  zoomToSelection?: boolean;
  showControls?: boolean;
};

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const clean = hex.trim();
  const short = clean.match(/^#([0-9a-f])([0-9a-f])([0-9a-f])$/i);
  if (short) {
    return {
      r: parseInt(short[1] + short[1], 16),
      g: parseInt(short[2] + short[2], 16),
      b: parseInt(short[3] + short[3], 16),
    };
  }
  const full = clean.match(/^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i);
  if (full) {
    return {
      r: parseInt(full[1], 16),
      g: parseInt(full[2], 16),
      b: parseInt(full[3], 16),
    };
  }
  return null;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function makeGradientStops(fill: string): (number | string)[] {
  const rgb = hexToRgb(fill);
  if (!rgb) {
    return [0, fill, 1, fill];
  }
  const { r, g, b } = rgb;
  const lightR = clamp(Math.round(r + (255 - r) * 0.22), 0, 255);
  const lightG = clamp(Math.round(g + (255 - g) * 0.22), 0, 255);
  const lightB = clamp(Math.round(b + (255 - b) * 0.22), 0, 255);
  const darkR = clamp(Math.round(r * 0.84), 0, 255);
  const darkG = clamp(Math.round(g * 0.84), 0, 255);
  const darkB = clamp(Math.round(b * 0.84), 0, 255);
  return [
    0, `rgb(${lightR},${lightG},${lightB})`,
    1, `rgb(${darkR},${darkG},${darkB})`,
  ];
}

function computeBoundingBox(ring: Ring): { minX: number; minY: number; maxX: number; maxY: number } {
  if (ring.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = ring[0].x, maxX = ring[0].x;
  let minY = ring[0].y, maxY = ring[0].y;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

function centroidOfRing(ring: Ring): XY {
  if (ring.length === 0) {
    return { x: 0, y: 0 };
  }

  let sumX = 0;
  let sumY = 0;
  ring.forEach((p) => {
    sumX += p.x;
    sumY += p.y;
  });

  return { x: sumX / ring.length, y: sumY / ring.length };
}

function flattenRing(ring: Ring): number[] {
  return ring.flatMap((point) => [point.x, point.y]);
}

function flattenRings(rings: Ring[]): number[] {
  const outer = rings[0] ?? [];
  return flattenRing(outer);
}

/**
 * Compute the maximum half-extents (in plan units) of a marker's rendered
 * footprint — the larger of the background shape and the icon graphic.
 * Used to clamp space-relative markers so their outer edge stays inside
 * the room bounding box.
 *
 * Only returns non-zero extents if there is a visible background shape.
 * Icon extents are NOT included since icons are typically small relative
 * to room size and are meant to be positioned precisely by the user.
 */
function markerHalfExtents(
  item: MarkerLayerItem,
  scale: number,
): { hx: number; hy: number } {
  const shape = item.shape ?? 'circle';
  const r = (item.radius ?? 5) / scale;
  const w = (item.width ?? (item.radius ?? 5) * 2) / scale;
  const h = (item.height ?? (item.radius ?? 5) * 2) / scale;

  // Only clamp if there's a visible background shape
  const hasVisibleBackground = item.fill && item.fill !== 'transparent' && item.radius !== 0;
  if (!hasVisibleBackground) {
    return { hx: 0, hy: 0 };
  }

  const shapeHx = shape === 'circle' ? r : w / 2;
  const shapeHy = shape === 'circle' ? r : h / 2;

  return { hx: shapeHx, hy: shapeHy };
}

type WallFrame = {
  tx: number;
  ty: number;
  nx: number;
  ny: number;
  closestX: number;
  closestY: number;
  inwardNx: number;
  inwardNy: number;
};

function getPrimaryRing(space: SpaceEntity): Ring {
  if (space.geometry.type === 'Polygon') {
    return space.geometry.rings[0] ?? [];
  }
  return space.geometry.polygons[0]?.[0] ?? [];
}

function pointSegmentDistanceSquared(point: XY, a: XY, b: XY): { dist2: number; t: number } {
  const abx = b.x - a.x;
  const aby = b.y - a.y;
  const apx = point.x - a.x;
  const apy = point.y - a.y;
  const denom = abx * abx + aby * aby;

  if (denom <= 1e-9) {
    const dx = point.x - a.x;
    const dy = point.y - a.y;
    return { dist2: dx * dx + dy * dy, t: 0 };
  }

  const tRaw = (apx * abx + apy * aby) / denom;
  const t = Math.max(0, Math.min(1, tRaw));
  const cx = a.x + abx * t;
  const cy = a.y + aby * t;
  const dx = point.x - cx;
  const dy = point.y - cy;
  return { dist2: dx * dx + dy * dy, t };
}

function projectPointToSegment(a: XY, b: XY, t: number): XY {
  return {
    x: a.x + (b.x - a.x) * t,
    y: a.y + (b.y - a.y) * t,
  };
}

function findNearestWallFrame(point: XY, space?: SpaceEntity): WallFrame | null {
  if (!space) {
    return null;
  }

  const ring = getPrimaryRing(space);
  if (ring.length < 2) {
    return null;
  }

  let bestDist2 = Number.POSITIVE_INFINITY;
  let bestA: XY | null = null;
  let bestB: XY | null = null;

  for (let i = 0; i < ring.length - 1; i += 1) {
    const a = ring[i];
    const b = ring[i + 1];
    const result = pointSegmentDistanceSquared(point, a, b);
    if (result.dist2 < bestDist2) {
      bestDist2 = result.dist2;
      bestA = a;
      bestB = b;
    }
  }

  if (!bestA || !bestB) {
    return null;
  }

  const dx = bestB.x - bestA.x;
  const dy = bestB.y - bestA.y;
  const len = Math.hypot(dx, dy);
  if (len <= 1e-9) {
    return null;
  }

  const tx = dx / len;
  const ty = dy / len;
  // Normal (perpendicular) vector for offsetting the double-line window symbol.
  const nx = -ty;
  const ny = tx;

  const nearestResult = pointSegmentDistanceSquared(point, bestA, bestB);
  const closestPoint = projectPointToSegment(bestA, bestB, nearestResult.t);
  const centroid = centroidOfRing(ring);
  const toCentroidX = centroid.x - closestPoint.x;
  const toCentroidY = centroid.y - closestPoint.y;

  const oppositeNx = ty;
  const oppositeNy = -tx;
  const normalDot = toCentroidX * nx + toCentroidY * ny;
  const oppositeDot = toCentroidX * oppositeNx + toCentroidY * oppositeNy;
  const inwardNx = normalDot >= oppositeDot ? nx : oppositeNx;
  const inwardNy = normalDot >= oppositeDot ? ny : oppositeNy;

  return {
    tx,
    ty,
    nx,
    ny,
    closestX: closestPoint.x,
    closestY: closestPoint.y,
    inwardNx,
    inwardNy,
  };
}

function insetPointInsideSpace(point: XY, insetDistance: number, wallFrame: WallFrame | null): XY {
  if (!wallFrame || insetDistance <= 0) {
    return point;
  }

  const dx = point.x - wallFrame.closestX;
  const dy = point.y - wallFrame.closestY;
  const distanceInside = dx * wallFrame.inwardNx + dy * wallFrame.inwardNy;
  if (distanceInside >= insetDistance) {
    return point;
  }

  const requiredShift = insetDistance - distanceInside;
  return {
    x: point.x + wallFrame.inwardNx * requiredShift,
    y: point.y + wallFrame.inwardNy * requiredShift,
  };
}

function getAllPoints(model: CanonicalBuildingMapModel): XY[] {
  const spacePoints = model.spaces.flatMap((space) => {
    if (space.geometry.type === 'Polygon') {
      return space.geometry.rings.flat();
    }
    return space.geometry.polygons.flat(2);
  });
  const assetPoints = model.assets.map((asset) => asset.position);
  const annotationPoints = model.annotations
    .map((annotation) => annotation.position)
    .filter((position): position is XY => position !== undefined);

  return [...spacePoints, ...assetPoints, ...annotationPoints];
}

function makeTransform(model: CanonicalBuildingMapModel, width: number, height: number, padding: number) {
  const points = getAllPoints(model);

  if (points.length === 0) {
    return {
      scale: 1,
      offsetX: width / 2,
      offsetY: height / 2,
    };
  }

  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);

  const minX = Math.min(...xs);
  const maxX = Math.max(...xs);
  const minY = Math.min(...ys);
  const maxY = Math.max(...ys);

  const dataWidth = Math.max(1, maxX - minX);
  const dataHeight = Math.max(1, maxY - minY);

  const scale = Math.min((width - padding * 2) / dataWidth, (height - padding * 2) / dataHeight);

  return {
    scale,
    offsetX: padding - minX * scale + (width - padding * 2 - dataWidth * scale) / 2,
    offsetY: padding - minY * scale + (height - padding * 2 - dataHeight * scale) / 2,
  };
}

function findAnchorForAnnotation(annotation: AnnotationEntity, model: CanonicalBuildingMapModel): XY {
  if (annotation.position) {
    return annotation.position;
  }

  if (annotation.targetType === 'space' && annotation.targetId) {
    const space = model.spaces.find((item) => item.id === annotation.targetId);
    if (!space) {
      return { x: 0, y: 0 };
    }
    if (space.geometry.type === 'Polygon') {
      return centroidOfRing(space.geometry.rings[0] ?? []);
    }
    return centroidOfRing(space.geometry.polygons[0]?.[0] ?? []);
  }

  if (annotation.targetType === 'asset' && annotation.targetId) {
    const asset = model.assets.find((item) => item.id === annotation.targetId);
    if (asset) {
      return asset.position;
    }
  }

  return { x: 0, y: 0 };
}

type LayerStatus =
  | { status: 'loading' }
  | { status: 'loaded'; data: LayerData }
  | { status: 'error'; error: string };

function countLayerDataItems(data: LayerData) {
  return {
    spaces: data.spaces?.length ?? 0,
    markers: data.markers?.length ?? 0,
    annotations: data.annotations?.length ?? 0,
    custom: data.custom?.length ?? 0,
  };
}

export function BuildingMap({
  model,
  rdfStore,
  width,
  height,
  northDirectionDegrees = 0,
  padding = 24,
  minZoom = 0.1,
  maxZoom = 32,
  resetToken,
  selectedSpaceId,
  onViewportChange,
  onSpaceClick,
  onAssetClick,
  layers: layerDefinitions,
  visibleLayers,
  onLayerToggle,
  theme,
  themeOverrides,
  visualControls,
  controls,
  zoomToSelection = true,
  showControls = false,
}: BuildingMapProps) {
  const hasExternalLayers = Boolean(layerDefinitions?.length);
  const controlsEnabled = controls?.enabled ?? true;
  const showZoomToFitControl = controlsEnabled && (controls?.zoomToFit ?? showControls);
  const showFullScreenControl = controlsEnabled && (controls?.fullScreen ?? showControls);
  const showLayerPanelControl = controlsEnabled && hasExternalLayers && (controls?.layerPanel ?? Boolean(onLayerToggle));
  const showCompassControl = controlsEnabled && (controls?.compass ?? true);
  const activeRdfStore = useMemo(() => rdfStore ?? createRdfStore(), [rdfStore]);
  const graphStatementCount = activeRdfStore.statements.length;
  const [isExpanded, setIsExpanded] = useState(false);
  const [windowSize, setWindowSize] = useState({
    width: typeof window === 'undefined' ? width : window.innerWidth,
    height: typeof window === 'undefined' ? height : window.innerHeight,
  });
  const mapWidth = isExpanded ? windowSize.width : width;
  const mapHeight = isExpanded ? windowSize.height : height;
  const [hoveredSpaceId, setHoveredSpaceId] = useState<string | null>(null);
  const [hoveredAsset, setHoveredAsset] = useState<{ asset: AssetEntity; x: number; y: number } | null>(null);
  const [hoveredMarker, setHoveredMarker] = useState<{ text: string; x: number; y: number } | null>(null);
  const [isLayerPanelOpen, setIsLayerPanelOpen] = useState(false);
  const [hoveredControlTooltip, setHoveredControlTooltip] = useState<string | null>(null);
  const layerPanelCloseTimerRef = useRef<number | null>(null);
  const [layerStatuses, setLayerStatuses] = useState<Record<string, LayerStatus>>({});
  const viewportChangeRef = useRef(onViewportChange);
  const resolvedTheme = useMemo(
    () => resolveTheme(theme, themeOverrides),
    [theme, themeOverrides],
  );
  const [internalAnimationClockMs, setInternalAnimationClockMs] = useState(() => Date.now());
  const [iconImages, setIconImages] = useState<Record<string, HTMLImageElement>>({});

  const visualControlImageUrls = useMemo(
    () => collectVisualControlImageUrls(visualControls),
    [visualControls],
  );
  const visibleLoadedLayerData = useMemo(() => {
    if (!layerDefinitions || layerDefinitions.length === 0) {
      return [] as LayerData[];
    }

    const data: LayerData[] = [];
    for (const def of layerDefinitions) {
      const isVisible = visibleLayers?.[def.id] ?? (def.defaultVisible ?? false);
      if (!isVisible) {
        continue;
      }
      const status = layerStatuses[def.id];
      if (status?.status === 'loaded') {
        data.push(status.data);
      }
    }
    return data;
  }, [layerDefinitions, visibleLayers, layerStatuses]);
  const imageUrls = useMemo(
    () => Array.from(new Set([
      ...visualControlImageUrls,
      ...collectLayerImageUrls(visibleLoadedLayerData),
    ])),
    [visualControlImageUrls, visibleLoadedLayerData],
  );
  const hasInternalAnimation = useMemo(
    () => hasVelocityRotation(visualControls) && visualControls?.animationClockMs === undefined,
    [visualControls],
  );
  const renderClockMs = visualControls?.animationClockMs ?? internalAnimationClockMs;

  useEffect(() => {
    viewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

  useEffect(() => {
    if (!hasInternalAnimation) {
      return;
    }

    let frame = 0;
    const tick = () => {
      setInternalAnimationClockMs(Date.now());
      frame = window.requestAnimationFrame(tick);
    };
    frame = window.requestAnimationFrame(tick);
    return () => window.cancelAnimationFrame(frame);
  }, [hasInternalAnimation]);

  useEffect(() => {
    if (imageUrls.length === 0 || typeof window === 'undefined') {
      return;
    }

    let cancelled = false;
    const pending: HTMLImageElement[] = [];
    for (const url of imageUrls) {
      if (!url || iconImages[url]) {
        continue;
      }
      const image = new window.Image();
      pending.push(image);
      image.onload = () => {
        if (cancelled) {
          return;
        }
        setIconImages((prev) => (prev[url] ? prev : { ...prev, [url]: image }));
      };
      image.src = url;
    }

    return () => {
      cancelled = true;
      for (const image of pending) {
        image.onload = null;
      }
    };
  }, [iconImages, imageUrls]);

  // Invalidate layer cache when the RDF store or model changes.
  useEffect(() => {
    setLayerStatuses({});
  }, [graphStatementCount, model]);

  // Fetch data for visible external layers that have no cached result.
  useEffect(() => {
    if (!layerDefinitions || layerDefinitions.length === 0) return;
    const ctx: LayerDataContext = { model, rdfStore: activeRdfStore };
    const toFetch = layerDefinitions.filter((def) => {
      const isVisible = visibleLayers?.[def.id] ?? (def.defaultVisible ?? false);
      return isVisible && !layerStatuses[def.id];
    });
    if (toFetch.length === 0) return;
    setLayerStatuses((prev) => {
      const next = { ...prev };
      for (const def of toFetch) next[def.id] = { status: 'loading' };
      return next;
    });
    let cancelled = false;
    for (const def of toFetch) {
      const id = def.id;
      const doFetch = async () => {
        try {
          const data = def.getData
            ? await Promise.resolve(def.getData(ctx))
            : (def.data ?? {});
          if (cancelled) return;
          console.info('[layer-debug][BuildingMap][layer-load] loaded', {
            id,
            source: def.getData ? 'getData' : 'data',
            renderOrder: def.renderOrder ?? 'overlay',
            counts: countLayerDataItems(data),
          });
          setLayerStatuses((prev) => ({ ...prev, [id]: { status: 'loaded', data } }));
        } catch (err) {
          if (cancelled) return;
          const error = err instanceof Error ? err.message : 'Layer load failed';
          setLayerStatuses((prev) => ({ ...prev, [id]: { status: 'error', error } }));
        }
      };
      void doFetch();
    }
    return () => {
      cancelled = true;
    };
  }, [layerDefinitions, visibleLayers, graphStatementCount, model, activeRdfStore]);

  const { floorLayerData, wallsLayerData, overlayLayerData } = useMemo(() => {
    const floor: LayerData[] = [];
    const walls: LayerData[] = [];
    const overlay: LayerData[] = [];
    if (!layerDefinitions || layerDefinitions.length === 0) return { floorLayerData: floor, wallsLayerData: walls, overlayLayerData: overlay };
    for (const def of layerDefinitions) {
      const isVisible = visibleLayers?.[def.id] ?? (def.defaultVisible ?? false);
      if (!isVisible) continue;
      const s = layerStatuses[def.id];
      if (s?.status !== 'loaded') continue;
      const bucket = def.renderOrder === 'floor' ? floor : def.renderOrder === 'walls' ? walls : overlay;
      bucket.push(s.data);
    }
    return { floorLayerData: floor, wallsLayerData: walls, overlayLayerData: overlay };
  }, [layerDefinitions, visibleLayers, layerStatuses]);

  useEffect(() => {
    const summarize = (bucket: LayerData[]) => bucket.reduce(
      (acc, data) => {
        const counts = countLayerDataItems(data);
        return {
          spaces: acc.spaces + counts.spaces,
          markers: acc.markers + counts.markers,
          annotations: acc.annotations + counts.annotations,
          custom: acc.custom + counts.custom,
        };
      },
      { spaces: 0, markers: 0, annotations: 0, custom: 0 },
    );

    console.info('[layer-debug][BuildingMap][bucket-counts]', {
      floor: summarize(floorLayerData),
      walls: summarize(wallsLayerData),
      overlay: summarize(overlayLayerData),
      floorLayers: floorLayerData.length,
      wallsLayers: wallsLayerData.length,
      overlayLayers: overlayLayerData.length,
    });
  }, [floorLayerData, wallsLayerData, overlayLayerData]);

  useEffect(() => {
    if (!isExpanded) {
      return;
    }

    const handleResize = () => {
      setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('resize', handleResize);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('resize', handleResize);
    };
  }, [isExpanded]);

  const transform = useMemo(
    () => makeTransform(model, mapWidth, mapHeight, padding),
    [mapHeight, mapWidth, model, padding],
  );

  const [viewport, setViewport] = useState({
    x: transform.offsetX,
    y: transform.offsetY,
    scale: transform.scale,
  });

  useEffect(() => {
    const next = {
      x: transform.offsetX,
      y: transform.offsetY,
      scale: transform.scale,
    };
    setViewport(next);
    viewportChangeRef.current?.(next);
  }, [transform.offsetX, transform.offsetY, transform.scale, resetToken]);

  useEffect(() => {
    if (!zoomToSelection) {
      return;
    }

    if (!selectedSpaceId) {
      updateViewport({
        x: transform.offsetX,
        y: transform.offsetY,
        scale: transform.scale,
      });
      return;
    }

    const space = model.spaces.find((s) => s.id === selectedSpaceId);
    if (!space) {
      return;
    }

    const ring =
      space.geometry.type === 'Polygon'
        ? (space.geometry.rings[0] ?? [])
        : (space.geometry.polygons[0]?.[0] ?? []);
    if (ring.length === 0) {
      return;
    }

    const xs = ring.map((p) => p.x);
    const ys = ring.map((p) => p.y);
    const minX = Math.min(...xs);
    const maxX = Math.max(...xs);
    const minY = Math.min(...ys);
    const maxY = Math.max(...ys);
    const dataWidth = Math.max(1, maxX - minX);
    const dataHeight = Math.max(1, maxY - minY);
    const selectionPadding = padding * 3;
    const newScale = Math.min(
      (mapWidth - selectionPadding * 2) / dataWidth,
      (mapHeight - selectionPadding * 2) / dataHeight,
    );
    const newX = selectionPadding - minX * newScale + (mapWidth - selectionPadding * 2 - dataWidth * newScale) / 2;
    const newY = selectionPadding - minY * newScale + (mapHeight - selectionPadding * 2 - dataHeight * newScale) / 2;
    updateViewport({ x: newX, y: newY, scale: newScale });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedSpaceId, zoomToSelection]);

  function updateViewport(next: { x: number; y: number; scale: number }) {
    setViewport(next);
    viewportChangeRef.current?.(next);
  }

  function resetViewport() {
    updateViewport({
      x: transform.offsetX,
      y: transform.offsetY,
      scale: transform.scale,
    });
  }

  function handleWheel(event: { evt: WheelEvent }) {
    event.evt.preventDefault();

    const rect = (event.evt.currentTarget as HTMLCanvasElement).getBoundingClientRect();
    const pointer = {
      x: event.evt.clientX - rect.left,
      y: event.evt.clientY - rect.top,
    };

    const direction = event.evt.deltaY > 0 ? -1 : 1;
    const zoomFactor = direction > 0 ? 1.08 : 0.92;
    // Keep zoom bounds meaningful even when the fit scale starts above static limits.
    const minAllowedScale = Math.min(minZoom, transform.scale * 0.25);
    const maxAllowedScale = Math.max(maxZoom, transform.scale * 12);
    const nextScale = Math.min(maxAllowedScale, Math.max(minAllowedScale, viewport.scale * zoomFactor));
    const scaleRatio = nextScale / viewport.scale;

    const next = {
      scale: nextScale,
      x: pointer.x - (pointer.x - viewport.x) * scaleRatio,
      y: pointer.y - (pointer.y - viewport.y) * scaleRatio,
    };

    updateViewport(next);
  }

  const overflowScale = Math.max(1, viewport.scale / Math.max(transform.scale, 0.0001));
  const stageWidth = Math.max(mapWidth, Math.round(mapWidth * overflowScale));
  const stageHeight = Math.max(mapHeight, Math.round(mapHeight * overflowScale));

  const activeTooltip = hoveredMarker ?? (hoveredAsset ? {
    text: buildAssetTooltip(hoveredAsset.asset),
    x: hoveredAsset.x,
    y: hoveredAsset.y,
  } : null);
  const tooltipText = activeTooltip?.text ?? '';
  const tooltipLines = tooltipText ? tooltipText.split('\n') : [];
  const tooltipWidth = Math.max(
    120,
    ...tooltipLines.map((line) => Math.round(line.length * 6.5 + 12)),
  );
  const tooltipHeight = Math.max(24, tooltipLines.length * 14 + 10);
  const tooltipX = activeTooltip
    ? Math.min(Math.max(8, activeTooltip.x + 12), Math.max(8, stageWidth - tooltipWidth - 8))
    : 0;
  const tooltipY = activeTooltip
    ? Math.min(Math.max(8, activeTooltip.y + 12), Math.max(8, stageHeight - tooltipHeight - 8))
    : 0;

  const controlButtonStyle: React.CSSProperties = {
    width: 34,
    height: 34,
    border: '1px solid rgba(15,23,42,0.35)',
    borderRadius: 8,
    background: 'rgba(255, 255, 255, 0.9)',
    color: '#0f172a',
    display: 'grid',
    placeItems: 'center',
    padding: 0,
    cursor: 'pointer',
    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
  };

  const controlTooltipStyle: React.CSSProperties = {
    position: 'absolute',
    left: 42,
    top: 6,
    padding: '4px 7px',
    borderRadius: 6,
    fontSize: 11,
    lineHeight: 1.2,
    color: '#e2e8f0',
    background: 'rgba(15, 23, 42, 0.9)',
    border: '1px solid rgba(148, 163, 184, 0.35)',
    whiteSpace: 'nowrap',
    pointerEvents: 'none',
  };

  const clearLayerPanelCloseTimer = () => {
    if (layerPanelCloseTimerRef.current !== null) {
      window.clearTimeout(layerPanelCloseTimerRef.current);
      layerPanelCloseTimerRef.current = null;
    }
  };

  const openLayerPanel = () => {
    clearLayerPanelCloseTimer();
    setIsLayerPanelOpen(true);
  };

  const closeLayerPanelWithDelay = () => {
    clearLayerPanelCloseTimer();
    layerPanelCloseTimerRef.current = window.setTimeout(() => {
      setIsLayerPanelOpen(false);
      layerPanelCloseTimerRef.current = null;
    }, 140);
  };

  useEffect(() => {
    return () => {
      clearLayerPanelCloseTimer();
    };
  }, []);

  return (
    <div
      data-rdf-store-statements={graphStatementCount}
      style={{
        width: mapWidth,
        height: mapHeight,
        position: 'relative',
        overflow: 'auto',
        overscrollBehavior: 'contain',
        ...(isExpanded
          ? {
              position: 'fixed',
              inset: 0,
              zIndex: 70,
              background: '#ffffff',
            }
          : {}),
      }}
    >
      {showZoomToFitControl || showFullScreenControl || (onLayerToggle && showLayerPanelControl) ? (
        <div
          style={{
            position: 'absolute',
            left: 10,
            top: 10,
            zIndex: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
          }}
        >
          {showZoomToFitControl ? (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={resetViewport}
                style={controlButtonStyle}
                aria-label="Zoom to fit"
                title="Zoom to fit"
                onMouseEnter={() => setHoveredControlTooltip('Zoom to fit')}
                onMouseLeave={() => setHoveredControlTooltip(null)}
                onFocus={() => setHoveredControlTooltip('Zoom to fit')}
                onBlur={() => setHoveredControlTooltip(null)}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M3 9V3h6M15 3h6v6M21 15v6h-6M9 21H3v-6" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  <path d="M9 9l-3-3M15 9l3-3M9 15l-3 3M15 15l3 3" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {hoveredControlTooltip === 'Zoom to fit' ? <span style={controlTooltipStyle}>Zoom to fit</span> : null}
            </div>
          ) : null}

          {showFullScreenControl ? (
            <div style={{ position: 'relative' }}>
              <button
                type="button"
                onClick={() => setIsExpanded((value) => !value)}
                style={controlButtonStyle}
                aria-label={isExpanded ? 'Exit full screen' : 'Enter full screen'}
                title={isExpanded ? 'Exit full screen' : 'Enter full screen'}
                onMouseEnter={() => setHoveredControlTooltip(isExpanded ? 'Exit full screen' : 'Enter full screen')}
                onMouseLeave={() => setHoveredControlTooltip(null)}
                onFocus={() => setHoveredControlTooltip(isExpanded ? 'Exit full screen' : 'Enter full screen')}
                onBlur={() => setHoveredControlTooltip(null)}
              >
                {isExpanded ? (
                  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M9 9H4V4M15 9h5V4M9 15H4v5M15 15h5v5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                ) : (
                  <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                    <path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                  </svg>
                )}
              </button>
              {hoveredControlTooltip === (isExpanded ? 'Exit full screen' : 'Enter full screen') ? (
                <span style={controlTooltipStyle}>{isExpanded ? 'Exit full screen' : 'Enter full screen'}</span>
              ) : null}
            </div>
          ) : null}

          {onLayerToggle && showLayerPanelControl ? (
            <div
              style={{ position: 'relative' }}
              onMouseEnter={openLayerPanel}
              onMouseLeave={closeLayerPanelWithDelay}
            >
              <button
                type="button"
                style={controlButtonStyle}
                aria-label="Layer selection"
                title="Layer selection"
                onMouseEnter={() => {
                  setHoveredControlTooltip('Layer selection');
                  openLayerPanel();
                }}
                onMouseLeave={() => setHoveredControlTooltip(null)}
                onFocus={() => {
                  setHoveredControlTooltip('Layer selection');
                  openLayerPanel();
                }}
                onBlur={() => {
                  setHoveredControlTooltip(null);
                  closeLayerPanelWithDelay();
                }}
              >
                <svg width="18" height="18" viewBox="0 0 24 24" aria-hidden="true">
                  <path d="M12 4 3 8l9 4 9-4-9-4ZM3 12l9 4 9-4M3 16l9 4 9-4" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
              {hoveredControlTooltip === 'Layer selection' ? <span style={controlTooltipStyle}>Layer selection</span> : null}

              {isLayerPanelOpen ? (
                <div
                  style={{
                    position: 'absolute',
                    left: 36,
                    top: 0,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 4,
                    padding: '6px 8px',
                    borderRadius: 8,
                    border: '1px solid rgba(15, 23, 42, 0.18)',
                    background: 'rgba(255, 255, 255, 0.94)',
                    boxShadow: '0 2px 8px rgba(0, 0, 0, 0.10)',
                    userSelect: 'none',
                    minWidth: 160,
                  }}
                  role="group"
                  aria-label="Map layers"
                  onMouseEnter={openLayerPanel}
                  onMouseLeave={closeLayerPanelWithDelay}
                >
                  <div
                    style={{
                      position: 'absolute',
                      left: -8,
                      top: 0,
                      width: 8,
                      height: 34,
                    }}
                    aria-hidden="true"
                  />
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', color: '#64748b', textTransform: 'uppercase', marginBottom: 2 }}>Layers</span>
                  {((layerDefinitions ?? []).map((def) => ({
                    id: def.id,
                    label: def.label,
                    color: def.color ?? '#475569',
                    status: layerStatuses[def.id]?.status as string | undefined,
                  }))).map(({ id, label, color, status }) => {
                    const active = visibleLayers?.[id] ?? false;
                    return (
                      <button
                        key={id}
                        type="button"
                        onClick={() => onLayerToggle(id)}
                        style={{
                          display: 'flex',
                          alignItems: 'center',
                          gap: 6,
                          padding: '3px 6px',
                          borderRadius: 5,
                          border: `1px solid ${active ? color : 'rgba(15,23,42,0.15)'}`,
                          background: active ? `${color}18` : 'transparent',
                          cursor: 'pointer',
                          fontSize: 11,
                          fontWeight: active ? 600 : 400,
                          color: active ? color : '#94a3b8',
                          transition: 'all 0.12s ease',
                          whiteSpace: 'nowrap',
                        }}
                        aria-pressed={active}
                      >
                        <span
                          style={{
                            width: 8,
                            height: 8,
                            borderRadius: 2,
                            background: active ? color : 'rgba(15,23,42,0.15)',
                            flexShrink: 0,
                            transition: 'background 0.12s ease',
                          }}
                        />
                        {label}
                        {status === 'loading' ? ' ...' : status === 'error' ? ' !' : ''}
                      </button>
                    );
                  })}
                </div>
              ) : null}
            </div>
          ) : null}
        </div>
      ) : null}

      <Stage width={stageWidth} height={stageHeight} onWheel={handleWheel}>
        {resolvedTheme.canvasBackground ? (
          <Layer>
            <Rect
              x={0}
              y={0}
              width={stageWidth}
              height={stageHeight}
              fill={resolvedTheme.canvasBackground}
            />
          </Layer>
        ) : null}

        <Layer>
          <Group
            x={viewport.x}
            y={viewport.y}
            scaleX={viewport.scale}
            scaleY={viewport.scale}
            draggable
            onDragMove={(event) => {
              const next = {
                x: event.target.x(),
                y: event.target.y(),
                scale: viewport.scale,
              };
              updateViewport(next);
            }}
          >
            {resolvedTheme.floorBackground ? (
              <Rect
                x={-8}
                y={-8}
                width={1200}
                height={1200}
                fill={resolvedTheme.floorBackground}
                opacity={resolvedTheme.floorBackgroundOpacity}
              />
            ) : null}

            {/* renderOrder='floor': before space fills */}
            {floorLayerData.map((data, li) => [
              ...(data.spaces ?? []).flatMap((item) => {
                const space = model.spaces.find((s) => s.id === item.spaceId);
                if (!space) return [];
                const ringGroups = space.geometry.type === 'Polygon' ? [space.geometry.rings] : space.geometry.polygons;
                return ringGroups.map((rg, pi) => (
                  <Line key={`fl-sp-${li}-${item.spaceId}-${pi}`} points={flattenRings(rg)} closed
                    fill={item.fill ?? 'transparent'} opacity={item.fillOpacity ?? 0.5}
                    stroke={item.stroke} strokeWidth={item.strokeWidth != null ? item.strokeWidth / viewport.scale : 0}
                    strokeOpacity={item.strokeOpacity ?? 1} listening={false} />
                ));
              }),
              ...(data.markers ?? []).map((item) => {
                const { hx, hy } = markerHalfExtents(item, viewport.scale);
                const pt = clampMarkerToSpaceBbox(
                  resolveLayerPosition(item.position, model),
                  item.position, model, hx, hy,
                );
                const r = (item.radius ?? 5) / viewport.scale;
                const w = (item.width ?? (item.radius ?? 5) * 2) / viewport.scale;
                const h = (item.height ?? (item.radius ?? 5) * 2) / viewport.scale;
                const shape = item.shape ?? 'circle';
                return (
                  <Group key={`fl-mk-${li}-${item.id}`} onClick={() => item.onClick?.(item)}
                    onMouseEnter={(e) => { if (item.tooltip) { const p = e.target.getStage()?.getPointerPosition(); if (p) setHoveredMarker({ text: item.tooltip, x: p.x, y: p.y }); } }}
                    onMouseMove={(e) => { if (item.tooltip) { const p = e.target.getStage()?.getPointerPosition(); if (p) setHoveredMarker({ text: item.tooltip, x: p.x, y: p.y }); } }}
                    onMouseLeave={() => setHoveredMarker(null)}>
                    {shape === 'circle' ? (
                      <Circle x={pt.x} y={pt.y} radius={r}
                        fill={item.fill ?? '#0f172a'} stroke={item.stroke ?? '#38bdf8'} strokeWidth={1 / viewport.scale} />
                    ) : shape === 'rect' ? (
                      <Rect x={pt.x - w / 2} y={pt.y - h / 2} width={w} height={h}
                        rotation={item.rotation ?? 0} offsetX={0} offsetY={0}
                        fill={item.fill ?? '#0f172a'} stroke={item.stroke ?? '#38bdf8'} strokeWidth={1 / viewport.scale} />
                    ) : (
                      <Rect x={pt.x} y={pt.y} width={w} height={h}
                        rotation={(item.rotation ?? 0) + 45}
                        offsetX={w / 2} offsetY={h / 2}
                        fill={item.fill ?? '#0f172a'} stroke={item.stroke ?? '#38bdf8'} strokeWidth={1 / viewport.scale} />
                    )}
                    {renderIconAt(
                      normalizeLayerIconSpec(item.icon),
                      pt.x,
                      pt.y,
                      viewport.scale,
                      item.iconColor ?? '#f8fafc',
                      iconImages,
                    )}
                    {item.label ? (
                      <Text
                        x={pt.x}
                        y={pt.y + (r + 8) / viewport.scale}
                        text={item.label}
                        fontSize={9 / viewport.scale}
                        fill={item.labelColor ?? '#1f2937'}
                        align="center"
                        offsetX={(item.label.length * 2.5) / viewport.scale}
                        listening={false}
                      />
                    ) : null}
                  </Group>
                );
              }),
              ...(data.annotations ?? []).map((item) => {
                const pt = resolveLayerPosition(item.position, model);
                return (
                  <Text key={`fl-an-${li}-${item.id}`} x={pt.x} y={pt.y - 10 / viewport.scale}
                    text={item.text} fill={item.color ?? resolvedTheme.annotationColor}
                    fontSize={(item.fontSize ?? 10) / viewport.scale} listening={false} />
                );
              }),
              ...(data.custom ?? []).map((item) => {
                const pt = resolveLayerPosition(item.position, model);
                return (
                  <Group key={`fl-cu-${li}-${item.id}`}
                    onClick={() => item.onClick?.()}
                    onMouseEnter={(e) => { if (item.tooltip) { const p = e.target.getStage()?.getPointerPosition(); if (p) setHoveredMarker({ text: item.tooltip, x: p.x, y: p.y }); } }}
                    onMouseMove={(e) => { if (item.tooltip) { const p = e.target.getStage()?.getPointerPosition(); if (p) setHoveredMarker({ text: item.tooltip, x: p.x, y: p.y }); } }}
                    onMouseLeave={() => setHoveredMarker(null)}>
                    {item.render(pt, viewport.scale)}
                  </Group>
                );
              }),
            ])}

            {model.spaces.map((space) => {
              const isSelected = selectedSpaceId === space.id;
              const isHovered = hoveredSpaceId === space.id;
              const baseSpaceStyle = resolveSpaceStyle(resolvedTheme, space);
              const spaceStyle = resolveSpaceVisual(space, baseSpaceStyle, visualControls);
              const spaceTypeLabel = getIconText(spaceStyle.iconSpec) ?? formatBrickTypeLabel(space.brickClass) ?? spaceStyle.icon;

              const fill = isSelected
                ? spaceStyle.fillSelected
                : isHovered
                  ? spaceStyle.fillHover
                  : spaceStyle.fill;

              if (space.geometry.type === 'Polygon') {
                const centroid = centroidOfRing(space.geometry.rings[0] ?? []);
                const bbox = computeBoundingBox(space.geometry.rings[0] ?? []);
                const gradientStops = makeGradientStops(fill);
                return (
                  <Group key={space.id}>
                    <Line
                      points={flattenRings(space.geometry.rings)}
                      closed
                      fillLinearGradientStartPoint={{ x: bbox.minX, y: bbox.minY }}
                      fillLinearGradientEndPoint={{ x: bbox.maxX, y: bbox.maxY }}
                      fillLinearGradientColorStops={gradientStops}
                      stroke={spaceStyle.stroke}
                      strokeWidth={1 / viewport.scale}
                      shadowColor="rgba(0,0,0,0.22)"
                      shadowBlur={12 / viewport.scale}
                      shadowOffsetX={3 / viewport.scale}
                      shadowOffsetY={4 / viewport.scale}
                      shadowOpacity={1}
                      onMouseEnter={() => setHoveredSpaceId(space.id)}
                      onMouseLeave={() => setHoveredSpaceId(null)}
                      onClick={() => onSpaceClick?.(space)}
                    />
                    {spaceTypeLabel && !space.hasExplicitLabel && visualControls?.labelOptions?.showRoomTypeWhenNoLabel ? (
                      <Text
                        x={centroid.x}
                        y={centroid.y}
                        text={spaceTypeLabel}
                        fontSize={8 / viewport.scale}
                        fill={spaceStyle.iconColor ?? spaceStyle.labelColor}
                        offsetX={(spaceTypeLabel.length * 2.2) / viewport.scale}
                        offsetY={4 / viewport.scale}
                      />
                    ) : null}
                    {space.hasExplicitLabel ? (
                      <Text
                        x={centroid.x}
                        y={centroid.y}
                        text={space.label}
                        fontSize={12 / viewport.scale}
                        fill={spaceStyle.labelColor}
                        offsetX={(space.label.length * 3) / viewport.scale}
                        offsetY={6 / viewport.scale}
                      />
                    ) : null}
                  </Group>
                );
              }

              return space.geometry.polygons.map((polygon, polygonIndex) => {
                const polyRing = polygon[0] ?? [];
                const polyBbox = computeBoundingBox(polyRing);
                const polyGradientStops = makeGradientStops(fill);
                return (
                  <Line
                    key={`${space.id}-${polygonIndex}`}
                    points={flattenRings(polygon)}
                    closed
                    fillLinearGradientStartPoint={{ x: polyBbox.minX, y: polyBbox.minY }}
                    fillLinearGradientEndPoint={{ x: polyBbox.maxX, y: polyBbox.maxY }}
                    fillLinearGradientColorStops={polyGradientStops}
                    stroke={spaceStyle.stroke}
                    strokeWidth={1 / viewport.scale}
                    shadowColor="rgba(0,0,0,0.22)"
                    shadowBlur={12 / viewport.scale}
                    shadowOffsetX={3 / viewport.scale}
                    shadowOffsetY={4 / viewport.scale}
                    shadowOpacity={1}
                    onMouseEnter={() => setHoveredSpaceId(space.id)}
                    onMouseLeave={() => setHoveredSpaceId(null)}
                    onClick={() => onSpaceClick?.(space)}
                  />
                );
              });
            })}

            {/* renderOrder='walls': after spaces, before assets (no walls in 2D) */}
            {wallsLayerData.map((data, li) => [
              ...(data.spaces ?? []).flatMap((item) => {
                const space = model.spaces.find((s) => s.id === item.spaceId);
                if (!space) return [];
                const ringGroups = space.geometry.type === 'Polygon' ? [space.geometry.rings] : space.geometry.polygons;
                return ringGroups.map((rg, pi) => (
                  <Line key={`wl-sp-${li}-${item.spaceId}-${pi}`} points={flattenRings(rg)} closed
                    fill={item.fill ?? 'transparent'} opacity={item.fillOpacity ?? 0.5}
                    stroke={item.stroke} strokeWidth={item.strokeWidth != null ? item.strokeWidth / viewport.scale : 0}
                    strokeOpacity={item.strokeOpacity ?? 1} listening={false} />
                ));
              }),
              ...(data.markers ?? []).map((item) => {
                const { hx, hy } = markerHalfExtents(item, viewport.scale);
                const pt = clampMarkerToSpaceBbox(
                  resolveLayerPosition(item.position, model),
                  item.position, model, hx, hy,
                );
                const r = (item.radius ?? 5) / viewport.scale;
                const w = (item.width ?? (item.radius ?? 5) * 2) / viewport.scale;
                const h = (item.height ?? (item.radius ?? 5) * 2) / viewport.scale;
                const shape = item.shape ?? 'circle';
                const markerIndex = (data.markers ?? []).findIndex((m) => m.id === item.id);
                if (markerIndex >= 0 && markerIndex < 3) {
                  console.info('[layer-debug][BuildingMap][walls-markers] projected marker', {
                    layerIndex: li,
                    markerId: item.id,
                    projectedPoint: pt,
                  });
                }
                return (
                  <Group key={`wl-mk-${li}-${item.id}`} onClick={() => item.onClick?.(item)}
                    onMouseEnter={(e) => { if (item.tooltip) { const p = e.target.getStage()?.getPointerPosition(); if (p) setHoveredMarker({ text: item.tooltip, x: p.x, y: p.y }); } }}
                    onMouseMove={(e) => { if (item.tooltip) { const p = e.target.getStage()?.getPointerPosition(); if (p) setHoveredMarker({ text: item.tooltip, x: p.x, y: p.y }); } }}
                    onMouseLeave={() => setHoveredMarker(null)}>
                    {shape === 'circle' ? (
                      <Circle x={pt.x} y={pt.y} radius={r}
                        fill={item.fill ?? '#0f172a'} stroke={item.stroke ?? '#38bdf8'} strokeWidth={1 / viewport.scale} />
                    ) : shape === 'rect' ? (
                      <Rect x={pt.x - w / 2} y={pt.y - h / 2} width={w} height={h}
                        rotation={item.rotation ?? 0}
                        fill={item.fill ?? '#0f172a'} stroke={item.stroke ?? '#38bdf8'} strokeWidth={1 / viewport.scale} />
                    ) : (
                      <Rect x={pt.x} y={pt.y} width={w} height={h}
                        rotation={(item.rotation ?? 0) + 45}
                        offsetX={w / 2} offsetY={h / 2}
                        fill={item.fill ?? '#0f172a'} stroke={item.stroke ?? '#38bdf8'} strokeWidth={1 / viewport.scale} />
                    )}
                    {renderIconAt(
                      normalizeLayerIconSpec(item.icon),
                      pt.x,
                      pt.y,
                      viewport.scale,
                      item.iconColor ?? '#f8fafc',
                      iconImages,
                    )}
                    {item.label ? (
                      <Text
                        x={pt.x}
                        y={pt.y + (r + 8) / viewport.scale}
                        text={item.label}
                        fontSize={9 / viewport.scale}
                        fill={item.labelColor ?? '#1f2937'}
                        align="center"
                        offsetX={(item.label.length * 2.5) / viewport.scale}
                        listening={false}
                      />
                    ) : null}
                  </Group>
                );
              }),
              ...(data.annotations ?? []).map((item) => {
                const pt = resolveLayerPosition(item.position, model);
                return (
                  <Text key={`wl-an-${li}-${item.id}`} x={pt.x} y={pt.y - 10 / viewport.scale}
                    text={item.text} fill={item.color ?? resolvedTheme.annotationColor}
                    fontSize={(item.fontSize ?? 10) / viewport.scale} listening={false} />
                );
              }),
              ...(data.custom ?? []).map((item) => {
                const pt = resolveLayerPosition(item.position, model);
                return (
                  <Group key={`wl-cu-${li}-${item.id}`}
                    onClick={() => item.onClick?.()}
                    onMouseEnter={(e) => { if (item.tooltip) { const p = e.target.getStage()?.getPointerPosition(); if (p) setHoveredMarker({ text: item.tooltip, x: p.x, y: p.y }); } }}
                    onMouseMove={(e) => { if (item.tooltip) { const p = e.target.getStage()?.getPointerPosition(); if (p) setHoveredMarker({ text: item.tooltip, x: p.x, y: p.y }); } }}
                    onMouseLeave={() => setHoveredMarker(null)}>
                    {item.render(pt, viewport.scale)}
                  </Group>
                );
              }),
            ])}

            {model.assets.filter(isFloorPlanAsset).map((asset) => {
              const baseAssetStyle = resolveAssetStyle(resolvedTheme, asset);
              const assetStyle = resolveAssetVisual(asset, baseAssetStyle, visualControls, renderClockMs);
              const doorAsset = isDoorAsset(asset);
              const windowAsset = isWindowAsset(asset);
              const commercialDoorWidth = getNumericAssetMetadata(asset, 'openingWidthMeters') ?? 0.9;
              const commercialWindowWidth = getNumericAssetMetadata(asset, 'openingWidthMeters') ?? 1.8;
              const symbolSize = doorAsset ? commercialDoorWidth : 1.2;
              const windowHalfSpan = commercialWindowWidth / 2;
              const owningSpace = asset.spaceId
                ? model.spaces.find((space) => space.id === asset.spaceId)
                : undefined;
              const wallFrame = findNearestWallFrame(asset.position, owningSpace);
              const windowTx = wallFrame?.tx ?? 1;
              const windowTy = wallFrame?.ty ?? 0;
              const windowNx = wallFrame?.nx ?? 0;
              const windowNy = wallFrame?.ny ?? 1;
              const iconInsetDistance = assetStyle.radius / viewport.scale;
              const iconPosition = insetPointInsideSpace(asset.position, iconInsetDistance, wallFrame);

              const updateHoverFromEvent = (event: any) => {
                const pointer = event.target.getStage()?.getPointerPosition();
                if (!pointer) {
                  return;
                }
                setHoveredAsset({
                  asset,
                  x: pointer.x,
                  y: pointer.y,
                });
              };

              return (
                <Group
                  key={asset.id}
                  rotation={assetStyle.rotationDegrees}
                  x={asset.position.x}
                  y={asset.position.y}
                  onClick={() => onAssetClick?.(asset)}
                  onMouseEnter={updateHoverFromEvent}
                  onMouseMove={updateHoverFromEvent}
                  onMouseLeave={() => setHoveredAsset(null)}
                >
                  {doorAsset ? (
                    <>
                      <Line
                        points={[
                          0,
                          0,
                          0,
                          symbolSize,
                        ]}
                        stroke={assetStyle.fill}
                        strokeWidth={2.2 / viewport.scale}
                        lineCap="round"
                      />
                      <Line
                        points={[
                          0,
                          0,
                          symbolSize,
                          0,
                        ]}
                        stroke={assetStyle.fill}
                        strokeWidth={2 / viewport.scale}
                        lineCap="round"
                      />
                      <Arc
                        x={0}
                        y={0}
                        innerRadius={0}
                        outerRadius={symbolSize}
                        angle={90}
                        rotation={0}
                        stroke={assetStyle.stroke}
                        strokeWidth={1.4 / viewport.scale}
                        fillEnabled={false}
                      />
                    </>
                  ) : windowAsset ? (
                    <>
                      <Line
                        points={[
                          -windowTx * windowHalfSpan,
                          -windowTy * windowHalfSpan,
                          windowTx * windowHalfSpan,
                          windowTy * windowHalfSpan,
                        ]}
                        stroke={assetStyle.stroke}
                        strokeWidth={2.6 / viewport.scale}
                        lineCap="round"
                      />
                      <Line
                        points={[
                          -windowTx * windowHalfSpan - windowNx * (2.3 / viewport.scale),
                          -windowTy * windowHalfSpan - windowNy * (2.3 / viewport.scale),
                          windowTx * windowHalfSpan - windowNx * (2.3 / viewport.scale),
                          windowTy * windowHalfSpan - windowNy * (2.3 / viewport.scale),
                        ]}
                        stroke={assetStyle.fill}
                        strokeWidth={1.8 / viewport.scale}
                        lineCap="round"
                      />
                    </>
                  ) : (
                    <>
                      <Circle
                        x={iconPosition.x - asset.position.x}
                        y={iconPosition.y - asset.position.y}
                        radius={assetStyle.radius / viewport.scale}
                        fill={assetStyle.fill}
                        stroke={assetStyle.stroke}
                        strokeWidth={1 / viewport.scale}
                      />
                      {renderIconAt(
                        assetStyle.iconSpec,
                        iconPosition.x - asset.position.x,
                        iconPosition.y - asset.position.y,
                        viewport.scale,
                        assetStyle.iconColor ?? assetStyle.labelColor,
                        iconImages,
                      )}
                    </>
                  )}
                </Group>
              );
            })}

            {model.annotations.map((annotation) => {
              const anchor = findAnchorForAnnotation(annotation, model);
              return (
                <Text
                  key={annotation.id}
                  x={anchor.x}
                  y={anchor.y - 10 / viewport.scale}
                  text={annotation.label}
                  fill={annotation.color ?? resolvedTheme.annotationColor}
                  fontSize={10 / viewport.scale}
                />
              );
            })}

            {/* renderOrder='overlay': after all geometry, assets, annotations */}
            {overlayLayerData.map((data, li) => [
              ...(data.spaces ?? []).flatMap((item) => {
                const space = model.spaces.find((s) => s.id === item.spaceId);
                if (!space) return [];
                const ringGroups = space.geometry.type === 'Polygon' ? [space.geometry.rings] : space.geometry.polygons;
                return ringGroups.map((rg, pi) => (
                  <Line key={`ov-sp-${li}-${item.spaceId}-${pi}`} points={flattenRings(rg)} closed
                    fill={item.fill ?? 'transparent'} opacity={item.fillOpacity ?? 0.5}
                    stroke={item.stroke} strokeWidth={item.strokeWidth != null ? item.strokeWidth / viewport.scale : 0}
                    strokeOpacity={item.strokeOpacity ?? 1} listening={false} />
                ));
              }),
              ...(data.markers ?? []).map((item) => {
                const { hx, hy } = markerHalfExtents(item, viewport.scale);
                const pt = clampMarkerToSpaceBbox(
                  resolveLayerPosition(item.position, model),
                  item.position, model, hx, hy,
                );
                const r = (item.radius ?? 5) / viewport.scale;
                const w = (item.width ?? (item.radius ?? 5) * 2) / viewport.scale;
                const h = (item.height ?? (item.radius ?? 5) * 2) / viewport.scale;
                const shape = item.shape ?? 'circle';
                return (
                  <Group key={`ov-mk-${li}-${item.id}`} onClick={() => item.onClick?.(item)}
                    onMouseEnter={(e) => { if (item.tooltip) { const p = e.target.getStage()?.getPointerPosition(); if (p) setHoveredMarker({ text: item.tooltip, x: p.x, y: p.y }); } }}
                    onMouseMove={(e) => { if (item.tooltip) { const p = e.target.getStage()?.getPointerPosition(); if (p) setHoveredMarker({ text: item.tooltip, x: p.x, y: p.y }); } }}
                    onMouseLeave={() => setHoveredMarker(null)}>
                    {shape === 'circle' ? (
                      <Circle x={pt.x} y={pt.y} radius={r}
                        fill={item.fill ?? '#0f172a'} stroke={item.stroke ?? '#38bdf8'} strokeWidth={1 / viewport.scale} />
                    ) : shape === 'rect' ? (
                      <Rect x={pt.x - w / 2} y={pt.y - h / 2} width={w} height={h}
                        rotation={item.rotation ?? 0}
                        fill={item.fill ?? '#0f172a'} stroke={item.stroke ?? '#38bdf8'} strokeWidth={1 / viewport.scale} />
                    ) : (
                      <Rect x={pt.x} y={pt.y} width={w} height={h}
                        rotation={(item.rotation ?? 0) + 45}
                        offsetX={w / 2} offsetY={h / 2}
                        fill={item.fill ?? '#0f172a'} stroke={item.stroke ?? '#38bdf8'} strokeWidth={1 / viewport.scale} />
                    )}
                    {renderIconAt(
                      normalizeLayerIconSpec(item.icon),
                      pt.x,
                      pt.y,
                      viewport.scale,
                      item.iconColor ?? '#f8fafc',
                      iconImages,
                    )}
                    {item.label ? (
                      <Text
                        x={pt.x}
                        y={pt.y + (r + 8) / viewport.scale}
                        text={item.label}
                        fontSize={9 / viewport.scale}
                        fill={item.labelColor ?? '#1f2937'}
                        align="center"
                        offsetX={(item.label.length * 2.5) / viewport.scale}
                        listening={false}
                      />
                    ) : null}
                  </Group>
                );
              }),
              ...(data.annotations ?? []).map((item) => {
                const pt = resolveLayerPosition(item.position, model);
                return (
                  <Text key={`ov-an-${li}-${item.id}`} x={pt.x} y={pt.y - 10 / viewport.scale}
                    text={item.text} fill={item.color ?? resolvedTheme.annotationColor}
                    fontSize={(item.fontSize ?? 10) / viewport.scale} listening={false} />
                );
              }),
              ...(data.custom ?? []).map((item) => {
                const pt = resolveLayerPosition(item.position, model);
                return (
                  <Group key={`ov-cu-${li}-${item.id}`}
                    onClick={() => item.onClick?.()}
                    onMouseEnter={(e) => { if (item.tooltip) { const p = e.target.getStage()?.getPointerPosition(); if (p) setHoveredMarker({ text: item.tooltip, x: p.x, y: p.y }); } }}
                    onMouseMove={(e) => { if (item.tooltip) { const p = e.target.getStage()?.getPointerPosition(); if (p) setHoveredMarker({ text: item.tooltip, x: p.x, y: p.y }); } }}
                    onMouseLeave={() => setHoveredMarker(null)}>
                    {item.render(pt, viewport.scale)}
                  </Group>
                );
              }),
            ])}
          </Group>
        </Layer>
      </Stage>
      {activeTooltip ? (
        <Stage
          width={stageWidth}
          height={stageHeight}
          listening={false}
          style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}
        >
          <Layer listening={false}>
            <Rect
              x={tooltipX}
              y={tooltipY}
              width={tooltipWidth}
              height={tooltipHeight}
              cornerRadius={6}
              fill="#111827"
              opacity={0.92}
            />
            <Text
              x={tooltipX + 6}
              y={tooltipY + 5}
              width={tooltipWidth - 12}
              text={tooltipText}
              fontSize={11}
              lineHeight={1.2}
              fill="#f8fafc"
            />
          </Layer>
        </Stage>
      ) : null}

      {showCompassControl ? (
        <div
          style={{
            position: 'absolute',
            right: 10,
            top: 10,
            width: 44,
            height: 44,
            borderRadius: 999,
            border: '1px solid rgba(15, 23, 42, 0.35)',
            background: 'rgba(255, 255, 255, 0.82)',
            display: 'grid',
            placeItems: 'center',
            pointerEvents: 'none',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.12)',
            zIndex: 5,
          }}
          aria-hidden="true"
        >
          <svg width="34" height="34" viewBox="0 0 34 34" role="img" aria-label="North compass">
            <circle cx="17" cy="17" r="15" fill="none" stroke="rgba(15,23,42,0.25)" strokeWidth="1" />
            <g transform={`rotate(${northDirectionDegrees} 17 17)`}>
              <line x1="17" y1="24" x2="17" y2="9" stroke="#0f172a" strokeWidth="2" strokeLinecap="round" />
              <polygon points="17,6 13.5,11 20.5,11" fill="#0f172a" />
            </g>
            <text x="17" y="31" textAnchor="middle" fontSize="8" fill="#0f172a" fontWeight="700">N</text>
          </svg>
        </div>
      ) : null}

      {null}
    </div>
  );
}
