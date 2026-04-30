export type Id = string;

export type XY = {
  x: number;
  y: number;
};

export type Ring = XY[];

export type PolygonGeometry = {
  type: 'Polygon';
  rings: Ring[];
};

export type MultiPolygonGeometry = {
  type: 'MultiPolygon';
  polygons: Ring[][];
};

export type Geometry = PolygonGeometry | MultiPolygonGeometry;

export type SpaceEntity = {
  id: Id;
  label: string;
  brickClass?: string;
  levelId?: string;
  geometry: Geometry;
  metadata?: Record<string, string | number | boolean | null>;
};

export type AssetEntity = {
  id: Id;
  label: string;
  type: string;
  brickClass?: string;
  spaceId?: Id;
  position: XY;
  metadata?: Record<string, string | number | boolean | null>;
};

export type AnnotationEntity = {
  id: Id;
  targetType: 'space' | 'asset' | 'map';
  targetId?: Id;
  label: string;
  color?: string;
  position?: XY;
};

export type FloorEntity = {
  id: Id;
  label: string;
  levelIndex: number;
};

export type CanonicalBuildingMapModel = {
  id: Id;
  label: string;
  floor: FloorEntity;
  spaces: SpaceEntity[];
  assets: AssetEntity[];
  annotations: AnnotationEntity[];
};

export type LayerVisibility = {
  floorPlan: boolean;
  roomMetrics: boolean;
  sensors: boolean;
  hvac: boolean;
};

export const DEFAULT_LAYER_VISIBILITY: LayerVisibility = {
  floorPlan: true,
  roomMetrics: false,
  sensors: true,
  hvac: false,
};

export type Diagnostic = {
  level: 'warning' | 'error';
  code: string;
  message: string;
  path?: string;
};

export type AdapterResult = {
  model: CanonicalBuildingMapModel;
  diagnostics: Diagnostic[];
};
