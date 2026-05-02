import { useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Group, Layer, Line, Rect, Stage, Text } from 'react-konva';
import type { AssetEntity, LayerVisibility, XY } from './types';
import { DEFAULT_LAYER_VISIBILITY } from './types';
import { createRdfStore } from './rdfStore';
import type { BuildingMapProps } from './BuildingMap';
import {
  formatBrickTypeLabel,
  resolveAssetStyle,
  resolveSpaceStyle,
  resolveTheme,
} from './themeUtils';
import {
  isDoorAsset,
  isFloorPlanAsset,
  isHvacAsset,
  isPlenumSpace,
  isSensorAsset,
  isWindowAsset,
} from './assetClassifiers';
import {
  buildAssetTooltip,
  centroidOfRing,
  computeSpaceMetrics,
  findAnchorForAnnotation,
  flattenRing,
  getPrimaryRing,
  makeGradientStops,
} from './geometryUtils';
import {
  buildExtrudedWallQuads,
  createOrthoProjectionContext,
  DEFAULT_ORTHO_DEPTH,
  DEFAULT_ORTHO_PERSPECTIVE_STRENGTH,
  projectPlanPointFromCenter,
  projectRingTopFace,
} from './orthoProjection';

export type OrthoBuildingProps = BuildingMapProps;

function makeTransformForPoints(points: XY[], width: number, height: number, padding: number) {
  if (points.length === 0) {
    return {
      scale: 1,
      offsetX: width / 2,
      offsetY: height / 2,
    };
  }

  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);

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

function flattenQuad(quad: XY[]): number[] {
  return quad.flatMap((point) => [point.x, point.y]);
}

function buildWallCapQuad(topA: XY, topB: XY, centroid: XY, thickness: number): XY[] {
  const edgeX = topB.x - topA.x;
  const edgeY = topB.y - topA.y;
  const edgeLen = Math.hypot(edgeX, edgeY);
  if (edgeLen <= 1e-9) {
    return [topA, topB, topB, topA];
  }

  const normalA = { x: edgeY / edgeLen, y: -edgeX / edgeLen };
  const normalB = { x: -normalA.x, y: -normalA.y };
  const mid = { x: (topA.x + topB.x) / 2, y: (topA.y + topB.y) / 2 };
  const toCenter = { x: centroid.x - mid.x, y: centroid.y - mid.y };
  const inward = normalA.x * toCenter.x + normalA.y * toCenter.y >= 0 ? normalA : normalB;
  const inwardX = inward.x * thickness;
  const inwardY = inward.y * thickness;

  return [
    topA,
    topB,
    { x: topB.x + inwardX, y: topB.y + inwardY },
    { x: topA.x + inwardX, y: topA.y + inwardY },
  ];
}

