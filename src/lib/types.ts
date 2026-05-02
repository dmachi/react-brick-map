import type { ReactNode } from 'react';
import type { RdfStore, RdfSelectRow } from './rdfStore';

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

// ---------------------------------------------------------------------------
// External layer system — positioning
// ---------------------------------------------------------------------------

/**
 * Position relative to a specific space's bounding-box min-corner
 * (minX, minY in plan coordinates with the geometry profile's axis convention).
 *
 * This lets layer items be authored in room-local coordinates without knowing
 * the absolute plan position of the space. For example, given a 10 × 10 room
 * whose plan bounding box starts at (20, 30), `{ spaceId: 'room-1', x: 5, y: 5 }`
 * resolves to plan coordinate (25, 35).
 *
 * `z` is the height above the floor plane in plan units. It is forwarded to
 * OrthoBuilding's projection pass for wall-mounted / ceiling items; it is
 * ignored by the 2-D BuildingMap.
 */
export type SpaceRelativePosition = {
  spaceId: Id;
  x: number;
  y: number;
  z?: number;
};

/**
 * A position for a layer item — either absolute plan coordinates (XY with an
 * optional `z` height) or space-relative coordinates (identified by `spaceId`).
 * Discriminated by the presence of `spaceId`.
 */
export type LayerPosition = XY | SpaceRelativePosition;

// ---------------------------------------------------------------------------
// External visual control system
// ---------------------------------------------------------------------------

export type IconTextSpec = {
  kind: 'text';
  text: string;
};

export type IconSvgPathSpec = {
  kind: 'svg-path';
  path: string;
  width?: number;
  height?: number;
  viewBoxWidth?: number;
  viewBoxHeight?: number;
  fill?: string;
  stroke?: string;
  strokeWidth?: number;
};

export type IconImageSpec = {
  kind: 'image';
  url: string;
  width?: number;
  height?: number;
};

export type IconSpec = IconTextSpec | IconSvgPathSpec | IconImageSpec;

export type RotationControl = {
  /** If provided, this value wins over animation velocity. */
  angleDegrees?: number;
  /** Optional angular velocity used for animation. */
  velocityDegreesPerSecond?: number;
  /** Offset applied when velocity-based rotation is active. */
  baseDegrees?: number;
  /** Epoch used for velocity-based animation. Defaults to 0. */
  startTimeMs?: number;
};

export type SpaceVisualOverride = {
  fill?: string;
  fillHover?: string;
  fillSelected?: string;
  stroke?: string;
  labelColor?: string;
  iconColor?: string;
  icon?: string | IconSpec;
};

export type AssetVisualOverride = {
  fill?: string;
  stroke?: string;
  labelColor?: string;
  iconColor?: string;
  icon?: string | IconSpec;
  radius?: number;
  rotation?: RotationControl;
};

export type VisualControlState = {
  classes?: {
    spaces?: Record<string, SpaceVisualOverride>;
    assets?: Record<string, AssetVisualOverride>;
  };
  spaces?: Record<Id, SpaceVisualOverride>;
  assets?: Record<Id, AssetVisualOverride>;
  /** Optional externally-supplied animation clock, in ms. */
  animationClockMs?: number;
};

// ---------------------------------------------------------------------------
// External layer system
// ---------------------------------------------------------------------------

export type LayerQueryContext = {
  model: CanonicalBuildingMapModel;
  rdfStore: RdfStore;
};

/** Overlay a tinted fill/stroke on an existing space polygon (top face in ortho view). */
export type SpaceLayerItem = {
  spaceId: Id;
  fill?: string;
  fillOpacity?: number;
  stroke?: string;
  strokeOpacity?: number;
  strokeWidth?: number;
  label?: string;
  labelColor?: string;
};

