import type { GeometryProfile } from './geometryProfile';
import type { BrickRecSource } from './brickRecAdapter';

export const geometryProfiles: Record<string, GeometryProfile> = {
  localMetersYUp: {
    profileName: 'brick-rec-local-v1',
    profileVersion: '1.0.0',
    axisOrder: 'xy',
    units: 'meters',
    coordinateSystemAliases: {
      LocalCoordinates: 'LOCAL_METERS',
      LocalPlanCS: 'LOCAL_METERS',
      WGS84: 'EPSG:4326',
    },
    localOrigin: { x: 0, y: 0 },
    yAxisDirection: 'up',
    northDirectionDegrees: 43,
    enforceClosedRings: true,
    validationPolicy: {
      onInvalidRing: 'auto-fix',
      minRingPoints: 4,
      epsilon: 0.000001,
    },
  },
  localMetersYDown: {
    profileName: 'brick-rec-local-v1',
    profileVersion: '1.0.0',
    axisOrder: 'xy',
    units: 'meters',
    coordinateSystemAliases: {
      LocalCoordinates: 'LOCAL_METERS',
      LocalPlanCS: 'LOCAL_METERS',
      WGS84: 'EPSG:4326',
    },
    localOrigin: { x: 0, y: 0 },
    yAxisDirection: 'down',
    northDirectionDegrees: 43,
    enforceClosedRings: true,
    validationPolicy: {
      onInvalidRing: 'auto-fix',
      minRingPoints: 4,
      epsilon: 0.000001,
    },
  },
  shiftedFeetYDown: {
    profileName: 'brick-rec-shifted-feet-v1',
    profileVersion: '1.0.0',
    axisOrder: 'xy',
    units: 'feet',
    coordinateSystemAliases: {
      LocalCoordinates: 'LOCAL_FEET',
      LocalPlanCS: 'LOCAL_FEET',
      WGS84: 'EPSG:4326',
    },
    localOrigin: { x: -10, y: -6 },
    yAxisDirection: 'down',
    northDirectionDegrees: 0,
    enforceClosedRings: true,
    validationPolicy: {
      onInvalidRing: 'warn',
      minRingPoints: 4,
      epsilon: 0.000001,
    },
  },
};

export const defaultGeometryProfile = geometryProfiles.localMetersYDown;

export const sampleBrickRecSource: BrickRecSource = {
  id: 'bldg-01',
  label: 'Atlas Tower',
  floor: {
    id: 'floor-01',
    label: 'Level 1',
    levelIndex: 1,
  },
  spaces: [
    {
      id: 'space-lobby',
      label: 'Lobby',
      brickClass: 'rec:Lobby',
      geometry: {
        type: 'Polygon',
        coordinateSystem: 'LocalCoordinates',
        coordinates: [
          [
            [0, 0],
            [20, 0],
            [20, 10],
            [0, 10],
            [0, 0],
          ],
        ],
      },
    },
    {
      id: 'space-office-a',
      label: 'Office A',
      brickClass: 'rec:Office',
      geometry: {
        type: 'Polygon',
        coordinateSystem: 'LocalCoordinates',
        coordinates: [
          [
            [20, 0],
            [35, 0],
            [35, 8],
            [20, 8],
            [20, 0],
          ],
        ],
      },
    },
    {
      id: 'space-conference',
      label: 'Conference',
      brickClass: 'rec:ConferenceRoom',
      geometry: {
        type: 'Polygon',
        coordinateSystem: 'LocalCoordinates',
        coordinates: [
          [
            [20, 8],
            [35, 8],
            [35, 16],
            [20, 16],
            [20, 8],
          ],
        ],
      },
    },
  ],
  assets: [
    {
      id: 'asset-temp-lobby',
      label: 'Temp-01',
      type: 'sensor',
      brickClass: 'brick:Temperature_Sensor',
      spaceId: 'space-lobby',
      position: [7, 5],
    },
    {
      id: 'asset-co2-conference',
      label: 'CO2-02',
      type: 'sensor',
      brickClass: 'brick:CO2_Sensor',
      spaceId: 'space-conference',
      position: [28, 12],
    },
  ],
  annotations: [
    {
      id: 'ann-lobby',
      targetType: 'space',
      targetId: 'space-lobby',
      label: 'Peak Occupancy Window',
      color: '#9f1239',
    },
    {
      id: 'ann-sensor',
      targetType: 'asset',
      targetId: 'asset-co2-conference',
      label: 'Calibration due',
      color: '#0c4a6e',
    },
  ],
};

/**
 * Sample BRICK/REC ontology data in Turtle format.
 * Demonstrates:
 * - BRICK Space with REC geometry
 * - BRICK Sensors and Equipment
 * - Coordinate system and geometry information
 */
