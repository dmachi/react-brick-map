import type { Ring, XY } from './types';

export const DEFAULT_ORTHO_DEPTH = 3.0;
export const DEFAULT_ORTHO_ANGLE_DEGREES = 15;
export const DEFAULT_ORTHO_PERSPECTIVE_STRENGTH = 1.9;

export type OrthoProjectionContext = {
  center: XY;
  maxRadius: number;
  radialScale: number;
  radialFalloffExponent: number;
};

export function createOrthoProjectionContext(
  points: XY[],
  depth = DEFAULT_ORTHO_DEPTH,
  strength = DEFAULT_ORTHO_PERSPECTIVE_STRENGTH,
): OrthoProjectionContext {
  if (points.length === 0) {
    return {
      center: { x: 0, y: 0 },
      maxRadius: 1,
      radialScale: 0,
      radialFalloffExponent: 1.8,
    };
  }

  let sumX = 0;
  let sumY = 0;
  for (const point of points) {
    sumX += point.x;
    sumY += point.y;
  }

  const center = {
    x: sumX / points.length,
    y: sumY / points.length,
  };

  let maxRadius = 0;
  for (const point of points) {
    const radius = Math.hypot(point.x - center.x, point.y - center.y);
    if (radius > maxRadius) {
      maxRadius = radius;
    }
  }

  return {
    center,
    maxRadius: Math.max(maxRadius, 1e-6),
    radialScale: depth * Math.max(0, strength),
    // Larger exponents keep near-center walls mostly top-down while amplifying perimeter walls.
    radialFalloffExponent: 1.15,
  };
}

export function getOrthoOffset(depth: number, angleDegrees = DEFAULT_ORTHO_ANGLE_DEGREES): XY {
  const radians = (angleDegrees * Math.PI) / 180;
  return {
    x: -Math.cos(radians) * depth,
    y: -Math.sin(radians) * depth,
  };
}

export function projectPlanPoint(point: XY, depth: number, angleDegrees = DEFAULT_ORTHO_ANGLE_DEGREES): XY {
  const offset = getOrthoOffset(depth, angleDegrees);
  return {
    x: point.x + offset.x,
    y: point.y + offset.y,
  };
}

export function projectPlanPointFromCenter(point: XY, _context: OrthoProjectionContext): XY {
  const context = _context;
  const dx = point.x - context.center.x;
  const dy = point.y - context.center.y;
  const radius = Math.hypot(dx, dy);
  if (radius <= 1e-9) {
    return point;
  }

  const radiusNorm = Math.min(1, radius / Math.max(context.maxRadius, 1e-6));
  const offsetMagnitude = context.radialScale * Math.pow(radiusNorm, context.radialFalloffExponent);
  const dirX = dx / radius;
  const dirY = dy / radius;

  return {
    x: point.x + dirX * offsetMagnitude,
    y: point.y + dirY * offsetMagnitude,
  };
}

export function projectRingTopFace(
  ring: Ring,
  depth: number,
  angleDegrees = DEFAULT_ORTHO_ANGLE_DEGREES,
  context?: OrthoProjectionContext,
): Ring {
  if (context) {
    return ring.map((point) => projectPlanPointFromCenter(point, context));
  }
  return ring.map((point) => projectPlanPoint(point, depth, angleDegrees));
}

function normalizeVector(vector: XY): XY {
  const length = Math.hypot(vector.x, vector.y);
  if (length <= 1e-9) {
    return { x: 1, y: 0 };
  }
  return { x: vector.x / length, y: vector.y / length };
}

function ringCentroid(ring: Ring): XY {
  if (ring.length === 0) {
    return { x: 0, y: 0 };
  }

  const isClosed = ring[0].x === ring[ring.length - 1].x && ring[0].y === ring[ring.length - 1].y;
  const maxIndex = isClosed ? ring.length - 1 : ring.length;
  let sumX = 0;
  let sumY = 0;

  for (let i = 0; i < maxIndex; i += 1) {
    sumX += ring[i].x;
    sumY += ring[i].y;
  }

  return {
    x: sumX / Math.max(1, maxIndex),
    y: sumY / Math.max(1, maxIndex),
  };
}

export function getOrthoCameraVector(angleDegrees = DEFAULT_ORTHO_ANGLE_DEGREES): XY {
  const offset = getOrthoOffset(1, angleDegrees);
  return normalizeVector({ x: -offset.x, y: -offset.y });
}

export type OrthoWallQuad = {
  id: string;
  a: XY;
  b: XY;
  topB: XY;
  topA: XY;
  visible: boolean;
  depthSort: number;
};

export function buildExtrudedWallQuads(
  ring: Ring,
  depth: number,
  angleDegrees = DEFAULT_ORTHO_ANGLE_DEGREES,
  context?: OrthoProjectionContext,
): OrthoWallQuad[] {
  if (ring.length < 2) {
    return [];
  }

  const cameraVector = getOrthoCameraVector(angleDegrees);
  const centroid = ringCentroid(ring);
  const projected = projectRingTopFace(ring, depth, angleDegrees, context);
  const walls: OrthoWallQuad[] = [];

  for (let index = 0; index < ring.length - 1; index += 1) {
    const a = ring[index];
    const b = ring[index + 1];
    const topA = projected[index];
    const topB = projected[index + 1];

    const edgeX = b.x - a.x;
    const edgeY = b.y - a.y;
    const edgeLength = Math.hypot(edgeX, edgeY);
    if (edgeLength <= 1e-9) {
      continue;
    }

    const candidateNormalA = { x: edgeY / edgeLength, y: -edgeX / edgeLength };
    const candidateNormalB = { x: -candidateNormalA.x, y: -candidateNormalA.y };
    const midpoint = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
    const toCenter = { x: centroid.x - midpoint.x, y: centroid.y - midpoint.y };
    const normalAInward = candidateNormalA.x * toCenter.x + candidateNormalA.y * toCenter.y > 0;
    const outward = normalAInward ? candidateNormalB : candidateNormalA;
    const radial = context
      ? normalizeVector({
          x: midpoint.x - context.center.x,
          y: midpoint.y - context.center.y,
        })
      : cameraVector;
    const radialDistance = context
      ? Math.hypot(midpoint.x - context.center.x, midpoint.y - context.center.y)
      : 0;
    const radialNorm = context
      ? Math.min(1, radialDistance / Math.max(context.maxRadius, 1e-6))
      : 1;
    // Near center require stronger facing alignment, perimeter walls are allowed to show more.
    const minFacingDot = context
      ? 0.38 - radialNorm * 0.43
      : 0.01;
    const visible = context
      ? outward.x * radial.x + outward.y * radial.y > minFacingDot
      : outward.x * cameraVector.x + outward.y * cameraVector.y > 0.01;

    const faceCenter = {
      x: (a.x + b.x + topA.x + topB.x) / 4,
      y: (a.y + b.y + topA.y + topB.y) / 4,
    };
    const depthSort = context
      ? Math.hypot(faceCenter.x - context.center.x, faceCenter.y - context.center.y)
      : faceCenter.x * cameraVector.x + faceCenter.y * cameraVector.y;

    walls.push({
      id: `${index}`,
      a,
      b,
      topB,
      topA,
      visible,
      depthSort,
    });
  }

  return walls.sort((left, right) => {
    if (left.depthSort !== right.depthSort) {
      return left.depthSort - right.depthSort;
    }
    // Draw back-facing/interior-biased walls first so front faces can sit on top.
    return Number(left.visible) - Number(right.visible);
  });
}
