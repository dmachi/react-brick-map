import { useEffect, useMemo, useRef, useState } from 'react';
import { Arc, Circle, Group, Layer, Line, Rect, Stage, Text } from 'react-konva';
import type {
  AnnotationEntity,
  AssetEntity,
  CanonicalBuildingMapModel,
  LayerVisibility,
  Ring,
  SpaceEntity,
  XY,
} from './types';
import { DEFAULT_LAYER_VISIBILITY } from './types';
import { createRdfStore, type RdfStore } from './rdfStore';

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

function isSensorAsset(asset: AssetEntity): boolean {
  const localClass = normalizeBrickKey(asset.brickClass);
  const typeKey = (asset.type ?? '').toLowerCase();
  // Thermostats go in the sensor layer by explicit design decision.
  if (localClass.includes('thermostat')) return true;
  return typeKey === 'sensor' || localClass.includes('sensor');
}

function isHvacAsset(asset: AssetEntity): boolean {
  return !isFloorPlanAsset(asset) && !isSensorAsset(asset);
}

function isPlenumSpace(space: SpaceEntity): boolean {
  return normalizeBrickKey(space.brickClass) === 'plenum';
}

function computePolygonArea(ring: Ring): number {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    area += ring[i].x * ring[i + 1].y - ring[i + 1].x * ring[i].y;
  }
  return Math.abs(area) / 2;
}

