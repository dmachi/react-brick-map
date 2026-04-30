import fs from 'node:fs';

const filePath = process.argv[2] ?? 'public/data/building-1.flat.jsonld';
const nodes = JSON.parse(fs.readFileSync(filePath, 'utf8'));

const REC_NS = ['https://w3id.org/rec#', 'https://www.w3.org/2022/rec#'];
const RDFS_LABEL = 'http://www.w3.org/2000/01/rdf-schema#label';

const nodeIndex = new Map(nodes.map((node) => [node['@id'], node]));

const getValues = (node, key) => (Array.isArray(node?.[key]) ? node[key] : []);
const getRef = (value) => (value && typeof value === 'object' ? value['@id'] : undefined);
const getLiteral = (value) =>
  value && typeof value === 'object' && Object.hasOwn(value, '@value') ? value['@value'] : undefined;
const localName = (value = '') => value.split('#').pop().split('/').pop();
const typeNames = (node) => (Array.isArray(node?.['@type']) ? node['@type'].map(localName) : []);

function parseCoordinates(node) {
  for (const ns of REC_NS) {
    const coordLiteral = getValues(node, `${ns}coordinates`)[0];
    const value = getLiteral(coordLiteral);
    if (typeof value !== 'string') {
      continue;
    }

    try {
      const parsed = JSON.parse(value);
      if (Array.isArray(parsed)) {
        return parsed;
      }
    } catch {
      // Ignore malformed coordinate literals.
    }
  }

  return undefined;
}

function getGeometryNode(spaceNode) {
  for (const ns of REC_NS) {
    const geomRef = getRef(getValues(spaceNode, `${ns}geometry`)[0]);
    if (geomRef && nodeIndex.has(geomRef)) {
      return nodeIndex.get(geomRef);
    }
  }
  return undefined;
}

function isSpaceNode(node) {
  const lowered = typeNames(node).map((t) => t.toLowerCase());
  return lowered.some((t) =>
    t.includes('space') ||
    t.includes('room') ||
    t === 'office' ||
    t === 'kitchen' ||
    t === 'bathroom' ||
    t === 'corridor' ||
    t === 'lobby' ||
    t === 'foyer' ||
    t === 'plenum',
  );
}

function asRings(geometryNode) {
  const coords = parseCoordinates(geometryNode);
  if (!Array.isArray(coords) || coords.length === 0) {
    return [];
  }

  const geomTypes = typeNames(geometryNode).map((t) => t.toLowerCase());

  if (geomTypes.some((t) => t.includes('multipolygon'))) {
    const polygons = coords;
    const rings = [];
    for (const polygon of polygons) {
      if (!Array.isArray(polygon)) {
        continue;
      }
      for (const ring of polygon) {
        if (Array.isArray(ring) && ring.length >= 3) {
          rings.push(ring);
        }
      }
    }
    return rings;
  }

  if (!Array.isArray(coords[0])) {
    return [];
  }

  if (Array.isArray(coords[0][0])) {
    return coords.filter((ring) => Array.isArray(ring) && ring.length >= 3);
  }

  return [coords];
}

function ringArea(ring) {
  let area = 0;
  for (let i = 0; i < ring.length; i += 1) {
    const a = ring[i];
    const b = ring[(i + 1) % ring.length];
    const ax = Number(a[0]);
    const ay = Number(a[1]);
    const bx = Number(b[0]);
    const by = Number(b[1]);
    if (!Number.isFinite(ax) || !Number.isFinite(ay) || !Number.isFinite(bx) || !Number.isFinite(by)) {
      return NaN;
    }
    area += ax * by - bx * ay;
  }
  return Math.abs(area) / 2;
}

function areaFromRings(rings) {
  if (rings.length === 0) return NaN;

  // In GeoJSON-like polygon encoding, first ring is outer and subsequent rings are holes.
  const outer = ringArea(rings[0]);
  if (!Number.isFinite(outer)) return NaN;

  let holes = 0;
  for (let i = 1; i < rings.length; i += 1) {
    const holeArea = ringArea(rings[i]);
    if (!Number.isFinite(holeArea)) return NaN;
    holes += holeArea;
  }

  return outer - holes;
}

const report = [];

for (const node of nodes) {
  if (!isSpaceNode(node)) {
    continue;
  }

  const geomNode = getGeometryNode(node);
  if (!geomNode) {
    continue;
  }

  const geomType = typeNames(geomNode).join('|') || 'UnknownGeometry';
  if (!geomType.toLowerCase().includes('polygon')) {
    continue;
  }

  const rings = asRings(geomNode);
  if (rings.length === 0) {
    continue;
  }

  const area = areaFromRings(rings);
  const label = getLiteral(getValues(node, RDFS_LABEL)[0]) || localName(node['@id']);
  const spaceType = typeNames(node).join('|') || 'UnknownSpaceType';

  report.push({
    id: node['@id'],
    label,
    spaceType,
    geometryType: geomType,
    area,
  });
}

report.sort((a, b) => a.label.localeCompare(b.label));

console.log('=== Room/Space Area Report ===');
console.log('File:', filePath);
console.log('Count:', report.length);
console.log('');
console.log('Label\tArea\tType\tID');
for (const row of report) {
  const areaText = Number.isFinite(row.area) ? row.area.toFixed(2) : 'NaN';
  console.log(`${row.label}\t${areaText}\t${row.spaceType}\t${row.id}`);
}
