import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import {
  BuildingMap,
  OrthoBuilding,
  HVACMap,
  parseBrickRecSource,
  parseGeometryProfile,
  loadBrickRecFromJsonLd,
  loadBrickRecFromTurtle,
} from './lib';
import type { BrickRecSource, CanonicalBuildingMapModel, LayerDefinition, MarkerLayerItem } from './lib';
import { isSensorAsset, isHvacAsset } from './lib/assetClassifiers';
import { computeSpaceMetrics, centroidOfRing, getPrimaryRing } from './lib/geometryUtils';
import {
  geometryProfiles,
  sampleBrickRecSource,
  sampleBrickTurtle,
} from './lib/sampleData.ts';

function makeSpaceRelativeMarkerFixture(model: CanonicalBuildingMapModel): MarkerLayerItem[] {
  const rooms = model.spaces.slice(0, 3);
  return rooms.flatMap((space, roomIndex) => {
    const ring = getPrimaryRing(space);
    const xs = ring.map((p) => p.x);
    const ys = ring.map((p) => p.y);
    const minX = xs.length > 0 ? Math.min(...xs) : 0;
    const maxX = xs.length > 0 ? Math.max(...xs) : 0;
    const minY = ys.length > 0 ? Math.min(...ys) : 0;
    const maxY = ys.length > 0 ? Math.max(...ys) : 0;
    const width = Math.max(1, maxX - minX);
    const height = Math.max(1, maxY - minY);
    const centerLocal = { x: width * 0.5, y: height * 0.5 };
    const boundaryLocal = { x: Math.max(0.2, width * 0.85), y: Math.max(0.2, height * 0.85) };

    const exactSpaceId = space.id;
    const centerPosition: { spaceId: string; x: number; y: number } = {
      spaceId: exactSpaceId,
      x: centerLocal.x,
      y: centerLocal.y,
    };

    const boundaryPosition: { spaceId: string; x: number; y: number } = {
      spaceId: exactSpaceId,
      x: boundaryLocal.x,
      y: boundaryLocal.y,
    };

    const imagePosition: { spaceId: string; x: number; y: number } = {
      spaceId: exactSpaceId,
      x: Math.max(0.8, width * 0.2),
      y: Math.max(0.8, height * 0.2),
    };

    return [
      {
        id: `fixture-center-${roomIndex + 1}`,
        position: centerPosition,
        fill: '#1d4ed8',
        stroke: '#bfdbfe',
        radius: 5,
        icon: 'C',
        iconColor: '#dbeafe',
        label: `${space.label} center`,
        tooltip: `center marker\nspaceId=${centerPosition.spaceId}`,
      },
      {
        id: `fixture-boundary-${roomIndex + 1}`,
        position: boundaryPosition,
        fill: '#7c2d12',
        stroke: '#fdba74',
        radius: 5,
        icon: {
          kind: 'svg-path',
          path: 'M12 2 L20 12 L12 22 L4 12 Z',
          viewBoxWidth: 24,
          viewBoxHeight: 24,
          width: 10,
          height: 10,
        },
        iconColor: '#ffedd5',
        label: `${space.label} boundary`,
        tooltip: `boundary marker\nspaceId=${boundaryPosition.spaceId}`,
      },
      {
        id: `fixture-image-${roomIndex + 1}`,
        position: imagePosition,
        fill: '#14532d',
        stroke: '#86efac',
        radius: 5,
        icon: {
          kind: 'image',
          url: '/favicon.svg',
          width: 12,
          height: 12,
        },
        iconColor: '#dcfce7',
        label: `${space.label} image`,
        tooltip: `image marker\nspaceId=${imagePosition.spaceId}`,
      },
    ];
  });
}