/** A circular icon marker placed at a plan-coordinate or space-relative position. */
export type MarkerLayerItem = {
  id: Id;
  position: LayerPosition;
  /** Shape to render. Defaults to `'circle'`. */
  shape?: 'circle' | 'rect' | 'diamond';
  /** Width in plan units. Used by `'rect'` and `'diamond'` shapes. Defaults to `radius * 2`. */
  width?: number;
  /** Height in plan units. Used by `'rect'` and `'diamond'` shapes. Defaults to `radius * 2`. */
  height?: number;
  /** Rotation in degrees. Applied to `'rect'` and `'diamond'` shapes. */
  rotation?: number;
  fill?: string;
  stroke?: string;
  radius?: number;
  icon?: string;
  iconColor?: string;
  label?: string;
  labelColor?: string;
  tooltip?: string;
  onClick?: (item: MarkerLayerItem) => void;
};

/** Floating text anchored to a plan-coordinate or space-relative position. */
export type AnnotationLayerItem = {
  id: Id;
  position: LayerPosition;
  text: string;
  color?: string;
  fontSize?: number;
};

/**
 * Escape hatch for fully custom Konva content at a positioned point.
 *
 * The component resolves `position` to absolute plan coordinates (applying
 * space-relative offsets when `spaceId` is present), then — in OrthoBuilding —
 * projects the result to screen coordinates. The final projected point and the
 * current viewport scale are forwarded to `render` so the callback can size
 * stroke widths and font sizes consistently with the built-in layers.
 *
 * The `render` function **must** return react-konva nodes (Group, Circle,
 * Rect, Line, Text, Image, Path, …). Keep it referentially stable (define
 * outside the layer definition or wrap in `useCallback`) to avoid unnecessary
 * re-renders.
 */
export type CustomLayerItem = {
  id: Id;
  position: LayerPosition;
  /** Called with the final projected screen-space XY and current viewport scale. */
  render: (projected: XY, scale: number) => ReactNode;
  tooltip?: string;
  onClick?: () => void;
};

/** The structured payload a layer produces. */
export type LayerData = {
  spaces?: SpaceLayerItem[];
  markers?: MarkerLayerItem[];
  annotations?: AnnotationLayerItem[];
  /** Escape hatch: arbitrary Konva elements at positioned points. */
  custom?: CustomLayerItem[];
};

/**
 * Controls where in the render stack this layer's output is drawn.
 *
 * - `'floor'`   — Rendered after floor fills but before wall geometry. In OrthoBuilding,
 *               space overlays use plan-coordinate rings so they appear on the floor plane
 *               and walls are extruded in front of them. In BuildingMap (2D), rendered
 *               before space fills.
 * - `'walls'`   — Rendered after wall caps but before labels. In OrthoBuilding, space
 *               overlays use the projected top-face ring so they sit on the wall-top
 *               surface. Suitable for wall-mounted sensors, zone indicators, etc.
 * - `'overlay'` — Rendered after all geometry, labels, assets and annotations (default).
 *               Floats on top of everything.
 */
export type LayerRenderOrder = 'floor' | 'walls' | 'overlay';

/** (a) Static SPARQL string — component runs the query, calls mapResults with the rows. */
export type SparqlLayerDefinition = {
  type: 'sparql';
  id: string;
  label: string;
  color?: string;
  defaultVisible?: boolean;
  renderOrder?: LayerRenderOrder;
  query: string;
  mapResults: (rows: RdfSelectRow[], context: LayerQueryContext) => LayerData;
};

/** (b) Dynamic SPARQL — getQuery receives context so it can build the string at runtime. */
export type SparqlFnLayerDefinition = {
  type: 'sparql-fn';
  id: string;
  label: string;
  color?: string;
  defaultVisible?: boolean;
  renderOrder?: LayerRenderOrder;
  getQuery: (context: LayerQueryContext) => string;
  mapResults: (rows: RdfSelectRow[], context: LayerQueryContext) => LayerData;
};

/** (c) Custom data provider — can fetch from external APIs, compute locally, etc. */
export type DataLayerDefinition = {
  type: 'data';
  id: string;
  label: string;
  color?: string;
  defaultVisible?: boolean;
  renderOrder?: LayerRenderOrder;
  getData: (context: LayerQueryContext) => LayerData | Promise<LayerData>;
};

export type LayerDefinition =
  | SparqlLayerDefinition
  | SparqlFnLayerDefinition
  | DataLayerDefinition;

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
