import { useEffect, useMemo, useRef, useState } from 'react';
import './App.css';
import {
  BuildingMap,
  HVACMap,
  parseBrickRecSource,
  parseGeometryProfile,
  loadBrickRecFromJsonLd,
  loadBrickRecFromTurtle,
} from './lib';
import type { BrickRecSource } from './lib';
import type { LayerVisibility } from './lib';
import { DEFAULT_LAYER_VISIBILITY } from './lib';
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
  const [loadedSource, setLoadedSource] = useState<BrickRecSource | null>(null);
  const [loadedSourceType, setLoadedSourceType] = useState<'turtle' | 'jsonld' | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [turtleUrl, setTurtleUrl] = useState('https://brickschema.org/ttl/mortar/bldg1.ttl');
  const [mapSize, setMapSize] = useState({ width: 960, height: 560 });
  const [visibleLayers, setVisibleLayers] = useState<LayerVisibility>(DEFAULT_LAYER_VISIBILITY);
  const mapPanelRef = useRef<HTMLElement | null>(null);

  const toggleLayer = (key: keyof LayerVisibility) =>
    setVisibleLayers((prev) => ({ ...prev, [key]: !prev[key] }));

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
        <BuildingMap
          model={parsed.model}
          width={mapSize.width}
          height={mapSize.height}
          showControls
          northDirectionDegrees={profile.northDirectionDegrees}
          selectedSpaceId={selectedSpaceId}
          resetToken={resetToken}
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