function App() {
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | undefined>();
  const [selectedProfileKey, setSelectedProfileKey] = useState('localMetersYDown');
  const [resetToken, setResetToken] = useState(0);
  const [viewportLabel, setViewportLabel] = useState('x:0 y:0 z:1');
  const [sourceType, setSourceType] = useState<'fixture' | 'turtle' | 'jsonld'>('jsonld');
  const [mapView, setMapView] = useState<'plan' | 'ortho'>('plan');
  const [loadedSource, setLoadedSource] = useState<BrickRecSource | null>(null);
  const [loadedSourceType, setLoadedSourceType] = useState<'turtle' | 'jsonld' | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [turtleUrl, setTurtleUrl] = useState('https://brickschema.org/ttl/mortar/bldg1.ttl');
  const [mapSize, setMapSize] = useState({ width: 960, height: 560 });
  const [showDualMaps, setShowDualMaps] = useState(
    typeof window !== 'undefined' ? window.innerWidth > 1200 : false,
  );
  const [visibleLayers, setVisibleLayers] = useState<Record<string, boolean>>({
    fixtureOverlay: true,
    fixtureWalls: true,
    sensors: false,
    hvac: false,
    roomMetrics: false,
  });

  const layerDefinitions = useMemo<LayerDefinition[]>(() => [
    {
      id: 'fixtureOverlay',
      label: 'Fixture Markers Overlay',
      color: '#1d4ed8',
      renderOrder: 'overlay',
      getData: ({ model }) => ({
        markers: makeSpaceRelativeMarkerFixture(model),
      }),
    },
    {
      id: 'fixtureWalls',
      label: 'Fixture Markers Walls',
      color: '#7c2d12',
      renderOrder: 'walls',
      getData: ({ model }) => ({
        markers: makeSpaceRelativeMarkerFixture(model),
      }),
    },
    {
      id: 'sensors',
      label: 'Sensors',
      color: '#0b3b6f',
      renderOrder: 'overlay',
      getData: ({ model }) => ({
        markers: model.assets
          .filter(isSensorAsset)
          .map((asset) => ({
            id: asset.id,
            position: asset.position ?? { x: 0, y: 0 },
            fill: '#1e3a5f',
            stroke: '#38bdf8',
            radius: 4,
            icon: '⚡',
            iconColor: '#bae6fd',
            label: asset.label,
            tooltip: [
              asset.label,
              asset.brickClass ? asset.brickClass.split('/').pop()?.replace(/_/g, ' ') ?? '' : '',
            ].filter(Boolean).join('\n'),
          }))
          .filter((m) => m.position.x !== 0 || m.position.y !== 0),
      }),
    },
    {
      id: 'hvac',
      label: 'HVAC',
      color: '#7c2d12',
      renderOrder: 'overlay',
      getData: ({ model }) => ({
        markers: model.assets
          .filter(isHvacAsset)
          .map((asset) => ({
            id: asset.id,
            position: asset.position ?? { x: 0, y: 0 },
            fill: '#431407',
            stroke: '#fb923c',
            radius: 5,
            icon: '⬡',
            iconColor: '#fed7aa',
            label: asset.label,
            tooltip: [
              asset.label,
              asset.brickClass ? asset.brickClass.split('/').pop()?.replace(/_/g, ' ') ?? '' : '',
            ].filter(Boolean).join('\n'),
          }))
          .filter((m) => m.position.x !== 0 || m.position.y !== 0),
      }),
    },
    {
      id: 'roomMetrics',
      label: 'Room Metrics',
      color: '#1e40af',
      renderOrder: 'overlay',
      getData: ({ model }) => ({
        annotations: model.spaces.flatMap((space) => {
          const { area, width, height: spaceH } = computeSpaceMetrics(space);
          if (area < 0.01) return [];
          const ring = getPrimaryRing(space);
          const centroid = centroidOfRing(ring);
          const lines = [
            `${width.toFixed(1)} × ${spaceH.toFixed(1)}`,
            `${area.toFixed(1)} m²`,
          ];
          const volumeRaw = space.metadata?.volume;
          if (typeof volumeRaw === 'number') lines.push(`${volumeRaw.toFixed(1)} m³`);
          return lines.map((text, i) => ({
            id: `${space.id}-metric-${i}`,
            position: { x: centroid.x, y: centroid.y + (i + 1) * 11 },
            text,
            color: '#1e40af',
            fontSize: 9,
          }));
        }),
      }),
    },
  ], []);
  const mapPanelRef = useRef<HTMLElement | null>(null);

  const toggleLayer = (id: string) =>
    setVisibleLayers((prev) => ({ ...prev, [id]: !prev[id] }));

  const profile = useMemo(
    () => parseGeometryProfile(geometryProfiles[selectedProfileKey]),
    [selectedProfileKey],
  );

  const source =
    sourceType !== 'fixture' && loadedSource && loadedSourceType === sourceType
      ? loadedSource
      : sampleBrickRecSource;

  const parsed = useMemo(() => parseBrickRecSource(source, profile), [source, profile]);

  const handleLoadTurtle = async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const result = await loadBrickRecFromTurtle(sampleBrickTurtle, 'bldg-emerald');
      setLoadedSource(result);
      setLoadedSourceType('turtle');
      setSourceType('turtle');
      setResetToken((v) => v + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setLoadError(message);
      setSourceType('fixture');
    } finally {
      setIsLoading(false);
    }
  };

  const handleLoadJsonLd = async () => {
    setIsLoading(true);
    setLoadError(null);
    try {
      const response = await fetch('/data/building-1.flat.jsonld');
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const jsonLdContent = await response.json();
      const result = await loadBrickRecFromJsonLd(jsonLdContent, 'building-1-flat-jsonld');
      setLoadedSource(result);
      setLoadedSourceType('jsonld');
      setSourceType('jsonld');
      setResetToken((v) => v + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setLoadError(message);
      setSourceType('fixture');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    void handleLoadJsonLd();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (typeof window === 'undefined') {
      return;
    }

    const handleResize = () => {
      setShowDualMaps(window.innerWidth > 1200);
    };

    handleResize();
    window.addEventListener('resize', handleResize);
    return () => window.removeEventListener('resize', handleResize);
  }, []);

  useEffect(() => {
    const host = mapPanelRef.current;
    if (!host || typeof ResizeObserver === 'undefined') {
      return;
    }

    const resize = (nextWidth: number) => {
      const safeWidth = Math.max(320, Math.floor(nextWidth));
      const mapWidth = showDualMaps
        ? Math.max(300, Math.floor((safeWidth - 16) / 2))
        : safeWidth;
      const nextHeight = Math.max(360, Math.min(760, Math.round(mapWidth * 0.62)));
      setMapSize({ width: safeWidth, height: nextHeight });
    };

    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (!entry) {
        return;
      }
      resize(entry.contentRect.width);
    });

    observer.observe(host);
    resize(host.getBoundingClientRect().width);

    return () => observer.disconnect();
  }, [showDualMaps]);

  const mapRenderWidth = showDualMaps
    ? Math.max(300, Math.floor((mapSize.width - 16) / 2))
    : mapSize.width;

  const handleLoadTurtleFromUrl = async () => {
    if (!turtleUrl.trim()) {
      setLoadError('Please enter a valid URL');
      return;
    }

    setIsLoading(true);
    setLoadError(null);
    try {
      const response = await fetch(turtleUrl);
      if (!response.ok) {
        throw new Error(`HTTP ${response.status}: ${response.statusText}`);
      }

      const turtleContent = await response.text();
      const urlBuildingId =
        new URL(turtleUrl).pathname.split('/').pop()?.replace('.ttl', '') || 'bldg-external';
      const result = await loadBrickRecFromTurtle(turtleContent, urlBuildingId);
      setLoadedSource(result);
      setLoadedSourceType('turtle');
      setSourceType('turtle');
      setResetToken((v) => v + 1);
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Unknown error';
      setLoadError(message);
      setSourceType('fixture');
    } finally {
      setIsLoading(false);
    }
  };

  return (
    <main className="app-shell">
      <header className="app-header">
        <h1>react-brick-map</h1>
        <p>
          BRICK and REC ready canvas map with profile-driven geometry normalization,
          runtime profile switching, and interactive pan/zoom.
        </p>
        <div className="controls-row">
          <label htmlFor="profile-select">Geometry profile</label>
          <select
            id="profile-select"
            value={selectedProfileKey}
            onChange={(event) => {
              setSelectedProfileKey(event.target.value);
              setResetToken((value) => value + 1);
            }}
          >
            {Object.keys(geometryProfiles).map((key) => (
              <option key={key} value={key}>
                {key}
              </option>
            ))}
          </select>
          <button type="button" onClick={() => setResetToken((value) => value + 1)}>
            Zoom to fit
          </button>
        </div>
        <div className="controls-row">
          <label htmlFor="map-view-select">Map view</label>
          <select
            id="map-view-select"
            value={mapView}
            onChange={(event) => {
              setMapView(event.target.value as 'plan' | 'ortho');
              setResetToken((value) => value + 1);
            }}
          >
            <option value="plan">2D Plan</option>
            <option value="ortho">2.5D Ortho</option>
          </select>
        </div>
        <div className="controls-row">
          <label htmlFor="source-select">Data source</label>
          <select
            id="source-select"
            value={sourceType}
            onChange={(event) => {
              setSourceType(event.target.value as 'fixture' | 'turtle' | 'jsonld');
              setResetToken((value) => value + 1);
            }}
          >
            <option value="fixture">TypeScript Fixture</option>
            <option value="turtle">BRICK Turtle (RDF)</option>
            <option value="jsonld">BRICK JSON-LD (Canonical)</option>
          </select>
          <button type="button" onClick={handleLoadTurtle} disabled={isLoading}>
            {isLoading && sourceType === 'turtle' ? 'Loading...' : 'Load Turtle'}
          </button>
          <button type="button" onClick={() => void handleLoadJsonLd()} disabled={isLoading}>
            {isLoading && sourceType === 'jsonld' ? 'Loading...' : 'Load JSON-LD'}
          </button>
        </div>
        <div className="controls-row">
          <label htmlFor="turtle-url-input">Load Turtle from URL</label>
          <input
            id="turtle-url-input"
            type="url"
            placeholder="https://example.org/data.ttl"
            value={turtleUrl}
            onChange={(e) => setTurtleUrl(e.target.value)}
            disabled={isLoading}
          />
          <button type="button" onClick={handleLoadTurtleFromUrl} disabled={isLoading}>
            {isLoading ? 'Loading...' : 'Load URL'}
          </button>
        </div>
      </header>

      <section className="map-panel" ref={mapPanelRef}>
        <div className={showDualMaps ? 'map-compare-grid' : undefined}>
          {(showDualMaps || mapView === 'plan') ? (
            <div className={showDualMaps ? 'map-compare-cell' : undefined}>
              <BuildingMap
                model={parsed.model}
                width={mapRenderWidth}
                height={mapSize.height}
                controls={{
                  enabled: true,
                  zoomToFit: true,
                  fullScreen: true,
                  layerPanel: true,
                }}
                northDirectionDegrees={profile.northDirectionDegrees}
                selectedSpaceId={selectedSpaceId}
                resetToken={resetToken}
                layers={layerDefinitions}
                visibleLayers={visibleLayers}
                onLayerToggle={toggleLayer}
                onViewportChange={(viewport) => {
                  setViewportLabel(
                    `x:${viewport.x.toFixed(1)} y:${viewport.y.toFixed(1)} z:${viewport.scale.toFixed(2)}`,
                  );
                }}
                onSpaceClick={(space) => setSelectedSpaceId(space.id)}
                onAssetClick={(asset) => {
                  setSelectedSpaceId(asset.spaceId);
                }}
              />
            </div>
          ) : null}

          {(showDualMaps || mapView === 'ortho') ? (
            <div className={showDualMaps ? 'map-compare-cell' : undefined}>
              <OrthoBuilding
                model={parsed.model}
                width={mapRenderWidth}
                height={mapSize.height}
                controls={{
                  enabled: true,
                  zoomToFit: true,
                  fullScreen: true,
                  layerPanel: true,
                }}
                northDirectionDegrees={profile.northDirectionDegrees}
                selectedSpaceId={selectedSpaceId}
                resetToken={resetToken}
                layers={layerDefinitions}
                visibleLayers={visibleLayers}
                onLayerToggle={toggleLayer}
                onViewportChange={(viewport) => {
                  setViewportLabel(
                    `x:${viewport.x.toFixed(1)} y:${viewport.y.toFixed(1)} z:${viewport.scale.toFixed(2)}`,
                  );
                }}
                onSpaceClick={(space) => setSelectedSpaceId(space.id)}
                onAssetClick={(asset) => {
                  setSelectedSpaceId(asset.spaceId);
                }}
              />
            </div>
          ) : null}
        </div>
      </section>

      <section className="map-panel hvac-panel">
        <div className="panel-title">HVAC Topology Map</div>
        <HVACMap
          source={source}
          width={Math.max(320, mapSize.width)}
          height={420}
          onAssetClick={(assetId) => {
            const matched = (source.assets ?? []).find((asset) => asset.id === assetId);
            if (matched?.spaceId) {
              setSelectedSpaceId(matched.spaceId);
            }
          }}
        />
      </section>

      <section className="info-grid">
        <article>
          <h2>Geometry Profile</h2>
          <p>Name: {profile.profileName}</p>
          <p>Axis: {profile.axisOrder}</p>
          <p>Y direction: {profile.yAxisDirection}</p>
          <p>North: {profile.northDirectionDegrees}° clockwise from up</p>
          <p>Units: {profile.units}</p>
        </article>

        <article>
          <h2>Interaction</h2>
          <p>Selected space: {selectedSpaceId ?? 'None'}</p>
          <p>Viewport: {viewportLabel}</p>
          <p>
            Source:{' '}
            {sourceType === 'turtle'
              ? 'BRICK Turtle (RDF)'
              : sourceType === 'jsonld'
                ? 'BRICK JSON-LD (Canonical)'
                : 'TypeScript Fixture'}
          </p>
          <p>View: {showDualMaps ? '2D + 2.5D side by side' : mapView === 'ortho' ? '2.5D Ortho' : '2D Plan'}</p>
          <p>Use mouse wheel to zoom and drag to pan.</p>
        </article>

        <article>
          <h2>Diagnostics</h2>
          {loadError && (
            <div style={{ color: '#dc2626', marginBottom: '0.5rem' }}>
              <strong>Parse Error:</strong> {loadError}
            </div>
          )}
          {parsed.diagnostics.length === 0 ? (
            <p>No warnings or errors.</p>
          ) : (
            <ul>
              {parsed.diagnostics.map((item) => (
                <li key={`${item.code}:${item.path ?? 'root'}`}>
                  [{item.level}] {item.code}: {item.message}
                </li>
              ))}
            </ul>
          )}
        </article>
      </section>
    </main>
  );
}

export default App;
