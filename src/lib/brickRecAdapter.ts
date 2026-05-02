import { normalizeCoordinate, normalizeRing } from './geometryProfile';
import type { GeometryProfile, RawCoordinate } from './geometryProfile';
import type {
  AdapterResult,
  AnnotationEntity,
  AssetEntity,
  CanonicalBuildingMapModel,
  Diagnostic,
  Ring,
  SpaceEntity,
} from './types';

type BrickRecPolygonGeometry = {
  type: 'Polygon';
  coordinates: RawCoordinate[][];
  coordinateSystem?: string;
};

type BrickRecMultiPolygonGeometry = {
  type: 'MultiPolygon';
  coordinates: RawCoordinate[][][];
  coordinateSystem?: string;
};

type BrickRecGeometry = BrickRecPolygonGeometry | BrickRecMultiPolygonGeometry;

function hasZCoordinateInPolygon(coordinates: RawCoordinate[][]): boolean {
  return coordinates.some((ring) => ring.some((point) => point.length >= 3));
}

function hasZCoordinateInMultiPolygon(coordinates: RawCoordinate[][][]): boolean {
  return coordinates.some((polygon) => hasZCoordinateInPolygon(polygon));
}

export type BrickRecSpaceSource = {
  volume?: number;
  id: string;
  label: string;
  hasExplicitLabel?: boolean;
  brickClass?: string;
  levelId?: string;
  parentId?: string;
  geometry?: BrickRecGeometry;
};

export type BrickRecSpatialNodeSource = {
  id: string;
  parentId?: string;
  geometry?: BrickRecGeometry;
};

export type BrickRecAssetSource = {
  id: string;
  label: string;
  type: string;
  brickClass?: string;
  spaceId?: string;
  parentId?: string;
  coordinateSystem?: string;
  position: RawCoordinate;
  metadata?: Record<string, string | number | boolean | null>;
};

export type BrickRecAnnotationSource = {
  id: string;
  targetType: 'space' | 'asset' | 'map';
  targetId?: string;
  label: string;
  color?: string;
  position?: RawCoordinate;
};

export type BrickRecHvacNodeSource = {
  id: string;
  label: string;
  brickClass?: string;
};

export type BrickRecHvacConnectionSource = {
  fromAssetId: string;
  toAssetId: string;
  relation: 's223:cnx';
  inferred?: boolean;
};

export type BrickRecSource = {
  id: string;
  label: string;
  floor: {
    id: string;
    label: string;
    levelIndex: number;
  };
  spaces: BrickRecSpaceSource[];
  spatialNodes?: BrickRecSpatialNodeSource[];
  assets?: BrickRecAssetSource[];
  annotations?: BrickRecAnnotationSource[];
  hvacNodes?: BrickRecHvacNodeSource[];
  hvacConnections?: BrickRecHvacConnectionSource[];
};

function maybeWarnCoordinateSystem(
  coordinateSystem: string | undefined,
  profile: GeometryProfile,
  diagnostics: Diagnostic[],
  path: string,
): void {
  if (!coordinateSystem) {
    return;
  }

  if (profile.coordinateSystemAliases[coordinateSystem] === undefined) {
    diagnostics.push({
      level: 'warning',
      code: 'PROFILE_UNKNOWN_COORDINATE_SYSTEM',
      message: `Coordinate system '${coordinateSystem}' is not declared in profile aliases.`,
      path,
    });
  }
}

function validateRing(ring: Ring, profile: GeometryProfile): boolean {
  return ring.length >= profile.validationPolicy.minRingPoints;
}

function isLocalCoordinateSystem(coordinateSystem?: string): boolean {
  if (!coordinateSystem) {
    return false;
  }

  const normalized = coordinateSystem.trim().toLowerCase();
  return normalized === 'localcoordinates' || normalized.includes('local');
}

