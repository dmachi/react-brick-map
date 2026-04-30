import fs from 'node:fs';

const filePath = process.argv[2] ?? 'public/data/building-1.flat.jsonld';
const data = JSON.parse(fs.readFileSync(filePath, 'utf8'));

const REC_NS = ['https://w3id.org/rec#', 'https://www.w3.org/2022/rec#'];
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';
const BRICK_IS_LOCATED_IN = 'https://brickschema.org/schema/Brick#isLocatedIn';

const nodeIndex = new Map(data.map((node) => [node['@id'], node]));

const getValues = (node, key) => (Array.isArray(node?.[key]) ? node[key] : []);
const getRef = (value) => (value && typeof value === 'object' ? value['@id'] : undefined);
const getLiteral = (value) =>
  value && typeof value === 'object' && Object.hasOwn(value, '@value') ? value['@value'] : undefined;
const localName = (value = '') => value.split('#').pop().split('/').pop();
const typeNames = (node) => (Array.isArray(node?.['@type']) ? node['@type'].map(localName) : []);

function parseCoordsLiteral(value) {
  const lit = getLiteral(value);
  if (typeof lit !== 'string') return undefined;
  try {
    return JSON.parse(lit);
  } catch {
    return undefined;
  }
}

function getGeometryNode(node) {
  for (const ns of REC_NS) {
    const ref = getRef(getValues(node, `${ns}geometry`)[0]);
    if (ref && nodeIndex.has(ref)) {
      return nodeIndex.get(ref);
    }
  }
  return undefined;
}

function getLocatedIn(node) {
  for (const ns of REC_NS) {
    const ref = getRef(getValues(node, `${ns}isLocatedIn`)[0]);
    if (ref) return ref;
  }
  return getRef(getValues(node, BRICK_IS_LOCATED_IN)[0]);
}

function getLabel(node) {
  const label = getLiteral(getValues(node, RDFS_LABEL)[0]);
  if (typeof label === 'string' && label.trim()) return label;
  return localName(node['@id'] || 'unknown');
}

function isSpaceNode(node) {
  const types = typeNames(node).map((t) => t.toLowerCase());
  return types.some(
    (t) =>
      t.includes('space') ||
      t.includes('room') ||
      t === 'office' ||
      t === 'lobby' ||
      t === 'storage' ||
      t === 'corridor' ||
      t === 'bathroom' ||
      t === 'kitchen' ||
      t === 'plenum',
  );
}

function isSensorOrEquipmentNode(node) {
  const types = typeNames(node).map((t) => t.toLowerCase());
  return types.some(
    (t) =>
      t.includes('sensor') ||
      t.includes('equipment') ||
      t.includes('asset') ||
      t.includes('actuator') ||
      t.includes('vav') ||
      t.includes('grille') ||
      t.includes('diffuser') ||
      t.includes('damper') ||
      t.includes('ahu') ||
      t.includes('exchanger'),
  );
}

function getSpaceRings(spaceNode) {
  const geom = getGeometryNode(spaceNode);
  if (!geom) return undefined;

  const geomTypes = typeNames(geom).map((t) => t.toLowerCase());
  const coordsValue = REC_NS.map((ns) => getValues(geom, `${ns}coordinates`)[0]).find((v) => v !== undefined);

  const parsed = parseCoordsLiteral(coordsValue);
  if (!Array.isArray(parsed)) return undefined;

  if (geomTypes.some((t) => t.includes('multipolygon'))) {
    const polygons = parsed;
    if (!Array.isArray(polygons[0])) return undefined;
    return polygons.flatMap((polygon) => {
      if (!Array.isArray(polygon)) return [];
      const outer = polygon[0];
      return Array.isArray(outer) ? [outer] : [];
    });
  }

  if (!Array.isArray(parsed[0])) return undefined;
  if (Array.isArray(parsed[0][0])) {
    return [parsed[0]];
  }
  return [parsed];
}

