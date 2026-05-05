import { useEffect, useMemo, useRef, useState } from 'react';
import { Circle, Group, Layer, Line, Rect, Stage, Text } from 'react-konva';
import type { AssetEntity, LayerData, LayerDataContext, LayerPosition, XY } from './types';
import { createRdfStore } from './rdfStore';
import type { BuildingMapProps } from './BuildingMap';
import {
  formatBrickTypeLabel,
  resolveAssetStyle,
  resolveSpaceStyle,
  resolveTheme,
} from './themeUtils';
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
import {
  isDoorAsset,
  isFloorPlanAsset,
  isWindowAsset,
} from './assetClassifiers';
import {
  buildAssetTooltip,
  centroidOfRing,
  findAnchorForAnnotation,
  flattenRing,
  getPrimaryRing,
  makeGradientStops,
  resolveLayerPosition,
} from './geometryUtils';
import {
  buildExtrudedWallQuads,
  createOrthoProjectionContext,
  DEFAULT_ORTHO_DEPTH,
  DEFAULT_ORTHO_PERSPECTIVE_STRENGTH,
  projectPlanPointFromCenter,
  projectRingTopFace,
} from './orthoProjection';

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
  layers: layerDefinitions,
  visibleLayers,
  onLayerToggle,
  theme,
  themeOverrides,
  visualControls,
  controls,
  zoomToSelection = true,
  showControls = false,
}: OrthoBuildingProps) {
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
          console.info('[layer-debug][OrthoBuilding][layer-load] loaded', {
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

    console.info('[layer-debug][OrthoBuilding][bucket-counts]', {
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

  const projectLayerPosition = (position: LayerPosition): XY => {
    const resolved = resolveLayerPosition(position, model);
    const projected = projectPlanPointFromCenter(resolved, projectionContext);
    const z = typeof position.z === 'number' && Number.isFinite(position.z) ? position.z : 0;
    if (z === 0) {
      return projected;
    }

    const zFactor = z / Math.max(DEFAULT_ORTHO_DEPTH, 1e-6);
    return {
      x: projected.x + (projected.x - resolved.x) * zFactor,
      y: projected.y + (projected.y - resolved.y) * zFactor,
    };
  };

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

    const projectedRing = projectRingTopFace(ring, DEFAULT_ORTHO_DEPTH, undefined, projectionContext);
    const xs = projectedRing.map((p) => p.x);
    const ys = projectedRing.map((p) => p.y);
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

  const projectedSpaces = useMemo(() => {
    return model.spaces
      .map((space) => {
        const ring = getPrimaryRing(space);
        if (ring.length < 3) {
          return null;
        }

        const style = resolveSpaceStyle(resolvedTheme, space);
        const visualStyle = resolveSpaceVisual(space, style, visualControls);
        const isSelected = selectedSpaceId === space.id;
        const isHovered = hoveredSpaceId === space.id;
        const fill = isSelected ? visualStyle.fillSelected : isHovered ? visualStyle.fillHover : visualStyle.fill;
        const typeLabel = getIconText(visualStyle.iconSpec) ?? formatBrickTypeLabel(space.brickClass) ?? visualStyle.icon;

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
          visualStyle,
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
                  <span style={{ fontSize: 9, fontWeight: 700, letterSpacing: '0.05em', color: '#64748b', textTransform: 'uppercase', marginBottom: 2 }}>
                    Layers
                  </span>
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

            {/* Pass 1: floor fills — back to front */}
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

            {/* renderOrder='floor': on the floor surface, after fills, before wall geometry.
                Space overlays use plan-coordinate rings so walls extrude in front of them.
                Markers and annotations are projected to ortho coordinates. */}
            {floorLayerData.map((data, li) => [
              ...(data.spaces ?? []).flatMap((item) => {
                const space = model.spaces.find((s) => s.id === item.spaceId);
                if (!space) return [];
                const ring = getPrimaryRing(space);
                return [(
                  <Line key={`fl-sp-${li}-${item.spaceId}`} points={flattenRing(ring)} closed
                    fill={item.fill ?? 'transparent'} opacity={item.fillOpacity ?? 0.5}
                    stroke={item.stroke} strokeWidth={item.strokeWidth != null ? item.strokeWidth / viewport.scale : 0}
                    strokeOpacity={item.strokeOpacity ?? 1} listening={false} />
                )];
              }),
              ...(data.markers ?? []).map((item) => {
                const resolved = resolveLayerPosition(item.position, model);
                const pt = projectLayerPosition(item.position);
                const r = (item.radius ?? 5) / viewport.scale;
                const w = (item.width ?? (item.radius ?? 5) * 2) / viewport.scale;
                const h = (item.height ?? (item.radius ?? 5) * 2) / viewport.scale;
                const shape = item.shape ?? 'circle';
                const markerIndex = (data.markers ?? []).findIndex((m) => m.id === item.id);
                if (markerIndex >= 0 && markerIndex < 3) {
                  console.info('[layer-debug][OrthoBuilding][walls-markers] projected marker', {
                    layerIndex: li,
                    markerId: item.id,
                    resolvedPoint: resolved,
                    projectedPoint: pt,
                  });
                }
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
                  </Group>
                );
              }),
              ...(data.annotations ?? []).map((item) => {
                const pt = projectLayerPosition(item.position);
                return (
                  <Text key={`fl-an-${li}-${item.id}`} x={pt.x} y={pt.y - 10 / viewport.scale}
                    text={item.text} fill={item.color ?? resolvedTheme.annotationColor}
                    fontSize={(item.fontSize ?? 10) / viewport.scale} listening={false} />
                );
              }),
              ...(data.custom ?? []).map((item) => {
                const pt = projectLayerPosition(item.position);
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

            {/* Passes 2–5: wall faces, edge lines, wall caps */}
            {(() => {
              const wallStroke = '#4b5563';
              const wallCap = '#d8dde3';
              const wallCapThickness = 0.22;
              return (
                <>
                  {/* Pass 2: all wall faces */}
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

                  {/* Pass 5: top edge lines + wall caps */}
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
                </>
              );
            })()}

            {/* renderOrder='walls': after wall caps, before labels.
                Space overlays use the projected top-face ring so they sit on the wall-top plane.
                Suitable for wall-mounted indicators, zone boundaries, etc. */}
            {wallsLayerData.map((data, li) => [
              ...(data.spaces ?? []).flatMap((item) => {
                const entry = projectedSpaces.find((e) => e.space.id === item.spaceId);
                if (!entry) return [];
                return [(
                  <Line key={`wl-sp-${li}-${item.spaceId}`} points={flattenRing(entry.topRing)} closed
                    fill={item.fill ?? 'transparent'} opacity={item.fillOpacity ?? 0.5}
                    stroke={item.stroke} strokeWidth={item.strokeWidth != null ? item.strokeWidth / viewport.scale : 0}
                    strokeOpacity={item.strokeOpacity ?? 1} listening={false} />
                )];
              }),
              ...(data.markers ?? []).map((item) => {
                const pt = projectLayerPosition(item.position);
                const r = (item.radius ?? 5) / viewport.scale;
                const w = (item.width ?? (item.radius ?? 5) * 2) / viewport.scale;
                const h = (item.height ?? (item.radius ?? 5) * 2) / viewport.scale;
                const shape = item.shape ?? 'circle';
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
                  </Group>
                );
              }),
              ...(data.annotations ?? []).map((item) => {
                const pt = projectLayerPosition(item.position);
                return (
                  <Text key={`wl-an-${li}-${item.id}`} x={pt.x} y={pt.y - 10 / viewport.scale}
                    text={item.text} fill={item.color ?? resolvedTheme.annotationColor}
                    fontSize={(item.fontSize ?? 10) / viewport.scale} listening={false} />
                );
              }),
              ...(data.custom ?? []).map((item) => {
                const pt = projectLayerPosition(item.position);
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

            {/* Pass 6: labels */}
            {projectedSpaces.map((entry) => (
              <Group key={`label-${entry.space.id}`} listening={false}>
                {entry.typeLabel && !entry.space.hasExplicitLabel && visualControls?.labelOptions?.showRoomTypeWhenNoLabel ? (
                  <Text
                    x={entry.centroid.x}
                    y={entry.centroid.y}
                    text={entry.typeLabel}
                    fontSize={8 / viewport.scale}
                    fill={entry.visualStyle.iconColor ?? entry.visualStyle.labelColor}
                    offsetX={(entry.typeLabel.length * 2.2) / viewport.scale}
                    offsetY={4 / viewport.scale}
                  />
                ) : null}
                {entry.space.hasExplicitLabel ? (
                  <Text
                    x={entry.centroid.x}
                    y={entry.centroid.y}
                    text={entry.space.label}
                    fontSize={12 / viewport.scale}
                    fill={entry.visualStyle.labelColor}
                    offsetX={(entry.space.label.length * 3) / viewport.scale}
                    offsetY={6 / viewport.scale}
                  />
                ) : null}
              </Group>
            ))}

            {model.assets.filter(isFloorPlanAsset).map((asset) => {
              const baseAssetStyle = resolveAssetStyle(resolvedTheme, asset);
              const assetStyle = resolveAssetVisual(asset, baseAssetStyle, visualControls, renderClockMs);
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
                  x={iconPoint.x}
                  y={iconPoint.y}
                  rotation={assetStyle.rotationDegrees}
                  onClick={() => onAssetClick?.(asset)}
                  onMouseEnter={updateHoverFromEvent}
                  onMouseMove={updateHoverFromEvent}
                  onMouseLeave={() => setHoveredAsset(null)}
                >
                  {doorAsset || windowAsset ? (
                    <Line
                      points={[
                        -0.55,
                        0,
                        0.55,
                        0,
                      ]}
                      stroke={assetStyle.stroke}
                      strokeWidth={(doorAsset ? 2.5 : 2) / viewport.scale}
                      lineCap="round"
                    />
                  ) : (
                    <>
                      <Circle
                        x={0}
                        y={0}
                        radius={assetStyle.radius / viewport.scale}
                        fill={assetStyle.fill}
                        stroke={assetStyle.stroke}
                        strokeWidth={1 / viewport.scale}
                      />
                      {renderIconAt(
                        assetStyle.iconSpec,
                        0,
                        0,
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

            {/* renderOrder='overlay': after all geometry, labels, assets and annotations.
                Space overlays use the projected top-face ring. */}
            {overlayLayerData.map((data, li) => [
              ...(data.spaces ?? []).flatMap((item) => {
                const entry = projectedSpaces.find((e) => e.space.id === item.spaceId);
                if (!entry) return [];
                return [(
                  <Line key={`ov-sp-${li}-${item.spaceId}`} points={flattenRing(entry.topRing)} closed
                    fill={item.fill ?? 'transparent'} opacity={item.fillOpacity ?? 0.5}
                    stroke={item.stroke} strokeWidth={item.strokeWidth != null ? item.strokeWidth / viewport.scale : 0}
                    strokeOpacity={item.strokeOpacity ?? 1} listening={false} />
                )];
              }),
              ...(data.markers ?? []).map((item) => {
                const pt = projectLayerPosition(item.position);
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
                  </Group>
                );
              }),
              ...(data.annotations ?? []).map((item) => {
                const pt = projectLayerPosition(item.position);
                return (
                  <Text key={`ov-an-${li}-${item.id}`} x={pt.x} y={pt.y - 10 / viewport.scale}
                    text={item.text} fill={item.color ?? resolvedTheme.annotationColor}
                    fontSize={(item.fontSize ?? 10) / viewport.scale} listening={false} />
                );
              }),
              ...(data.custom ?? []).map((item) => {
                const pt = projectLayerPosition(item.position);
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