function translateCoordinate(coordinate: RawCoordinate, dx: number, dy: number): RawCoordinate {
  if (coordinate.length === 3) {
    const z = coordinate[2];
    return [coordinate[0] + dx, coordinate[1] + dy, z];
  }
  return [coordinate[0] + dx, coordinate[1] + dy];
}

function flattenRawGeometryPoints(geometry: BrickRecGeometry): RawCoordinate[] {
  if (geometry.type === 'Polygon') {
    return geometry.coordinates.flat();
  }
  return geometry.coordinates.flat(2);
}

function getBottomLeftAnchor(geometry: BrickRecGeometry): { x: number; y: number } {
  const points = flattenRawGeometryPoints(geometry);
  let minX = points[0][0];
  let minY = points[0][1];

  for (let i = 1; i < points.length; i += 1) {
    const point = points[i];
    if (point[0] < minX) {
      minX = point[0];
    }
    if (point[1] < minY) {
      minY = point[1];
    }
  }

  return { x: minX, y: minY };
}

function getNearestAncestorGeometry(
  parentId: string | undefined,
  spatialNodeById: Map<string, BrickRecSpatialNodeSource>,
  diagnostics: Diagnostic[],
  path: string,
  resolving: Set<string>,
  cache: Map<string, BrickRecGeometry | null>,
): BrickRecGeometry | undefined {
  let currentId = parentId;
  const visited = new Set<string>();

  while (currentId) {
    if (visited.has(currentId)) {
      diagnostics.push({
        level: 'warning',
        code: 'COORDINATE_PARENT_CYCLE',
        message: `Detected parent coordinate cycle while resolving ancestor '${currentId}'.`,
        path,
      });
      return undefined;
    }
    visited.add(currentId);

    const resolved = resolveSpatialNodeGeometry(
      currentId,
      spatialNodeById,
      diagnostics,
      path,
      resolving,
      cache,
    );
    if (resolved) {
      return resolved;
    }

    const node = spatialNodeById.get(currentId);
    if (!node) {
      return undefined;
    }
    currentId = node.parentId;
  }

  return undefined;
}

function resolveSpatialNodeGeometry(
  nodeId: string,
  spatialNodeById: Map<string, BrickRecSpatialNodeSource>,
  diagnostics: Diagnostic[],
  path: string,
  resolving: Set<string>,
  cache: Map<string, BrickRecGeometry | null>,
): BrickRecGeometry | undefined {
  const cached = cache.get(nodeId);
  if (cached !== undefined) {
    return cached ?? undefined;
  }

  const node = spatialNodeById.get(nodeId);
  if (!node || !node.geometry) {
    cache.set(nodeId, null);
    return undefined;
  }

  if (!isLocalCoordinateSystem(node.geometry.coordinateSystem) || !node.parentId) {
    cache.set(nodeId, node.geometry);
    return node.geometry;
  }

  if (resolving.has(nodeId)) {
    diagnostics.push({
      level: 'warning',
      code: 'COORDINATE_PARENT_CYCLE',
      message: `Detected parent coordinate cycle while resolving '${nodeId}'. Using unresolved local coordinates.`,
      path,
    });
    cache.set(nodeId, node.geometry);
    return node.geometry;
  }

  resolving.add(nodeId);
  const parentGeometry = getNearestAncestorGeometry(
    node.parentId,
    spatialNodeById,
    diagnostics,
    path,
    resolving,
    cache,
  );
  resolving.delete(nodeId);

  if (!parentGeometry) {
    // No ancestor geometry is acceptable; keep local coordinates unchanged.
    cache.set(nodeId, node.geometry);
    return node.geometry;
  }

  const anchor = getBottomLeftAnchor(parentGeometry);
  const resolved = node.geometry.type === 'Polygon'
    ? {
        ...node.geometry,
        coordinates: node.geometry.coordinates.map((ring) =>
          ring.map((coordinate) => translateCoordinate(coordinate, anchor.x, anchor.y)),
        ),
      }
    : {
        ...node.geometry,
        coordinates: node.geometry.coordinates.map((polygon) =>
          polygon.map((ring) => ring.map((coordinate) => translateCoordinate(coordinate, anchor.x, anchor.y))),
        ),
      };

  cache.set(nodeId, resolved);
  return resolved;
}