export const sampleBrickTurtle = `
@prefix brick: <https://brickschema.org/schema/Brick#> .
@prefix rec: <https://www.w3.org/2022/rec#> .
@prefix rdfs: <http://www.w3.org/2000/01/rdf-schema#> .
@prefix skos: <http://www.w3.org/2004/02/skos/core#> .
@prefix ex: <http://example.org/bldg/> .

# Building definition
ex:building-01
  a brick:Building ;
  skos:prefLabel "Emerald Plaza" ;
  brick:hasPart ex:floor-01 .

# Floor definition
ex:floor-01
  a brick:Floor ;
  skos:prefLabel "Level 1" ;
  brick:hasPart ex:lobby, ex:office-b, ex:storage .

# Spaces with geometry
ex:lobby
  a brick:Lobby ;
  skos:prefLabel "Central Lobby" ;
  rec:geometry ex:lobby-geom ;
  rdfs:comment "Main entry point with high foot traffic" .

ex:lobby-geom
  a rec:Polygon ;
  rec:coordinateSystem ex:LocalMeters ;
  rec:coordinates "[[0,0],[25,0],[25,15],[0,15],[0,0]]" .

ex:office-b
  a brick:Office ;
  skos:prefLabel "Office B" ;
  rec:geometry ex:office-b-geom .

ex:office-b-geom
  a rec:Polygon ;
  rec:coordinateSystem ex:LocalMeters ;
  rec:coordinates "[[25,0],[40,0],[40,8],[25,8],[25,0]]" .

ex:storage
  a brick:Storage ;
  skos:prefLabel "Storage Room" ;
  rec:geometry ex:storage-geom .

ex:storage-geom
  a rec:Polygon ;
  rec:coordinateSystem ex:LocalMeters ;
  rec:coordinates "[[25,8],[40,8],[40,15],[25,15],[25,8]]" .

# Coordinate system definition
ex:LocalMeters
  a rec:CoordinateSystem ;
  rdfs:label "Local Meters" ;
  rec:axisOrder "XY" ;
  rec:unit "meters" ;
  rec:origin "[0, 0]" ;
  rec:yAxisDirection "down" .

# Sensors in spaces
ex:temp-sensor-01
  a brick:Temperature_Sensor ;
  skos:prefLabel "Lobby Temp" ;
  brick:isLocatedIn ex:lobby ;
  rec:position "[12.5, 7.5]" ;
  rdfs:comment "Main lobby temperature monitoring" .

ex:humidity-sensor-01
  a brick:Humidity_Sensor ;
  skos:prefLabel "Office B Humidity" ;
  brick:isLocatedIn ex:office-b ;
  rec:position "[32.5, 4]" .

ex:co2-sensor-storage
  a brick:CO2_Sensor ;
  skos:prefLabel "Storage CO2" ;
  brick:isLocatedIn ex:storage ;
  rec:position "[32.5, 11.5]" ;
  rdfs:comment "Monitor storage air quality" .

# Equipment
ex:light-control-01
  a brick:Lighting_System ;
  skos:prefLabel "Lobby Lights" ;
  brick:isLocatedIn ex:lobby ;
  brick:controls ex:light-panel-lobby .

ex:light-panel-lobby
  a brick:Luminaire ;
  skos:prefLabel "Light Panel A" .

ex:hvac-damper-office
  a brick:Damper ;
  skos:prefLabel "Office B Damper" ;
  brick:isLocatedIn ex:office-b ;
  brick:isPartOf ex:hvac-zone-1 .

ex:hvac-zone-1
  a brick:HVAC_Zone ;
  skos:prefLabel "Zone 1 (East Wing)" ;
  brick:hasPart ex:hvac-damper-office .
`;

/**
 * Sample BRICK/REC ontology data in JSON-LD format.
 * JSON-LD is the canonical JSON-based serialization format for BRICK Schema.
 * This format ensures interoperability and semantic consistency across tools.
 * 
 * Demonstrates:
 * - @context with BRICK and REC prefixes
 * - Building with hasPart hierarchy
 * - Spaces with REC geometry (Polygon)
 * - Equipment and Sensors with positions
 * - Labels and comments for annotations
 */
