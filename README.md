# react-brick-map

React + Konva building-map components backed by BRICK/REC semantic data. Supports 2-D floor-plan (`BuildingMap`) and isometric-ortho (`OrthoBuilding`) renderers, both with a fully external layer API.

## Contents

- [Quick start](#quick-start)
- [Architecture](#architecture)
- [Visual Controls API](#visual-controls-api)
  - [Precedence](#precedence)
  - [Examples](#examples-1)
- [External Layer API](#external-layer-api)
  - [Layer types](#layer-types)
  - [Item types](#item-types)
  - [Positioning](#positioning)
  - [Examples](#examples)
    - [Space fill overlay (SpaceLayerItem)](#space-fill-overlay-spacelayeritem)
    - [Markers — circle, rect, diamond (MarkerLayerItem)](#markers--circle-rect-diamond-markerlayeritem)
    - [Annotations (AnnotationLayerItem)](#annotations-annotationlayeritem)
    - [Space-relative positioning](#space-relative-positioning)
    - [Custom render callback (CustomLayerItem)](#custom-render-callback-customlayeritem)
    - [SPARQL-driven layer](#sparql-driven-layer)
    - [Data-driven layer with external fetch](#data-driven-layer-with-external-fetch)
- [Render order](#render-order)
- [Layer panel](#layer-panel)
- [Key files](#key-files)

---

## Quick start

```bash
npm install
npm run dev
```

```bash
npm run build
```

---

## Architecture

```
Source (BRICK/REC JSON-LD or Turtle)
  └─▶  brickRecAdapter  ──▶  CanonicalBuildingMapModel
                                    │
                   ┌────────────────┴────────────────┐
                   ▼                                 ▼
            BuildingMap (2-D)            OrthoBuilding (isometric)
                   │                                 │
         external LayerDefinition[]       external LayerDefinition[]
```

1. **Source layer** — BRICK/REC source objects with semantic and geometry metadata.
2. **Profile layer** — declarative geometry profile controls coordinate handling.
3. **Adapter layer** — mapped into canonical `CanonicalBuildingMapModel`.
4. **Renderer layer** — React Konva stage renders spaces, assets, annotations, and external layers.

## Visual Controls API

`BuildingMap` and `OrthoBuilding` accept an optional `visualControls` prop for external, in-process visual overrides.

```tsx
import type { VisualControlState } from './lib';

const visualControls: VisualControlState = {
  classes: {
    spaces: {
      office: { fill: '#e0f2fe', fillSelected: '#7dd3fc' },
    },
    assets: {
      sensor: { fill: '#082f49', stroke: '#38bdf8' },
    },
  },
  spaces: {
    'space-office-b': { fill: '#fde68a', labelColor: '#78350f' },
  },
  assets: {
    'asset-temp-1': {
      icon: { kind: 'svg-path', path: 'M12 2 L20 20 L4 20 Z', viewBoxWidth: 24, viewBoxHeight: 24 },
      rotation: { velocityDegreesPerSecond: 30, baseDegrees: 0, startTimeMs: Date.now() },
    },
    'asset-co2-1': {
      icon: { kind: 'image', url: '/icons/co2.png', width: 16, height: 16 },
    },
  },
};

<BuildingMap model={model} width={960} height={560} visualControls={visualControls} />
```

### Precedence

Visual resolution order is:

1. Base theme (`theme` + `themeOverrides`)
2. Class-level visual controls (`visualControls.classes`)
3. Instance-level visual controls (`visualControls.spaces` / `visualControls.assets`)
4. Rotation control: explicit `angleDegrees` overrides velocity-driven animation

For velocity-driven rotation, the component uses an internal animation clock by default.
If `visualControls.animationClockMs` is supplied, that external clock is used instead.

### Examples

Change a single space color:

```tsx
const visualControls: VisualControlState = {
  spaces: {
    'space-lobby': { fill: '#fca5a5', fillHover: '#f87171', fillSelected: '#ef4444' },
  },
};
```

Change a single object icon/color:

```tsx
const visualControls: VisualControlState = {
  assets: {
    'asset-vav-7': {
      fill: '#3f3f46',
      stroke: '#a1a1aa',
      icon: { kind: 'text', text: 'V' },
    },
  },
};
```

External-driven rotation (hybrid mode):

```tsx
const visualControls: VisualControlState = {
  animationClockMs: performance.now(),
  assets: {
    'asset-fan-1': {
      rotation: {
        // this explicit angle wins over velocity if both are present
        angleDegrees: fanAngle,
      },
    },
  },
};
```

---

## External Layer API

Layers are defined outside the component and passed via the `layers` prop. Visibility is owned by the consuming app via `visibleLayers` and `onLayerToggle`.

```tsx
<BuildingMap
  model={model}
  layers={layerDefinitions}
  visibleLayers={visibleLayers}
  onLayerToggle={(id) => setVisibleLayers((prev) => ({ ...prev, [id]: !prev[id] }))}
/>
```

`<OrthoBuilding>` accepts the same props.

### Layer types

| Type | When to use |
|---|---|
| `'data'` | Synchronous or async data computed locally — no SPARQL needed. |
| `'sparql'` | Static SPARQL string; component runs the query and calls `mapResults`. |
| `'sparql-fn'` | Dynamic SPARQL built at query time; `getQuery(context)` produces the string. |

All three share the common fields:

```ts
{
  type: 'data' | 'sparql' | 'sparql-fn';
  id: string;           // unique key (built-in ids are not part of external layers)
  label: string;        // shown in the layer panel
  color?: string;       // accent colour for the layer panel swatch
  defaultVisible?: boolean;
  renderOrder?: 'floor' | 'walls' | 'overlay';  // default: 'overlay'
}
```

### Item types

A layer's `getData` / `mapResults` returns a `LayerData` object:

```ts
type LayerData = {
  spaces?:      SpaceLayerItem[];       // tinted space polygon overlays
  markers?:     MarkerLayerItem[];      // shaped, positioned markers
  annotations?: AnnotationLayerItem[];  // positioned text
  custom?:      CustomLayerItem[];      // fully custom Konva elements
};
```

### Positioning

Every positioned item (`MarkerLayerItem`, `AnnotationLayerItem`, `CustomLayerItem`) accepts a `position: LayerPosition`.

```ts
// Absolute plan coordinates (default)
type AbsolutePosition = { x: number; y: number; z?: number };

// Offset from a specific space's bounding-box min-corner
type SpaceRelativePosition = { spaceId: string; x: number; y: number; z?: number };

type LayerPosition = AbsolutePosition | SpaceRelativePosition;
```

`SpaceRelativePosition` is discriminated by the presence of `spaceId`. The resolver finds the space in `model.spaces`, computes its bounding-box origin, and adds the offset. If the space is not found, `x`/`y` are treated as absolute coordinates.

`z` is stored and forwarded to OrthoBuilding's projection pass for wall-mounted or ceiling items; it is ignored by the 2-D `BuildingMap`.

---

## Examples

### Space fill overlay (`SpaceLayerItem`)

Tint specific room polygons — useful for occupancy heat maps, zone highlighting, or alarm states.

```tsx
const occupancyLayer: LayerDefinition = {
  type: 'data',
  id: 'occupancy',
  label: 'Occupancy',
  color: '#16a34a',
  renderOrder: 'floor',
  getData: ({ model }) => ({
    spaces: model.spaces.map((space) => ({
      spaceId: space.id,
      fill: '#22c55e',
      fillOpacity: 0.35,
      stroke: '#16a34a',
      strokeWidth: 1.5,
    })),
  }),
};
```

---

### Markers — circle, rect, diamond (`MarkerLayerItem`)

```tsx
const sensorsLayer: LayerDefinition = {
  type: 'data',
  id: 'sensors',
  label: 'Sensors',
  color: '#0284c7',
  renderOrder: 'overlay',
  getData: ({ model }) => ({
    markers: model.assets
      .filter((a) => a.brickClass?.includes('Sensor'))
      .map((asset) => ({
        id: asset.id,
        position: asset.position,      // AbsolutePosition (XY from model)
        shape: 'circle',               // default — can also be 'rect' or 'diamond'
        radius: 4,
        fill: '#0f172a',
        stroke: '#38bdf8',
        icon: '⚡',
        iconColor: '#bae6fd',
        label: asset.label,
        tooltip: asset.label,
        onClick: (item) => console.log('clicked sensor', item.id),
      })),
  }),
};

// Rectangular HVAC zones
const hvacZoneLayer: LayerDefinition = {
  type: 'data',
  id: 'hvacZones',
  label: 'HVAC Zones',
  color: '#b45309',
  renderOrder: 'overlay',
  getData: () => ({
    markers: [
      {
        id: 'ahu-1',
        position: { x: 12.5, y: 8.0 },
        shape: 'rect',
        width: 3,
        height: 1.5,
        rotation: 15,
        fill: '#431407',
        stroke: '#fb923c',
        icon: '⬡',
        iconColor: '#fed7aa',
        tooltip: 'AHU-1',
      },
    ],
  }),
};

// Diamond markers for alarm points
const alarmLayer: LayerDefinition = {
  type: 'data',
  id: 'alarms',
  label: 'Alarms',
  color: '#dc2626',
  renderOrder: 'overlay',
  getData: () => ({
    markers: [
      {
        id: 'alarm-smoke-1',
        position: { spaceId: 'room-101', x: 2, y: 2 }, // space-relative
        shape: 'diamond',
        width: 1.2,
        height: 1.2,
        fill: '#7f1d1d',
        stroke: '#ef4444',
        tooltip: 'Smoke detector – ALARM',
      },
    ],
  }),
};
```

---

### Annotations (`AnnotationLayerItem`)

Floating text labels at arbitrary positions — useful for area metrics, zone names, or callouts.

```tsx
import { computeSpaceMetrics, centroidOfRing, getPrimaryRing } from './lib/geometryUtils';

const roomMetricsLayer: LayerDefinition = {
  type: 'data',
  id: 'roomMetrics',
  label: 'Room Metrics',
  color: '#1e40af',
  renderOrder: 'overlay',
  getData: ({ model }) => ({
    annotations: model.spaces.flatMap((space) => {
      const { area, width, height } = computeSpaceMetrics(space);
      if (area < 0.01) return [];
      const ring = getPrimaryRing(space);
      const centroid = centroidOfRing(ring);
      return [
        { id: `${space.id}-dims`,  position: { x: centroid.x, y: centroid.y + 11 }, text: `${width.toFixed(1)} × ${height.toFixed(1)}`, color: '#1e40af', fontSize: 9 },
        { id: `${space.id}-area`,  position: { x: centroid.x, y: centroid.y + 22 }, text: `${area.toFixed(1)} m²`,                       color: '#1e40af', fontSize: 9 },
      ];
    }),
  }),
};
```

---

### Space-relative positioning

Items can be positioned relative to a room's bounding-box min-corner using `SpaceRelativePosition`. This is useful when item coordinates are authored in room-local space (e.g. from a BIM export) without knowing the absolute plan position.

```tsx
// Room "lab-north" is a 10 × 10 m space. Place a marker at its local (5, 5) centre.
const markers: MarkerLayerItem[] = [
  {
    id: 'co2-sensor-lab',
    position: { spaceId: 'lab-north', x: 5, y: 5 },  // room-local offset from bbox min
    shape: 'circle',
    radius: 3,
    fill: '#064e3b',
    stroke: '#34d399',
    tooltip: 'CO₂ sensor',
  },
];

// Place an annotation at the bottom-left of every room (0, 0 in room-local space)
const annotations: AnnotationLayerItem[] = model.spaces.map((space) => ({
  id: `${space.id}-corner`,
  position: { spaceId: space.id, x: 0.5, y: 0.5 },
  text: space.label,
  color: '#334155',
  fontSize: 8,
}));
```

---

### Custom render callback (`CustomLayerItem`)

The `custom` array is an escape hatch for Konva nodes that cannot be expressed as markers or annotations. The component resolves the position to a projected screen XY, then calls `render(projected, scale)`.

> **Note**: `render` receives plan-space XY in `BuildingMap` (no projection) and screen-space XY in `OrthoBuilding` (after orthographic projection). Use the provided `projected` point directly — do **not** hard-code coordinates.

```tsx
import { Circle, Line, Text } from 'react-konva';
import type { CustomLayerItem, LayerDefinition } from './lib';

// Define render functions outside the component or in useCallback to avoid re-renders.
function renderPressureGauge(projected: { x: number; y: number }, scale: number) {
  const r = 6 / scale;
  return (
    <>
      <Circle x={projected.x} y={projected.y} radius={r}
        fill="#1e3a5f" stroke="#7dd3fc" strokeWidth={1.5 / scale} />
      <Line
        points={[projected.x, projected.y, projected.x + r * 0.6, projected.y - r * 0.6]}
        stroke="#f0f9ff" strokeWidth={1.2 / scale} lineCap="round"
      />
      <Text x={projected.x} y={projected.y + r + 2 / scale}
        text="P" fontSize={5 / scale} fill="#7dd3fc"
        offsetX={1.5 / scale} />
    </>
  );
}

const pressureLayer: LayerDefinition = {
  type: 'data',
  id: 'pressureSensors',
  label: 'Pressure',
  color: '#0369a1',
  renderOrder: 'overlay',
  getData: ({ model }) => ({
    custom: model.assets
      .filter((a) => a.brickClass?.includes('Pressure_Sensor'))
      .map<CustomLayerItem>((asset) => ({
        id: asset.id,
        position: asset.position,
        tooltip: `Pressure: ${asset.label}`,
        onClick: () => console.log('pressure sensor', asset.id),
        render: renderPressureGauge,
      })),
  }),
};
```

---

### SPARQL-driven layer

Use `type: 'sparql'` when sensor data is stored in the RDF graph and needs to be queried.

```tsx
const co2Layer: LayerDefinition = {
  type: 'sparql',
  id: 'co2',
  label: 'CO₂ Sensors',
  color: '#4d7c0f',
  renderOrder: 'overlay',
  query: `
    PREFIX brick: <https://brickschema.org/schema/Brick#>
    PREFIX ref:   <https://brickschema.org/schema/Brick/ref#>
    SELECT ?sensor ?label ?space WHERE {
      ?sensor a brick:CO2_Sensor ;
              rdfs:label ?label ;
              brick:isLocatedIn ?space .
    }
  `,
  mapResults: (rows, { model }) => ({
    markers: rows.flatMap((row) => {
      const spaceId = row.space?.value;
      if (!spaceId) return [];
      return [{
        id: row.sensor?.value ?? spaceId,
        position: { spaceId, x: 1, y: 1 },
        shape: 'circle' as const,
        radius: 3,
        fill: '#1a2e05',
        stroke: '#84cc16',
        tooltip: String(row.label?.value ?? 'CO₂ sensor'),
      }];
    }),
  }),
};
```

---

### Data-driven layer with external fetch

Use `type: 'data'` with an `async getData` to pull live readings from an API and overlay them on the map.

```tsx
const liveTemperatureLayer: LayerDefinition = {
  type: 'data',
  id: 'liveTemps',
  label: 'Live Temperatures',
  color: '#b45309',
  renderOrder: 'overlay',
  getData: async ({ model }) => {
    const res = await fetch('/api/sensor-readings?type=temperature');
    const readings: Array<{ spaceId: string; value: number }> = await res.json();

    return {
      spaces: readings.map(({ spaceId, value }) => {
        // Map temperature (15–30 °C) to a red–green colour scale.
        const t = Math.min(1, Math.max(0, (value - 15) / 15));
        const r = Math.round(255 * t);
        const g = Math.round(255 * (1 - t));
        return {
          spaceId,
          fill: `rgb(${r},${g},0)`,
          fillOpacity: 0.4,
        };
      }),
      annotations: readings.map(({ spaceId, value }) => {
        const space = model.spaces.find((s) => s.id === spaceId);
        if (!space) return null!;
        return {
          id: `temp-${spaceId}`,
          position: { spaceId, x: 0.5, y: 0.5 },
          text: `${value.toFixed(1)} °C`,
          color: '#78350f',
          fontSize: 9,
        };
      }).filter(Boolean),
    };
  },
};
```

---

## Render order

| `renderOrder` | BuildingMap (2-D) | OrthoBuilding |
|---|---|---|
| `'floor'` | Drawn before space fills | Floor-plane rings (walls extrude in front) |
| `'walls'` | Drawn after space fills, before assets | Top-face rings on wall caps |
| `'overlay'` | Drawn after all geometry, assets, and annotations | Same, fully on top |

---

## Layer panel

Pass `onLayerToggle` to either component to render the layer panel. The panel only shows external layers and includes loading/error indicators.

```tsx
const [visibleLayers, setVisibleLayers] = useState({
  sensors: true,
  occupancy: false,
});

<BuildingMap
  model={model}
  layers={layers}
  visibleLayers={visibleLayers}
  onLayerToggle={(id) =>
    setVisibleLayers((prev) => ({ ...prev, [id]: !prev[id] }))
  }
/>
```

## Controls layer (built-in UI)

The base floor-plan layer is always visible and cannot be toggled.

The controls layer is built in and configured via the `controls` prop (not via `visibleLayers`).

Enable all built-in controls:

```tsx
<BuildingMap
  model={model}
  controls={{
    enabled: true,
    zoomToFit: true,
    fullScreen: true,
    layerPanel: true,
    compass: true,
  }}
/>
```

Disable one control while keeping the rest enabled:

```tsx
<OrthoBuilding
  model={model}
  controls={{
    enabled: true,
    zoomToFit: true,
    fullScreen: true,
    layerPanel: true,
    compass: false,
  }}
/>
```

Defaults when `controls` is omitted:
- `enabled: true`
- `compass: true`
- `zoomToFit` / `fullScreen`: follow `showControls`
- `layerPanel`: enabled when `onLayerToggle` is provided

- `enabled`: master switch for all built-in control widgets.
- `zoomToFit` / `fullScreen`: left-side action buttons.
- `layerPanel`: external-layer toggle panel.
- `compass`: north compass.

Compatibility note: `showControls` still works as a shorthand for `zoomToFit` + `fullScreen` defaults.

---

## Key files

| File | Purpose |
|---|---|
| [src/lib/types.ts](src/lib/types.ts) | Canonical model, layer, and positioning types |
| [src/lib/geometryUtils.ts](src/lib/geometryUtils.ts) | `resolveLayerPosition`, bounding-box, centroid helpers |
| [src/lib/geometryProfile.ts](src/lib/geometryProfile.ts) | Profile schema, parsing, coordinate normalization |
| [src/lib/brickRecAdapter.ts](src/lib/brickRecAdapter.ts) | BRICK/REC → `CanonicalBuildingMapModel` |
| [src/lib/BuildingMap.tsx](src/lib/BuildingMap.tsx) | 2-D floor-plan renderer |
| [src/lib/OrthoBuilding.tsx](src/lib/OrthoBuilding.tsx) | Isometric-ortho renderer |
| [src/lib/index.ts](src/lib/index.ts) | Public API exports |
| [src/App.tsx](src/App.tsx) | Demo harness with live sensor, HVAC, and room-metrics layers |