function resolveSpaceGeometry(
  space: BrickRecSpaceSource,
  spatialNodeById: Map<string, BrickRecSpatialNodeSource>,
  diagnostics: Diagnostic[],
  resolving: Set<string>,
  cache: Map<string, BrickRecGeometry | null>,
): BrickRecGeometry | undefined {
  return resolveSpatialNodeGeometry(
    space.id,
    spatialNodeById,
    diagnostics,
    `spaces.${space.id}.parentId`,
    resolving,
    cache,
  );
}

function resolveAssetPosition(
  asset: BrickRecAssetSource,
  spatialNodeById: Map<string, BrickRecSpatialNodeSource>,
  diagnostics: Diagnostic[],
  cache: Map<string, BrickRecGeometry | null>,
): RawCoordinate {
  const explicitLocal = isLocalCoordinateSystem(asset.coordinateSystem);
  const parentId = asset.parentId ?? asset.spaceId;
  const parentNode = parentId ? spatialNodeById.get(parentId) : undefined;
  const inheritedLocal = !asset.coordinateSystem && isLocalCoordinateSystem(parentNode?.geometry?.coordinateSystem);

  if (!(explicitLocal || inheritedLocal)) {
    return asset.position;
  }

  const parentGeometry = getNearestAncestorGeometry(
    parentId,
    spatialNodeById,
    diagnostics,
    `assets.${asset.id}.parentId`,
    new Set<string>(),
    cache,
  );
  if (!parentGeometry) {
    // No ancestor geometry is acceptable; keep local coordinates unchanged.
    return asset.position;
  }

  const anchor = getBottomLeftAnchor(parentGeometry);
  return translateCoordinate(asset.position, anchor.x, anchor.y);
}

function buildSpaceMetadata(
  has3D: boolean,
  coordinates: unknown,
  volume: number | undefined,
): Record<string, string | number | boolean | null> | undefined {
  const entries: Record<string, string | number | boolean | null> = {};
  if (has3D) {
    entries.sourceHasZ = true;
    entries.sourceCoordinates = JSON.stringify(coordinates);
  }
  if (volume !== undefined) {
    entries.volume = volume;
  }
  return Object.keys(entries).length > 0 ? entries : undefined;
}

function toSpaceEntity(
  source: BrickRecSpaceSource,
  profile: GeometryProfile,
  diagnostics: Diagnostic[],
): SpaceEntity | null {
  if (!source.geometry) {
    diagnostics.push({
      level: 'warning',
      code: 'SPACE_GEOMETRY_MISSING',
      message: `Space '${source.id}' does not have rec:geometry and will be skipped.`,
      path: `spaces.${source.id}.geometry`,
    });
    return null;
  }

  maybeWarnCoordinateSystem(
    source.geometry.coordinateSystem,
    profile,
    diagnostics,
    `spaces.${source.id}.geometry.coordinateSystem`,
  );

  if (source.geometry.type === 'Polygon') {
    const rings = source.geometry.coordinates.map((ring) => normalizeRing(ring, profile));
    const has3D = hasZCoordinateInPolygon(source.geometry.coordinates);
    const invalidRing = rings.find((ring) => !validateRing(ring, profile));
    if (invalidRing) {
      diagnostics.push({
        level: profile.validationPolicy.onInvalidRing === 'reject' ? 'error' : 'warning',
        code: 'SPACE_RING_INVALID',
        message: `Space '${source.id}' has an invalid polygon ring.`,
        path: `spaces.${source.id}.geometry.coordinates`,
      });
      if (profile.validationPolicy.onInvalidRing === 'reject') {
        return null;
      }
    }

    return {
      id: source.id,
      label: source.label,
      hasExplicitLabel: source.hasExplicitLabel,
      brickClass: source.brickClass,
      levelId: source.levelId,
      metadata: buildSpaceMetadata(has3D, source.geometry.coordinates, source.volume),
      geometry: {
        type: 'Polygon',
        rings,
      },
    };
  }

  const polygons = source.geometry.coordinates.map((polygon) =>
    polygon.map((ring) => normalizeRing(ring, profile)),
  );
  const has3D = hasZCoordinateInMultiPolygon(source.geometry.coordinates);

  return {
    id: source.id,
    label: source.label,
    hasExplicitLabel: source.hasExplicitLabel,
    brickClass: source.brickClass,
    levelId: source.levelId,
    metadata: buildSpaceMetadata(has3D, source.geometry.coordinates, source.volume),
    geometry: {
      type: 'MultiPolygon',
      polygons,
    },
  };
}

