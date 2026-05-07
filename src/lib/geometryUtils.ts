import type {
  AnnotationEntity,
  AssetEntity,
  CanonicalBuildingMapModel,
  LayerPosition,
  Ring,
  SpaceLabelPosition,
  SpaceEntity,
  XY,
} from './types';
import { formatBrickTypeLabel } from './themeUtils';

export function computePolygonArea(ring: Ring): number {
  let area = 0;
  for (let i = 0; i < ring.length - 1; i++) {
    area += ring[i].x * ring[i + 1].y - ring[i + 1].x * ring[i].y;
  }
  return Math.abs(area) / 2;
}

export function computeSpaceMetrics(space: SpaceEntity): { area: number; width: number; height: number } {
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

export function getNumericAssetMetadata(asset: AssetEntity, key: string): number | undefined {
  const value = asset.metadata?.[key];
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function buildAssetTooltip(asset: AssetEntity): string {
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

export function makeGradientStops(fill: string): (number | string)[] {
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

export function computeBoundingBox(ring: Ring): { minX: number; minY: number; maxX: number; maxY: number } {
  if (ring.length === 0) return { minX: 0, minY: 0, maxX: 0, maxY: 0 };
  let minX = ring[0].x;
  let maxX = ring[0].x;
  let minY = ring[0].y;
  let maxY = ring[0].y;
  for (const p of ring) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  return { minX, minY, maxX, maxY };
}

export function centroidOfRing(ring: Ring): XY {
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

export function flattenRing(ring: Ring): number[] {
  return ring.flatMap((point) => [point.x, point.y]);
}

export function flattenRings(rings: Ring[]): number[] {
  const outer = rings[0] ?? [];
  return flattenRing(outer);
}

export function resolveSpaceLabelLayout(
  bbox: { minX: number; minY: number; maxX: number; maxY: number },
  fontSize: number,
  position: SpaceLabelPosition = 'center',
): {
  x: number;
  y: number;
  width: number;
  align: 'left' | 'center' | 'right';
  verticalAnchor: 'top' | 'center' | 'bottom';
} {
  const fixedWallInset = 0.75;
  const boxWidth = Math.max(0, bbox.maxX - bbox.minX);
  const boxHeight = Math.max(0, bbox.maxY - bbox.minY);
  const insetX = Math.min(fixedWallInset, boxWidth / 2);
  const insetY = Math.min(fixedWallInset, boxHeight / 2);
  const x = bbox.minX + insetX;
  const width = Math.max(0, boxWidth - insetX * 2);
  const centerY = bbox.minY + boxHeight / 2 - fontSize / 2;
  const topY = bbox.minY + insetY;
  const bottomY = bbox.maxY - insetY - fontSize;

  switch (position) {
    case 'center-top':
      return { x, y: topY, width, align: 'center', verticalAnchor: 'top' };
    case 'center-bottom':
      return { x, y: bottomY, width, align: 'center', verticalAnchor: 'bottom' };
    case 'center-right':
      return { x, y: centerY, width, align: 'right', verticalAnchor: 'center' };
    case 'top-left':
      return { x, y: topY, width, align: 'left', verticalAnchor: 'top' };
    case 'top-right':
      return { x, y: topY, width, align: 'right', verticalAnchor: 'top' };
    case 'bottom-left':
      return { x, y: bottomY, width, align: 'left', verticalAnchor: 'bottom' };
    case 'bottom-right':
      return { x, y: bottomY, width, align: 'right', verticalAnchor: 'bottom' };
    case 'center':
    default:
      return { x, y: centerY, width, align: 'center', verticalAnchor: 'center' };
  }
}

export function resolveSpaceLabelBoxGeometry(
  layout: {
    x: number;
    y: number;
    width: number;
    align: 'left' | 'center' | 'right';
    verticalAnchor: 'top' | 'center' | 'bottom';
  },
  text: string,
  fontSize: number,
  widthScale = 1,
): {
  textX: number;
  textY: number;
  textWidth: number;
  textHeight: number;
  rectX: number;
  rectY: number;
  rectWidth: number;
  rectHeight: number;
} {
  const lineHeightMultiplier = 1.15;
  const averageCharWidth = fontSize * 0.56;
  const paddingX = fontSize * 0.35;
  const paddingY = fontSize * 0.22;
  const scaledLayoutWidth = Math.max(1, layout.width * widthScale);
  const maxContentWidth = Math.max(1, scaledLayoutWidth - paddingX * 2);
  const maxCharsPerLine = Math.max(1, Math.floor(maxContentWidth / Math.max(averageCharWidth, 1e-6)));

  const sourceLines = text.split('\n');
  let lineCount = 0;
  let maxLineChars = 1;
  for (const sourceLine of sourceLines) {
    const chars = Math.max(1, sourceLine.length);
    const wrappedLineCount = Math.max(1, Math.ceil(chars / maxCharsPerLine));
    lineCount += wrappedLineCount;
    maxLineChars = Math.max(maxLineChars, Math.min(chars, maxCharsPerLine));
  }

  const estimatedLineWidth = maxLineChars * averageCharWidth;
  const contentWidth = Math.max(fontSize * 1.5, Math.min(maxContentWidth, estimatedLineWidth));
  const contentHeight = Math.max(fontSize, lineCount * fontSize * lineHeightMultiplier);
  const rectWidth = contentWidth + paddingX * 2;
  const rectHeight = contentHeight + paddingY * 2;

  let rectX = layout.x;
  if (layout.align === 'center') {
    rectX = layout.x + (scaledLayoutWidth - rectWidth) / 2;
  } else if (layout.align === 'right') {
    rectX = layout.x + scaledLayoutWidth - rectWidth;
  }

  const anchorCenterY = layout.y + fontSize / 2;
  const anchorBottomY = layout.y + fontSize;
  let rectY = layout.y - paddingY;
  if (layout.verticalAnchor === 'center') {
    rectY = anchorCenterY - rectHeight / 2;
  } else if (layout.verticalAnchor === 'bottom') {
    rectY = anchorBottomY - contentHeight - paddingY;
  }

  const textX = rectX + paddingX;
  const textY = rectY + paddingY;

  return {
    textX,
    textY,
    textWidth: contentWidth,
    textHeight: contentHeight,
    rectX,
    rectY,
    rectWidth,
    rectHeight,
  };
}

export type WallFrame = {
  tx: number;
  ty: number;
  nx: number;
  ny: number;
  closestX: number;
  closestY: number;
  inwardNx: number;
  inwardNy: number;
};

export function getPrimaryRing(space: SpaceEntity): Ring {
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

export function findNearestWallFrame(point: XY, space?: SpaceEntity): WallFrame | null {
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

export function insetPointInsideSpace(point: XY, insetDistance: number, wallFrame: WallFrame | null): XY {
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

export function makeTransform(model: CanonicalBuildingMapModel, width: number, height: number, padding: number) {
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

export function findAnchorForAnnotation(annotation: AnnotationEntity, model: CanonicalBuildingMapModel): XY {
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

/**
 * Resolve a `LayerPosition` to absolute plan-coordinate XY.
 *
 * - If `pos` contains a `spaceId`, the position is treated as an offset from
 *   the space's bounding-box corner using `originCorner` semantics:
 *   `top-left` (default), `top-right`, `bottom-left`, or `bottom-right`.
 *   The `z` component is preserved on `LayerPosition` but is not
 *   returned here — callers that need it (e.g. OrthoBuilding for wall-height
 *   projection) should read `pos.z` directly.
 * - If the referenced space is not found, `x` and `y` are returned as-is
 *   (treated as absolute plan coordinates).
 * - Absolute plan positions are returned unchanged. If `originCorner` is
 *   provided without `spaceId`, it is ignored and coordinates remain global.
 */
export function resolveLayerPosition(
  pos: LayerPosition,
  model: CanonicalBuildingMapModel,
): XY {
  const toFiniteNumber = (value: unknown, field: 'x' | 'y'): number => {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return value;
    }
    if (typeof value === 'string') {
      const parsed = Number(value);
      if (Number.isFinite(parsed)) {
        console.info('[layer-debug][resolveLayerPosition] coerced string coordinate', { field, value, parsed });
        return parsed;
      }
    }
    console.warn('[layer-debug][resolveLayerPosition] non-finite coordinate; defaulting to 0', { field, value });
    return 0;
  };

  const localId = (value: string) => value.split('#').pop()?.split('/').pop() ?? value;

  if ('spaceId' in pos) {
    const x = toFiniteNumber(pos.x, 'x');
    const y = toFiniteNumber(pos.y, 'y');
    const space = model.spaces.find((s) => s.id === pos.spaceId);
    if (space) {
      const ring = getPrimaryRing(space);
      const bbox = computeBoundingBox(ring);
      const originCorner = pos.originCorner ?? 'top-left';

      let resolved: XY;
      switch (originCorner) {
        case 'top-right':
          resolved = { x: bbox.maxX - x, y: bbox.minY + y };
          break;
        case 'bottom-left':
          resolved = { x: bbox.minX + x, y: bbox.maxY - y };
          break;
        case 'bottom-right':
          resolved = { x: bbox.maxX - x, y: bbox.maxY - y };
          break;
        case 'top-left':
        default:
          resolved = { x: bbox.minX + x, y: bbox.minY + y };
          break;
      }
      console.info('[layer-debug][resolveLayerPosition] space-relative resolved', {
        spaceId: pos.spaceId,
        originCorner,
        input: { x: pos.x, y: pos.y },
        resolved,
      });
      return resolved;
    }

    const requestedLocalId = localId(pos.spaceId);
    const localIdMatch = model.spaces.find((s) => localId(s.id) === requestedLocalId);
    if (localIdMatch) {
      console.info('[layer-debug][resolveLayerPosition] local-id match found but not reconciled (exact spaceId required)', {
        requestedSpaceId: pos.spaceId,
        matchedSpaceId: localIdMatch.id,
      });
    }

    // Space not found — treat x/y as absolute fallback.
    const fallback = { x, y };
    console.warn('[BuildingMap] resolveLayerPosition: space not found for spaceId; falling back to absolute coordinates', {
      spaceId: pos.spaceId,
      fallback,
    });
    return fallback;
  }
  const absolute = { x: toFiniteNumber(pos.x, 'x'), y: toFiniteNumber(pos.y, 'y') };
  console.info('[layer-debug][resolveLayerPosition] absolute resolved', {
    input: { x: pos.x, y: pos.y },
    resolved: absolute,
  });
  return absolute;
}

/**
 * Clamp a resolved plan-coordinate point so that the icon's visual extents
 * remain within the bounding box of the associated space.
 *
 * Only applies when `position` contains a `spaceId`. If the space cannot be
 * found, or the icon already fits, the original point is returned unchanged.
 *
 * Half-extents are expressed in plan units by dividing the icon's pixel size
 * by the current viewport scale. The caller should pass the maximum half-extent
 * across all rendered elements (background shape + icon graphic).
 */
export function clampMarkerToSpaceBbox(
  pt: XY,
  position: LayerPosition,
  model: CanonicalBuildingMapModel,
  halfExtentX: number,
  halfExtentY: number,
): XY {
  if (!('spaceId' in position)) {
    return pt;
  }
  const space = model.spaces.find((s) => s.id === position.spaceId);
  if (!space) {
    return pt;
  }
  const ring = getPrimaryRing(space);
  const bbox = computeBoundingBox(ring);

  const clampedX = Math.max(bbox.minX + halfExtentX, Math.min(pt.x, bbox.maxX - halfExtentX));
  const clampedY = Math.max(bbox.minY + halfExtentY, Math.min(pt.y, bbox.maxY - halfExtentY));
  return { x: clampedX, y: clampedY };
}
