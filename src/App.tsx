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

const DEMO_ROOM_IDS = [
  'urn:demo:space:ccspace-room-1',
  'urn:demo:space:ccspace-room-2',
  'urn:demo:space:ccspace-room-3',
  'urn:demo:space:ccspace-room-4',
];

function makeRoomBottomRightIconMarkers(model: CanonicalBuildingMapModel): MarkerLayerItem[] {
  const markers: MarkerLayerItem[] = [];
  const iconSize = 30;

  for (const spaceId of DEMO_ROOM_IDS) {
    const space = model.spaces.find((s) => s.id === spaceId);
    if (!space) {
      continue;
    }

    const ring = getPrimaryRing(space);
    const xs = ring.map((p) => p.x);
    const ys = ring.map((p) => p.y);
    const width = xs.length > 1 ? Math.max(...xs) - Math.min(...xs) : 0;
    const height = ys.length > 1 ? Math.max(...ys) - Math.min(...ys) : 0;

    const offsetX = width * 0.85;
    const offsetY = height * 0.85;

    markers.push({
      id: `room-bottom-right-${space.id}`,
      position: { spaceId: space.id, x: offsetX, y: offsetY },
      fill: 'transparent',
      stroke: 'transparent',
      radius: 0,
      icon: {
        kind: 'svg-path',
        path: 'M12 4a2 2 0 1 1 0 4 2 2 0 0 1 0-4zm0 5c-2.67 0-8 1.34-8 4v1h16v-1c0-2.66-5.33-4-8-4z',
        viewBoxWidth: 24,
        viewBoxHeight: 24,
        width: iconSize,
        height: iconSize,
      },
      iconColor: '#1e3a8a',
      label: space.label,
      tooltip: `${space.label}\nspaceId=${space.id}`,
    });
  }

  return markers;
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
    roomCornerIcons: true,
    sensors: false,
    hvac: false,
    roomMetrics: false,
  });

  const layerDefinitions = useMemo<LayerDefinition[]>(() => [
    {
      id: 'roomCornerIcons',
      label: 'Room Bottom-Right Icons',
      color: '#1f2937',
      renderOrder: 'overlay',
      getData: ({ model }) => {
        const markers = makeRoomBottomRightIconMarkers(model);
        console.log('[demo-room-icon] getData called', {
          totalSpaces: model.spaces.length,
          spaceIds: model.spaces.map((s) => s.id),
          markersProduced: markers.length,
        });
        return { markers };
      },
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