function toAssetEntity(source: BrickRecAssetSource, profile: GeometryProfile): AssetEntity {
  const has3D = source.position.length >= 3;
  const metadata = {
    ...(source.metadata ?? {}),
    ...(has3D
      ? {
          sourceHasZ: true,
          sourcePosition: JSON.stringify(source.position),
          sourceZ: source.position[2] ?? null,
        }
      : {}),
  };

  return {
    id: source.id,
    label: source.label,
    type: source.type,
    brickClass: source.brickClass,
    spaceId: source.spaceId,
    metadata: Object.keys(metadata).length > 0 ? metadata : undefined,
    position: normalizeCoordinate(source.position, profile),
  };
}

function toAnnotationEntity(
  source: BrickRecAnnotationSource,
  profile: GeometryProfile,
): AnnotationEntity {
  return {
    id: source.id,
    targetType: source.targetType,
    targetId: source.targetId,
    label: source.label,
    color: source.color,
    position: source.position
      ? normalizeCoordinate(source.position, profile)
      : undefined,
  };
}

export function parseBrickRecSource(source: BrickRecSource, profile: GeometryProfile): AdapterResult {
  const diagnostics: Diagnostic[] = [];

  const spatialNodeById = new Map<string, BrickRecSpatialNodeSource>();
  for (const node of source.spatialNodes ?? []) {
    spatialNodeById.set(node.id, node);
  }
  for (const space of source.spaces) {
    const existing = spatialNodeById.get(space.id);
    spatialNodeById.set(space.id, {
      id: space.id,
      parentId: space.parentId ?? existing?.parentId,
      geometry: space.geometry ?? existing?.geometry,
    });
  }

  const resolvedGeometryCache = new Map<string, BrickRecGeometry | null>();
  const resolvedSpacesSource: BrickRecSpaceSource[] = source.spaces.map((space) => {
    const resolvedGeometry = resolveSpaceGeometry(
      space,
      spatialNodeById,
      diagnostics,
      new Set<string>(),
      resolvedGeometryCache,
    );

    return {
      ...space,
      geometry: resolvedGeometry,
    };
  });
  const spaces = resolvedSpacesSource
    .map((space) => toSpaceEntity(space, profile, diagnostics))
    .filter((space): space is SpaceEntity => space !== null);

  const assets = (source.assets ?? []).map((asset) =>
    toAssetEntity(
      {
        ...asset,
        position: resolveAssetPosition(asset, spatialNodeById, diagnostics, resolvedGeometryCache),
      },
      profile,
    ),
  );
  const annotations = (source.annotations ?? []).map((item) =>
    toAnnotationEntity(item, profile),
  );

  const model: CanonicalBuildingMapModel = {
    id: source.id,
    label: source.label,
    floor: source.floor,
    spaces,
    assets,
    annotations,
  };

  return { model, diagnostics };
}
