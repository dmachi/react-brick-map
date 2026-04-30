# react-brick-map

Early implementation of a React + Konva building map component designed for BRICK/REC semantic data with configurable geometry normalization.

## Current Scope

- Single-floor 2D rendering
- Space polygons and multipolygons
- Asset markers and labels
- Annotation overlays
- Hover and click interactivity
- Wheel zoom and drag pan interactions
- Runtime profile switching from profile packs
- BRICK/REC source parsing into a canonical runtime model
- Runtime geometry profile parsing and normalization

## Architecture

1. Source layer
   - BRICK/REC source objects with semantic and geometry metadata.
2. Profile layer
   - Declarative geometry profile controls coordinate handling and validation behavior.
3. Adapter layer
   - Source is mapped into canonical entities with diagnostics.
4. Renderer layer
   - React Konva stage renders spaces, assets, and annotations with interaction callbacks.

## Key Files

- `src/lib/types.ts`: canonical model and diagnostics types.
- `src/lib/geometryProfile.ts`: profile schema, parsing, and coordinate normalization.
- `src/lib/brickRecAdapter.ts`: BRICK/REC adapter for canonical model creation.
- `src/lib/BuildingMap.tsx`: core renderer and interaction wiring.
- `src/lib/sampleData.ts`: profile and source fixture used by the demo app.
- `src/App.tsx`: demo harness for selecting spaces and surfacing diagnostics.

## Run

```bash
npm install
npm run dev
```

## Build

```bash
npm run build
```

## Next Implementation Targets

- Add pan/zoom controls and viewport API
- Add hole rendering and richer multipolygon styling
- Add profile packs and runtime profile switching
- Add automated geometry conformance tests
- Add parser support for RDF/Turtle serialized BRICK graphs