function shadeHex(hex: string, amount: number): string {
  const match = hex.match(/^#([0-9a-f]{6})$/i);
  if (!match) {
    return hex;
  }
  const value = match[1];
  const r = Math.min(255, Math.max(0, parseInt(value.slice(0, 2), 16) + amount));
  const g = Math.min(255, Math.max(0, parseInt(value.slice(2, 4), 16) + amount));
  const b = Math.min(255, Math.max(0, parseInt(value.slice(4, 6), 16) + amount));
  return `rgb(${r},${g},${b})`;
}

export function OrthoBuilding({
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
}: OrthoBuildingProps) {
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

  const projectionContext = useMemo(() => {
    const points = model.spaces.flatMap((space) => {
      if (space.geometry.type === 'Polygon') {
        return space.geometry.rings.flat();
      }
      return space.geometry.polygons.flat(2);
    });
    return createOrthoProjectionContext(
      points,
      DEFAULT_ORTHO_DEPTH,
      DEFAULT_ORTHO_PERSPECTIVE_STRENGTH,
    );
  }, [model.spaces]);

  const projectedFitPoints = useMemo(() => {
    const fitPoints: XY[] = [];

    for (const space of model.spaces) {
      if (space.geometry.type === 'Polygon') {
        for (const ring of space.geometry.rings) {
          fitPoints.push(...ring);
          fitPoints.push(...projectRingTopFace(ring, DEFAULT_ORTHO_DEPTH, undefined, projectionContext));
        }
        continue;
      }

      for (const polygon of space.geometry.polygons) {
        for (const ring of polygon) {
          fitPoints.push(...ring);
          fitPoints.push(...projectRingTopFace(ring, DEFAULT_ORTHO_DEPTH, undefined, projectionContext));
        }
      }
    }

    for (const asset of model.assets) {
      fitPoints.push(projectPlanPointFromCenter(asset.position, projectionContext));
    }

    for (const annotation of model.annotations) {
      fitPoints.push(projectPlanPointFromCenter(findAnchorForAnnotation(annotation, model), projectionContext));
    }

    return fitPoints;
  }, [model, projectionContext]);

  const transform = useMemo(
    () => makeTransformForPoints(projectedFitPoints, mapWidth, mapHeight, padding),
    [mapHeight, mapWidth, padding, projectedFitPoints],
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
    // Keep parity with BuildingMap behavior: recenter/fit whenever transform or resetToken changes.
    // eslint-disable-next-line react-hooks/set-state-in-effect
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

  const projectedSpaces = useMemo(() => {
    return model.spaces
      .filter((space) => !isPlenumSpace(space))
      .map((space) => {
        const ring = getPrimaryRing(space);
        if (ring.length < 3) {
          return null;
        }

        const style = resolveSpaceStyle(resolvedTheme, space);
        const isSelected = selectedSpaceId === space.id;
        const isHovered = hoveredSpaceId === space.id;
        const fill = isSelected ? style.fillSelected : isHovered ? style.fillHover : style.fill;
        const typeLabel = formatBrickTypeLabel(space.brickClass) ?? style.icon;

        const topRing = projectRingTopFace(ring, DEFAULT_ORTHO_DEPTH, undefined, projectionContext);
        const walls = buildExtrudedWallQuads(ring, DEFAULT_ORTHO_DEPTH, undefined, projectionContext);
        const centroid = centroidOfRing(ring);
        const projectedXs = topRing.map((point) => point.x);
        const projectedYs = topRing.map((point) => point.y);
        const bbox = {
          minX: Math.min(...projectedXs),
          minY: Math.min(...projectedYs),
          maxX: Math.max(...projectedXs),
          maxY: Math.max(...projectedYs),
        };
        const depthScore = Math.hypot(
          centroid.x - projectionContext.center.x,
          centroid.y - projectionContext.center.y,
        );
        const radialNorm = Math.min(1, depthScore / Math.max(projectionContext.maxRadius, 1e-6));
        const interiorWallOpacity = isSelected
          ? 0.62 + radialNorm * 0.2
          : 0.22 + radialNorm * 0.52;
        const wallFaceFill = isSelected ? '#9fa8b3' : '#8f98a3';
        const floorFill = shadeHex(fill, 12);

        return {
          space,
          ring,
          style,
          fill,
          typeLabel,
          isSelected,
          topRing,
          walls,
          centroid,
          bbox,
          depthScore,
          radialNorm,
          interiorWallOpacity,
          wallFaceFill,
          floorFill,
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .sort((left, right) => left.depthScore - right.depthScore);
  }, [hoveredSpaceId, model.spaces, projectionContext, resolvedTheme, selectedSpaceId]);

  const projectedPlenumSpaces = useMemo(() => {
    return model.spaces
      .filter(isPlenumSpace)
      .map((space) => {
        const ring = getPrimaryRing(space);
        if (ring.length < 3) {
          return null;
        }

        const topRing = projectRingTopFace(ring, DEFAULT_ORTHO_DEPTH, undefined, projectionContext);
        const walls = buildExtrudedWallQuads(ring, DEFAULT_ORTHO_DEPTH, undefined, projectionContext);
        const centroid = centroidOfRing(ring);
        const depthScore = Math.hypot(
          centroid.x - projectionContext.center.x,
          centroid.y - projectionContext.center.y,
        );

        return {
          space,
          ring,
          topRing,
          walls,
          centroid,
          depthScore,
        };
      })
      .filter((value): value is NonNullable<typeof value> => value !== null)
      .sort((left, right) => left.depthScore - right.depthScore);
  }, [model.spaces, projectionContext]);

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

            {layers.floorPlan && (() => {
              const wallStroke = '#4b5563';
              const wallCap = '#d8dde3';
              const wallCapThickness = 0.22;
              return (
                <>
                  {/* Pass 1: all floor fills — back to front */}
                  {projectedSpaces.map((entry) => (
                    <Line
                      key={`floor-${entry.space.id}`}
                      points={flattenRing(entry.ring)}
                      closed
                      fillLinearGradientStartPoint={{ x: entry.bbox.minX, y: entry.bbox.minY }}
                      fillLinearGradientEndPoint={{ x: entry.bbox.maxX, y: entry.bbox.maxY }}
                      fillLinearGradientColorStops={makeGradientStops(entry.floorFill)}
                      stroke={entry.style.stroke}
                      strokeWidth={1 / viewport.scale}
                      shadowColor="rgba(0,0,0,0.16)"
                      shadowBlur={8 / viewport.scale}
                      shadowOffsetX={2 / viewport.scale}
                      shadowOffsetY={2 / viewport.scale}
                      shadowOpacity={1}
                      onMouseEnter={() => setHoveredSpaceId(entry.space.id)}
                      onMouseLeave={() => setHoveredSpaceId(null)}
                      onClick={() => onSpaceClick?.(entry.space)}
                    />
                  ))}

                  {/* Pass 2: all wall faces — back to front, within each space walls are already depth-sorted */}
                  {projectedSpaces.map((entry) =>
                    entry.walls.map((wall) => (
                      <Line
                        key={`wall-face-${entry.space.id}-${wall.id}`}
                        points={flattenQuad([wall.a, wall.b, wall.topB, wall.topA])}
                        closed
                        fill={entry.wallFaceFill}
                        stroke={wallStroke}
                        strokeWidth={0.75 / viewport.scale}
                        opacity={wall.visible ? entry.interiorWallOpacity : Math.max(0.14, entry.interiorWallOpacity * 0.42)}
                        onMouseEnter={() => setHoveredSpaceId(entry.space.id)}
                        onMouseLeave={() => setHoveredSpaceId(null)}
                        onClick={() => onSpaceClick?.(entry.space)}
                      />
                    ))
                  )}

                  {/* Pass 3: base edge lines */}
                  {projectedSpaces.map((entry) =>
                    entry.walls.map((wall) => (
                      <Line
                        key={`wall-base-${entry.space.id}-${wall.id}`}
                        points={flattenQuad([wall.a, wall.b])}
                        stroke={wallStroke}
                        strokeWidth={1 / viewport.scale}
                        lineCap="round"
                        opacity={wall.visible ? 0.95 : 0.38}
                        listening={false}
                      />
                    ))
                  )}

                  {/* Pass 4: vertical edge lines */}
                  {projectedSpaces.map((entry) =>
                    entry.walls.map((wall) => (
                      <Group
                        key={`wall-vert-${entry.space.id}-${wall.id}`}
                        listening={false}
                        opacity={wall.visible ? 0.92 : 0.34}
                      >
                        <Line
                          points={flattenQuad([wall.a, wall.topA])}
                          stroke={wallStroke}
                          strokeWidth={0.7 / viewport.scale}
                          lineCap="round"
                        />
                        <Line
                          points={flattenQuad([wall.b, wall.topB])}
                          stroke={wallStroke}
                          strokeWidth={0.7 / viewport.scale}
                          lineCap="round"
                        />
                      </Group>
                    ))
                  )}

                  {/* Pass 5: top edge lines + wall caps — drawn last so they always appear above all floor fills */}
                  {projectedSpaces.map((entry) =>
                    entry.walls.map((wall) => (
                      <Group key={`wall-top-cap-${entry.space.id}-${wall.id}`} listening={false}>
                        <Line
                          points={flattenQuad([wall.topA, wall.topB])}
                          stroke={wallStroke}
                          strokeWidth={0.9 / viewport.scale}
                          lineCap="round"
                          opacity={wall.visible ? 0.95 : 0.42}
                        />
                        <Line
                          points={flattenQuad(buildWallCapQuad(wall.topA, wall.topB, entry.centroid, wallCapThickness))}
                          closed
                          fill={wallCap}
                          stroke={wallStroke}
                          strokeWidth={0.6 / viewport.scale}
                          opacity={wall.visible ? 0.9 : 0.32}
                        />
                      </Group>
                    ))
                  )}

                  {/* Pass 6: labels */}
                  {projectedSpaces.map((entry) => (
                    <Group key={`label-${entry.space.id}`} listening={false}>
                      {entry.typeLabel ? (
                        <Text
                          x={entry.centroid.x}
                          y={entry.centroid.y - 9 / viewport.scale}
                          text={entry.typeLabel}
                          fontSize={8 / viewport.scale}
                          fill={entry.style.iconColor ?? entry.style.labelColor}
                          offsetX={(entry.typeLabel.length * 2.2) / viewport.scale}
                          offsetY={3 / viewport.scale}
                        />
                      ) : null}
                      <Text
                        x={entry.centroid.x}
                        y={entry.centroid.y}
                        text={entry.space.label}
                        fontSize={12 / viewport.scale}
                        fill={entry.style.labelColor}
                        offsetX={(entry.space.label.length * 3) / viewport.scale}
                        offsetY={6 / viewport.scale}
                      />
                    </Group>
                  ))}
                </>
              );
            })()}

            {layers.hvac && projectedPlenumSpaces.map((entry) => (
              <Group key={`plenum-${entry.space.id}`}>
                {entry.walls.map((wall) => (
                  <Line
                    key={`plenum-wall-${entry.space.id}-${wall.id}`}
                    points={flattenQuad([wall.a, wall.b, wall.topB, wall.topA])}
                    closed
                    fill="#7dd3fc"
                    opacity={wall.visible ? 0.28 : 0.16}
                    stroke="#0284c7"
                    strokeWidth={1.2 / viewport.scale}
                  />
                ))}
                {entry.walls.map((wall) => (
                  <Line
                    key={`plenum-wall-base-${entry.space.id}-${wall.id}`}
                    points={flattenQuad([wall.a, wall.b])}
                    stroke="#0369a1"
                    strokeWidth={0.9 / viewport.scale}
                    lineCap="round"
                    opacity={wall.visible ? 0.9 : 0.4}
                    listening={false}
                  />
                ))}
                <Line
                  points={flattenRing(entry.ring)}
                  closed
                  fill="#e0f2fe"
                  stroke="#0284c7"
                  strokeWidth={2 / viewport.scale}
                  dash={[1.5 / viewport.scale, 0.8 / viewport.scale]}
                  onMouseEnter={() => setHoveredSpaceId(entry.space.id)}
                  onMouseLeave={() => setHoveredSpaceId(null)}
                  onClick={() => onSpaceClick?.(entry.space)}
                />
                {entry.walls.map((wall) => (
                  <Group
                    key={`plenum-wall-vertical-${entry.space.id}-${wall.id}`}
                    listening={false}
                    opacity={wall.visible ? 0.9 : 0.4}
                  >
                    <Line
                      points={flattenQuad([wall.a, wall.topA])}
                      stroke="#0369a1"
                      strokeWidth={0.65 / viewport.scale}
                      lineCap="round"
                    />
                    <Line
                      points={flattenQuad([wall.b, wall.topB])}
                      stroke="#0369a1"
                      strokeWidth={0.65 / viewport.scale}
                      lineCap="round"
                    />
                  </Group>
                ))}
                {entry.walls.map((wall) => (
                  <Line
                    key={`plenum-wall-top-${entry.space.id}-${wall.id}`}
                    points={flattenQuad([wall.topA, wall.topB])}
                    stroke="#0369a1"
                    strokeWidth={0.85 / viewport.scale}
                    lineCap="round"
                    opacity={wall.visible ? 0.9 : 0.45}
                    listening={false}
                  />
                ))}
                {entry.walls.map((wall) => (
                  <Line
                    key={`plenum-wall-cap-${entry.space.id}-${wall.id}`}
                    points={flattenQuad(buildWallCapQuad(wall.topA, wall.topB, entry.centroid, 0.18))}
                    closed
                    fill="#bae6fd"
                    stroke="#0284c7"
                    strokeWidth={0.55 / viewport.scale}
                    opacity={wall.visible ? 0.9 : 0.42}
                    listening={false}
                  />
                ))}
                <Text
                  x={entry.centroid.x}
                  y={entry.centroid.y}
                  text={entry.space.label}
                  fontSize={14 / viewport.scale}
                  fill="#0ea5e9"
                  opacity={0.6}
                  offsetX={(entry.space.label.length * 3.5) / viewport.scale}
                  offsetY={7 / viewport.scale}
                />
              </Group>
            ))}

            {model.assets.filter((asset) => {
              if (isFloorPlanAsset(asset)) return layers.floorPlan;
              if (isSensorAsset(asset)) return layers.sensors;
              if (isHvacAsset(asset)) return layers.hvac;
              return layers.floorPlan;
            }).map((asset) => {
              const assetStyle = resolveAssetStyle(resolvedTheme, asset);
              const iconPoint = projectPlanPointFromCenter(asset.position, projectionContext);
              const doorAsset = isDoorAsset(asset);
              const windowAsset = isWindowAsset(asset);

              const updateHoverFromEvent = (event: {
                target: { getStage: () => { getPointerPosition: () => XY | null } | null };
              }) => {
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
                  {doorAsset || windowAsset ? (
                    <Line
                      points={[
                        iconPoint.x - 0.55,
                        iconPoint.y,
                        iconPoint.x + 0.55,
                        iconPoint.y,
                      ]}
                      stroke={assetStyle.stroke}
                      strokeWidth={(doorAsset ? 2.5 : 2) / viewport.scale}
                      lineCap="round"
                    />
                  ) : (
                    <>
                      <Circle
                        x={iconPoint.x}
                        y={iconPoint.y}
                        radius={assetStyle.radius / viewport.scale}
                        fill={assetStyle.fill}
                        stroke={assetStyle.stroke}
                        strokeWidth={1 / viewport.scale}
                      />
                      {assetStyle.icon ? (
                        <Text
                          x={iconPoint.x}
                          y={iconPoint.y}
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
              const orthoAnchor = projectPlanPointFromCenter(anchor, projectionContext);
              return (
                <Text
                  key={annotation.id}
                  x={orthoAnchor.x}
                  y={orthoAnchor.y - 10 / viewport.scale}
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
              const centroid = projectPlanPointFromCenter(centroidOfRing(ring), projectionContext);
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
          <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', color: '#64748b', textTransform: 'uppercase', marginBottom: 2 }}>
            Layers
          </span>
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