function getAssetPoint(node) {
  for (const ns of REC_NS) {
    const posValue = getValues(node, `${ns}position`)[0];
    const parsedPos = parseCoordsLiteral(posValue);
    if (Array.isArray(parsedPos) && parsedPos.length >= 2) {
      return { x: Number(parsedPos[0]), y: Number(parsedPos[1]) };
    }
  }

  const geom = getGeometryNode(node);
  if (!geom) return undefined;
  const geomTypes = typeNames(geom).map((t) => t.toLowerCase());
  if (!geomTypes.some((t) => t.includes('point'))) return undefined;

  const coordsValue = REC_NS.map((ns) => getValues(geom, `${ns}coordinates`)[0]).find((v) => v !== undefined);
  const parsed = parseCoordsLiteral(coordsValue);
  if (Array.isArray(parsed) && parsed.length >= 2) {
    return { x: Number(parsed[0]), y: Number(parsed[1]) };
  }
  return undefined;
}

function pointInRing(point, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = Number(ring[i][0]);
    const yi = Number(ring[i][1]);
    const xj = Number(ring[j][0]);
    const yj = Number(ring[j][1]);

    const intersects =
      yi > point.y !== yj > point.y &&
      point.x < ((xj - xi) * (point.y - yi)) / ((yj - yi) || 1e-12) + xi;
    if (intersects) inside = !inside;
  }
  return inside;
}

const spaces = new Map();
for (const node of data) {
  if (!isSpaceNode(node)) continue;
  const rings = getSpaceRings(node);
  if (!rings || rings.length === 0) continue;
  spaces.set(node['@id'], {
    id: node['@id'],
    label: getLabel(node),
    rings,
  });
}

const diagnostics = [];
let totalChecked = 0;
let insideCount = 0;
let outsideCount = 0;
let missingSpaceCount = 0;
let missingPointCount = 0;

for (const node of data) {
  if (!isSensorOrEquipmentNode(node)) continue;

  const spaceId = getLocatedIn(node);
  if (!spaceId) continue;

  totalChecked += 1;
  const space = spaces.get(spaceId);
  const entityLabel = getLabel(node);
  const typeLabel = typeNames(node).join('|') || 'unknown-type';

  if (!space) {
    missingSpaceCount += 1;
    diagnostics.push({
      status: 'missing-space',
      id: node['@id'],
      label: entityLabel,
      type: typeLabel,
      spaceId,
      spaceLabel: null,
      point: null,
    });
    continue;
  }

  const point = getAssetPoint(node);
  if (!point || !Number.isFinite(point.x) || !Number.isFinite(point.y)) {
    missingPointCount += 1;
    diagnostics.push({
      status: 'missing-point',
      id: node['@id'],
      label: entityLabel,
      type: typeLabel,
      spaceId,
      spaceLabel: space.label,
      point: null,
    });
    continue;
  }

  const inside = space.rings.some((ring) => pointInRing(point, ring));
  if (inside) {
    insideCount += 1;
  } else {
    outsideCount += 1;
    diagnostics.push({
      status: 'outside-space',
      id: node['@id'],
      label: entityLabel,
      type: typeLabel,
      spaceId,
      spaceLabel: space.label,
      point,
    });
  }
}

console.log('=== Space Membership Diagnostic ===');
console.log('File:', filePath);
console.log('Spaces with polygon geometry:', spaces.size);
console.log('Entities checked (sensor/equipment with isLocatedIn):', totalChecked);
console.log('Inside assigned space:', insideCount);
console.log('Outside assigned space:', outsideCount);
console.log('Missing assigned space geometry:', missingSpaceCount);
console.log('Missing usable point geometry/position:', missingPointCount);

if (diagnostics.length) {
  console.log('\n--- Problem Cases ---');
  for (const d of diagnostics) {
    const pointText = d.point ? `[${d.point.x}, ${d.point.y}]` : 'n/a';
    console.log(`${d.status}\t${d.label}\t${d.type}\tspace=${d.spaceLabel || d.spaceId}\tpoint=${pointText}`);
  }
}
