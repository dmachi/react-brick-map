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
import type { BrickRecSource, LayerDefinition } from './lib';
import { isSensorAsset, isHvacAsset } from './lib/assetClassifiers';
import { computeSpaceMetrics, centroidOfRing, getPrimaryRing } from './lib/geometryUtils';
import {
  geometryProfiles,
  sampleBrickRecSource,
  sampleBrickTurtle,
} from './lib/sampleData.ts';

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
  const [visibleLayers, setVisibleLayers] = useState<Record<string, boolean>>({
    floorPlan: true,
    sensors: true,
    hvac: true,
    roomMetrics: false,
  });

  const layerDefinitions = useMemo<LayerDefinition[]>(() => [
    {
      type: 'data',
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
      type: 'data',
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
      type: 'data',
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
    const host = mapPanelRef.current;
    if (!host || typeof ResizeObserver === 'undefined') {
      return;
    }

    const resize = (nextWidth: number) => {
      const safeWidth = Math.max(320, Math.floor(nextWidth));
      const nextHeight = Math.max(360, Math.min(760, Math.round(safeWidth * 0.62)));
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
  }, []);

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
        {mapView === 'ortho' ? (
          <OrthoBuilding
            model={parsed.model}
            width={mapSize.width}
            height={mapSize.height}
            showControls
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
        ) : (
          <BuildingMap
            model={parsed.model}
            width={mapSize.width}
            height={mapSize.height}
            showControls
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
        )}
      </section>

      <section className="map-panel hvac-panel">
        <div className="panel-title">HVAC Topology Map</div>
        <HVACMap
          source={source}
          width={mapSize.width}
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
          <p>View: {mapView === 'ortho' ? '2.5D Ortho' : '2D Plan'}</p>
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