export const sampleBrickJsonLd = {
  "@context": {
    "@vocab": "https://brickschema.org/schema/Brick#",
    "rec": "https://www.w3.org/2022/rec#",
    "rdfs": "http://www.w3.org/2000/01/rdf-schema#",
    "skos": "http://www.w3.org/2004/02/skos/core#",
  },
  "@type": "Building",
  "@id": "http://example.org/bldg/emerald-plaza",
  "label": "Emerald Plaza",
  "hasPart": [
    {
      "@type": "Floor",
      "@id": "http://example.org/bldg/floor-02",
      "label": "Level 2",
      "hasPart": [
        {
          "@type": "Space",
          "@id": "http://example.org/bldg/space-atrium",
          "label": "Central Atrium",
          "rdfs:comment": "Multi-story atrium with skylights",
          "rec:geometry": {
            "@type": "rec:Polygon",
            "rec:coordinateSystem": "LocalMeters",
            "rec:coordinates": "[[5,5],[35,5],[35,25],[5,25],[5,5]]",
          },
        },
        {
          "@type": "Office",
          "@id": "http://example.org/bldg/space-corner-office",
          "label": "Corner Office",
          "rec:geometry": {
            "@type": "rec:Polygon",
            "rec:coordinateSystem": "LocalMeters",
            "rec:coordinates": "[[35,15],[50,15],[50,25],[35,25],[35,15]]",
          },
        },
        {
          "@type": "ConferenceRoom",
          "@id": "http://example.org/bldg/space-boardroom",
          "label": "Executive Boardroom",
          "rdfs:comment": "Reserved for senior staff meetings",
          "rec:geometry": {
            "@type": "rec:Polygon",
            "rec:coordinateSystem": "LocalMeters",
            "rec:coordinates": "[[35,5],[50,5],[50,15],[35,15],[35,5]]",
          },
        },
      ],
    },
    {
      "@type": "Temperature_Sensor",
      "@id": "http://example.org/bldg/sensor-atrium-temp",
      "label": "Atrium Temperature Sensor",
      "isLocatedIn": "http://example.org/bldg/space-atrium",
      "rec:position": "[20, 15]",
      "rdfs:comment": "Monitors ambient temperature in multi-story space",
    },
    {
      "@type": "Humidity_Sensor",
      "@id": "http://example.org/bldg/sensor-corner-humidity",
      "label": "Corner Office Humidity",
      "isLocatedIn": "http://example.org/bldg/space-corner-office",
      "rec:position": "[42.5, 20]",
    },
    {
      "@type": "CO2_Sensor",
      "@id": "http://example.org/bldg/sensor-boardroom-co2",
      "label": "Boardroom Air Quality Monitor",
      "isLocatedIn": "http://example.org/bldg/space-boardroom",
      "rec:position": "[42.5, 10]",
      "rdfs:comment": "Ensures conference room air quality for meetings",
    },
    {
      "@type": "Lighting_System",
      "@id": "http://example.org/bldg/lights-atrium",
      "label": "Atrium Lighting Network",
      "isLocatedIn": "http://example.org/bldg/space-atrium",
      "controls": "http://example.org/bldg/luminaire-atrium-panel",
    },
    {
      "@type": "Luminaire",
      "@id": "http://example.org/bldg/luminaire-atrium-panel",
      "label": "LED Panel Array A",
    },
  ],
};

export const sampleBrickJsonLdGraph = {
  "@context": {
    "@vocab": "https://brickschema.org/schema/Brick#",
    "rec": "https://www.w3.org/2022/rec#",
    "rdfs": "http://www.w3.org/2000/01/rdf-schema#"
  },
  "@graph": [
    {
      "@id": "http://example.org/graph/building-01",
      "@type": "Building",
      "rdfs:label": "Cedar Center",
      "hasPart": [
        { "@id": "http://example.org/graph/floor-01" },
        { "@id": "http://example.org/graph/sensor-01" },
        { "@id": "http://example.org/graph/sensor-02" }
      ]
    },
    {
      "@id": "http://example.org/graph/floor-01",
      "@type": "Floor",
      "rdfs:label": "Level 1",
      "hasPart": [
        { "@id": "http://example.org/graph/space-lobby" },
        { "@id": "http://example.org/graph/space-office" }
      ]
    },
    {
      "@id": "http://example.org/graph/space-lobby",
      "@type": "Lobby",
      "rdfs:label": "Main Lobby",
      "rec:geometry": { "@id": "http://example.org/graph/geom-lobby" },
      "rdfs:comment": "Primary entrance and waiting area"
    },
    {
      "@id": "http://example.org/graph/space-office",
      "@type": "Office",
      "rdfs:label": "Operations Office",
      "rec:geometry": { "@id": "http://example.org/graph/geom-office" }
    },
    {
      "@id": "http://example.org/graph/geom-lobby",
      "@type": "rec:Polygon",
      "rec:coordinateSystem": "LocalMeters",
      "rec:coordinates": "[[0,0],[18,0],[18,10],[0,10],[0,0]]"
    },
    {
      "@id": "http://example.org/graph/geom-office",
      "@type": "rec:Polygon",
      "rec:coordinateSystem": "LocalMeters",
      "rec:coordinates": "[[18,0],[34,0],[34,10],[18,10],[18,0]]"
    },
    {
      "@id": "http://example.org/graph/sensor-01",
      "@type": "Temperature_Sensor",
      "rdfs:label": "Lobby Temperature",
      "isLocatedIn": { "@id": "http://example.org/graph/space-lobby" },
      "rec:position": "[8, 5]"
    },
    {
      "@id": "http://example.org/graph/sensor-02",
      "@type": "CO2_Sensor",
      "rdfs:label": "Office CO2",
      "isLocatedIn": { "@id": "http://example.org/graph/space-office" },
      "rec:position": "[26, 5]",
      "rdfs:comment": "Monitor indoor air quality"
    }
  ]
};


