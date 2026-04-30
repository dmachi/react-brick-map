import { z } from 'zod';
import type { Ring, XY } from './types';

export type RawCoordinate = [number, number] | [number, number, number];

const geometryProfileSchema = z.object({
  profileName: z.string().min(1),
  profileVersion: z.string().min(1),
  axisOrder: z.enum(['xy', 'yx']).default('xy'),
  units: z.enum(['meters', 'feet', 'custom']).default('meters'),
  coordinateSystemAliases: z.record(z.string(), z.string()).default({}),
  localOrigin: z
    .object({
      x: z.number(),
      y: z.number(),
    })
    .default({ x: 0, y: 0 }),
  yAxisDirection: z.enum(['up', 'down']).default('up'),
  // Clockwise degrees from screen-up in the rendered map.
  northDirectionDegrees: z.number().default(0),
  enforceClosedRings: z.boolean().default(true),
  validationPolicy: z
    .object({
      onInvalidRing: z.enum(['reject', 'warn', 'auto-fix']).default('auto-fix'),
      minRingPoints: z.number().int().min(4).default(4),
      epsilon: z.number().min(0).default(0.000001),
    })
    .default({
      onInvalidRing: 'auto-fix',
      minRingPoints: 4,
      epsilon: 0.000001,
    }),
});

export type GeometryProfile = z.infer<typeof geometryProfileSchema>;

export function parseGeometryProfile(input: unknown): GeometryProfile {
  return geometryProfileSchema.parse(input);
}

export function normalizeCoordinate(raw: RawCoordinate, profile: GeometryProfile): XY {
  // 3D coordinates are accepted for source interoperability; rendering remains 2D (XY).
  const axisAdjusted =
    profile.axisOrder === 'xy'
      ? { x: raw[0], y: raw[1] }
      : { x: raw[1], y: raw[0] };

  const shifted = {
    x: axisAdjusted.x - profile.localOrigin.x,
    y: axisAdjusted.y - profile.localOrigin.y,
  };

  return {
    x: shifted.x,
    y: profile.yAxisDirection === 'up' ? -shifted.y : shifted.y,
  };
}

function isSamePoint(a: XY, b: XY, epsilon: number): boolean {
  return Math.abs(a.x - b.x) <= epsilon && Math.abs(a.y - b.y) <= epsilon;
}

export function normalizeRing(rawRing: RawCoordinate[], profile: GeometryProfile): Ring {
  const ring = rawRing.map((p) => normalizeCoordinate(p, profile));

  if (ring.length === 0) {
    return ring;
  }

  if (!profile.enforceClosedRings) {
    return ring;
  }

  const first = ring[0];
  const last = ring[ring.length - 1];

  if (!isSamePoint(first, last, profile.validationPolicy.epsilon)) {
    return [...ring, first];
  }

  return ring;
}