function computeSpaceMetrics(space: SpaceEntity): { area: number; width: number; height: number } {
  const ring = getPrimaryRing(space);
  if (ring.length < 3) {
    return { area: 0, width: 0, height: 0 };
  }
  const xs = ring.map((p) => p.x);
  const ys = ring.map((p) => p.y);
  return {
    area: computePolygonArea(ring),
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
}

function buildAssetTooltip(asset: AssetEntity): string {
  const lines: string[] = [asset.label];
  const typeLabel = formatBrickTypeLabel(asset.brickClass);
  if (typeLabel) {
    lines.push(typeLabel);
  }

  if (asset.metadata) {
    const detailEntries = Object.entries(asset.metadata)
      .filter(([, value]) => value !== null && value !== undefined)
      .slice(0, 4);

    for (const [key, value] of detailEntries) {
      lines.push(`${key}: ${String(value)}`);
    }
  }

  return lines.join('\n');
}

function getNumericAssetMetadata(asset: AssetEntity, key: string): number | undefined {
  const value = asset.metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
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
  visibleLayers?: Partial<LayerVisibility>;
  onLayerToggle?: (layer: keyof LayerVisibility) => void;
  // Typed partial overrides for TypeScript consumers.
  theme?: BuildingMapThemeOverrides;
  // Dictionary overrides for runtime-configurable theming sources.
  themeOverrides?: BuildingMapThemeDictionary;
  showControls?: boolean;
};

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

type WallFrame = {
  tx: number;
  ty: number;
  nx: number;
  ny: number;
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

  return { tx, ty, nx, ny };
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
  visibleLayers,
  onLayerToggle,
  theme,
  themeOverrides,
  showControls = false,
}: BuildingMapProps) {
  const layers: LayerVisibility = { ...DEFAULT_LAYER_VISIBILITY, ...visibleLayers };
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
  const viewportChangeRef = useRef(onViewportChange);
  const resolvedTheme = useMemo(
    () => resolveTheme(theme, themeOverrides),
    [theme, themeOverrides],
  );

  useEffect(() => {
    viewportChangeRef.current = onViewportChange;
  }, [onViewportChange]);

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

  const tooltipText = hoveredAsset ? buildAssetTooltip(hoveredAsset.asset) : '';
  const tooltipLines = tooltipText ? tooltipText.split('\n') : [];
  const tooltipWidth = Math.max(
    120,
    ...tooltipLines.map((line) => Math.round(line.length * 6.5 + 12)),
  );
  const tooltipHeight = Math.max(24, tooltipLines.length * 14 + 10);
  const tooltipX = hoveredAsset
    ? Math.min(Math.max(8, hoveredAsset.x + 12), Math.max(8, stageWidth - tooltipWidth - 8))
    : 0;
  const tooltipY = hoveredAsset
    ? Math.min(Math.max(8, hoveredAsset.y + 12), Math.max(8, stageHeight - tooltipHeight - 8))
    : 0;

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
      {showControls ? (
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
          <button
            type="button"
            onClick={resetViewport}
            style={{
              border: '1px solid rgba(15,23,42,0.35)',
              borderRadius: 8,
              background: 'rgba(255, 255, 255, 0.9)',
              color: '#0f172a',
              fontSize: 12,
              fontWeight: 600,
              padding: '6px 9px',
              cursor: 'pointer',
            }}
          >
            Zoom to Fit
          </button>

          <button
            type="button"
            onClick={() => setIsExpanded((value) => !value)}
            style={{
              border: '1px solid rgba(15,23,42,0.35)',
              borderRadius: 8,
              background: 'rgba(255, 255, 255, 0.9)',
              color: '#0f172a',
              fontSize: 12,
              fontWeight: 600,
              padding: '6px 9px',
              cursor: 'pointer',
            }}
          >
            {isExpanded ? 'Exit Full Screen' : 'Full Screen'}
          </button>
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

            {layers.floorPlan && model.spaces.filter(space => !isPlenumSpace(space)).map((space) => {
              const isSelected = selectedSpaceId === space.id;
              const isHovered = hoveredSpaceId === space.id;
              const spaceStyle = resolveSpaceStyle(resolvedTheme, space);
              const spaceTypeLabel = formatBrickTypeLabel(space.brickClass) ?? spaceStyle.icon;

              const fill = isSelected
                ? spaceStyle.fillSelected
                : isHovered
                  ? spaceStyle.fillHover
                  : spaceStyle.fill;

              if (space.geometry.type === 'Polygon') {
                const centroid = centroidOfRing(space.geometry.rings[0] ?? []);
                return (
                  <Group key={space.id}>
                    <Line
                      points={flattenRings(space.geometry.rings)}
                      closed
                      fill={fill}
                      stroke={spaceStyle.stroke}
                      strokeWidth={1 / viewport.scale}
                      onMouseEnter={() => setHoveredSpaceId(space.id)}
                      onMouseLeave={() => setHoveredSpaceId(null)}
                      onClick={() => onSpaceClick?.(space)}
                    />
                    {spaceTypeLabel ? (
                      <Text
                        x={centroid.x}
                        y={centroid.y - 9 / viewport.scale}
                        text={spaceTypeLabel}
                        fontSize={8 / viewport.scale}
                        fill={spaceStyle.iconColor ?? spaceStyle.labelColor}
                        offsetX={(spaceTypeLabel.length * 2.2) / viewport.scale}
                        offsetY={3 / viewport.scale}
                      />
                    ) : null}
                    <Text
                      x={centroid.x}
                      y={centroid.y}
                      text={space.label}
                      fontSize={12 / viewport.scale}
                      fill={spaceStyle.labelColor}
                      offsetX={(space.label.length * 3) / viewport.scale}
                      offsetY={6 / viewport.scale}
                    />
                  </Group>
                );
              }

              return space.geometry.polygons.map((polygon, polygonIndex) => (
                <Line
                  key={`${space.id}-${polygonIndex}`}
                  points={flattenRings(polygon)}
                  closed
                  fill={fill}
                  stroke={spaceStyle.stroke}
                  strokeWidth={1 / viewport.scale}
                  onMouseEnter={() => setHoveredSpaceId(space.id)}
                  onMouseLeave={() => setHoveredSpaceId(null)}
                  onClick={() => onSpaceClick?.(space)}
                />
              ));
            })}

            {layers.hvac && model.spaces.filter(isPlenumSpace).map((space) => {
              if (space.geometry.type !== 'Polygon') return null;
              const centroid = centroidOfRing(space.geometry.rings[0] ?? []);
              return (
                <Group key={`plenum-${space.id}`}>
                  <Line
                    points={flattenRings(space.geometry.rings)}
                    closed
                    fill="rgba(224, 242, 254, 0.22)"
                    stroke="#0ea5e9"
                    strokeWidth={2 / viewport.scale}
                    dash={[1.5 / viewport.scale, 0.8 / viewport.scale]}
                    onMouseEnter={() => setHoveredSpaceId(space.id)}
                    onMouseLeave={() => setHoveredSpaceId(null)}
                    onClick={() => onSpaceClick?.(space)}
                  />
                  <Text
                    x={centroid.x}
                    y={centroid.y}
                    text={space.label}
                    fontSize={14 / viewport.scale}
                    fill="#0ea5e9"
                    opacity={0.6}
                    offsetX={(space.label.length * 3.5) / viewport.scale}
                    offsetY={7 / viewport.scale}
                  />
                </Group>
              );
            })}

            {model.assets.filter((asset) => {
              if (isFloorPlanAsset(asset)) return layers.floorPlan;
              if (isSensorAsset(asset)) return layers.sensors;
              if (isHvacAsset(asset)) return layers.hvac;
              return layers.floorPlan;
            }).map((asset) => {
              const assetStyle = resolveAssetStyle(resolvedTheme, asset);
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
                  onClick={() => onAssetClick?.(asset)}
                  onMouseEnter={updateHoverFromEvent}
                  onMouseMove={updateHoverFromEvent}
                  onMouseLeave={() => setHoveredAsset(null)}
                >
                  {doorAsset ? (
                    <>
                      <Line
                        points={[
                          asset.position.x,
                          asset.position.y,
                          asset.position.x,
                          asset.position.y + symbolSize,
                        ]}
                        stroke={assetStyle.fill}
                        strokeWidth={2.2 / viewport.scale}
                        lineCap="round"
                      />
                      <Line
                        points={[
                          asset.position.x,
                          asset.position.y,
                          asset.position.x + symbolSize,
                          asset.position.y,
                        ]}
                        stroke={assetStyle.fill}
                        strokeWidth={2 / viewport.scale}
                        lineCap="round"
                      />
                      <Arc
                        x={asset.position.x}
                        y={asset.position.y}
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
                          asset.position.x - windowTx * windowHalfSpan,
                          asset.position.y - windowTy * windowHalfSpan,
                          asset.position.x + windowTx * windowHalfSpan,
                          asset.position.y + windowTy * windowHalfSpan,
                        ]}
                        stroke={assetStyle.stroke}
                        strokeWidth={2.6 / viewport.scale}
                        lineCap="round"
                      />
                      <Line
                        points={[
                          asset.position.x - windowTx * windowHalfSpan - windowNx * (2.3 / viewport.scale),
                          asset.position.y - windowTy * windowHalfSpan - windowNy * (2.3 / viewport.scale),
                          asset.position.x + windowTx * windowHalfSpan - windowNx * (2.3 / viewport.scale),
                          asset.position.y + windowTy * windowHalfSpan - windowNy * (2.3 / viewport.scale),
                        ]}
                        stroke={assetStyle.fill}
                        strokeWidth={1.8 / viewport.scale}
                        lineCap="round"
                      />
                    </>
                  ) : (
                    <>
                      <Circle
                        x={asset.position.x}
                        y={asset.position.y}
                        radius={assetStyle.radius / viewport.scale}
                        fill={assetStyle.fill}
                        stroke={assetStyle.stroke}
                        strokeWidth={1 / viewport.scale}
                      />
                      {assetStyle.icon ? (
                        <Text
                          x={asset.position.x}
                          y={asset.position.y}
                          text={assetStyle.icon}
                          fontSize={6 / viewport.scale}
                          fill={assetStyle.iconColor ?? assetStyle.labelColor}
                          offsetX={2 / viewport.scale}
                          offsetY={2 / viewport.scale}
                        />
                      ) : null}
                    </>
                  )}
                </Group>
              );
            })}

            {model.annotations.filter((annotation) => {
              if (annotation.targetType === 'asset') {
                const asset = model.assets.find((a) => a.id === annotation.targetId);
                if (asset) {
                  if (isFloorPlanAsset(asset)) return layers.floorPlan;
                  if (isSensorAsset(asset)) return layers.sensors;
                  if (isHvacAsset(asset)) return layers.hvac;
                }
              }
              if (annotation.targetType === 'space') return layers.floorPlan;
              return layers.floorPlan;
            }).map((annotation) => {
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

            {layers.roomMetrics && model.spaces.map((space) => {
              const { area, width, height: spaceHeight } = computeSpaceMetrics(space);
              if (area < 0.01) return null;
              const ring = getPrimaryRing(space);
              const centroid = centroidOfRing(ring);
              const areaStr = area.toFixed(1);
              const dimsStr = `${width.toFixed(1)} × ${spaceHeight.toFixed(1)}`;
              const volumeRaw = space.metadata?.volume;
              const volumeStr = typeof volumeRaw === 'number' ? `${volumeRaw.toFixed(1)} m\u00b3` : null;
              const fontSize = 9 / viewport.scale;
              const lineGap = 11 / viewport.scale;
              return (
                <Group key={`metrics-${space.id}`}>
                  <Text
                    x={centroid.x}
                    y={centroid.y + lineGap}
                    text={dimsStr}
                    fontSize={fontSize}
                    fill="#1e40af"
                    offsetX={(dimsStr.length * 2.6) / viewport.scale}
                    offsetY={fontSize / 2}
                  />
                  <Text
                    x={centroid.x}
                    y={centroid.y + lineGap * 2}
                    text={`${areaStr}\u00b2`}
                    fontSize={fontSize}
                    fill="#1e40af"
                    offsetX={(`${areaStr}\u00b2`.length * 2.6) / viewport.scale}
                    offsetY={fontSize / 2}
                  />
                  {volumeStr ? (
                    <Text
                      x={centroid.x}
                      y={centroid.y + lineGap * 3}
                      text={volumeStr}
                      fontSize={fontSize}
                      fill="#1e40af"
                      offsetX={(volumeStr.length * 2.6) / viewport.scale}
                      offsetY={fontSize / 2}
                    />
                  ) : null}
                </Group>
              );
            })}
          </Group>
        </Layer>
      </Stage>
      {hoveredAsset ? (
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

      {onLayerToggle ? (
        <div
          style={{
            position: 'absolute',
            left: 10,
            bottom: 10,
            display: 'flex',
            flexDirection: 'column',
            gap: 4,
            padding: '6px 8px',
            borderRadius: 8,
            border: '1px solid rgba(15, 23, 42, 0.18)',
            background: 'rgba(255, 255, 255, 0.88)',
            boxShadow: '0 2px 8px rgba(0, 0, 0, 0.10)',
            zIndex: 5,
            userSelect: 'none',
          }}
          role="group"
          aria-label="Map layers"
        >
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', color: '#64748b', textTransform: 'uppercase', marginBottom: 2 }}>Layers</span>
          {([
            { key: 'floorPlan', label: 'Floor Plan', color: '#1d1c1a' },
            { key: 'roomMetrics', label: 'Room Metrics', color: '#1e40af' },
            { key: 'sensors', label: 'Sensors', color: '#0b3b6f' },
            { key: 'hvac', label: 'HVAC', color: '#7c2d12' },
          ] as { key: keyof LayerVisibility; label: string; color: string }[]).map(({ key, label, color }) => {
            const active = layers[key];
            return (
              <button
                key={key}
                type="button"
                onClick={() => onLayerToggle(key)}
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
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}
