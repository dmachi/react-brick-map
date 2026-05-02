import type {
  AnnotationEntity,
  AssetEntity,
  CanonicalBuildingMapModel,
  Ring,
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
