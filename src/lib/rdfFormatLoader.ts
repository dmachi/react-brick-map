import * as jsonld from 'jsonld';
import { Parser, Store, DataFactory } from 'n3';
import type {
  BrickRecSource,
  BrickRecSpaceSource,
  BrickRecAssetSource,
  BrickRecAnnotationSource,
  BrickRecHvacNodeSource,
  BrickRecHvacConnectionSource,
  BrickRecSpatialNodeSource,
} from './brickRecAdapter';
import type { RawCoordinate } from './geometryProfile';
import { loadRdfStoreFromJsonLd, type RdfStore } from './rdfStore';

const { namedNode: createNamedNode } = DataFactory;

const BRICK_NS = 'https://brickschema.org/schema/Brick#';
const REC_NAMESPACES = ['https://w3id.org/rec#', 'https://www.w3.org/2022/rec#'] as const;
const RDFS_NS = 'http://www.w3.org/2000/01/rdf-schema#';
const SKOS_NS = 'http://www.w3.org/2004/02/skos/core#';
const S223_NS = 'http://data.ashrae.org/standard223#';
const S223_HAS_CONNECTION_POINT_KEY = `${S223_NS}hasConnectionPoint`;
const S223_CNX_KEY = `${S223_NS}cnx`;
const HVAC_SCOPE_TYPE_KEYS = ['hvac_system', 'hvac_zone'] as const;
const HAS_PART_KEYS = [
  `${BRICK_NS}hasPart`,
  ...REC_NAMESPACES.map((namespace) => `${namespace}hasPart`),
] as const;

type JsonLdNode = Record<string, unknown> & { '@id'?: string; '@type'?: string[] };
type JsonLdReference = { '@id': string };

/**
 * Parse BRICK/REC data from JSON-LD or Turtle/RDF format into BrickRecSource.
 * 
 * JSON-LD is the canonical JSON-based serialization for BRICK Schema.
 * Turtle is supported for RDF-native workflows.
 *
 * JSON-LD Example:
 * ```json
 * {
 *   "@context": {
 *     "@vocab": "https://brickschema.org/schema/Brick#",
 *     "rec": "https://www.w3.org/2022/rec#"
 *   },
 *   "@type": "Building",
 *   "label": "Building Name",
 *   "hasPart": [
 *     {
 *       "@type": "Space",
 *       "label": "Room 101",
 *       "rec:geometry": { ... }
 *     }
 *   ]
 * }
 * ```
 */

export async function loadBrickRecFromJsonLd(
  jsonLdContent: string | object,
  buildingId?: string,
  rdfStore?: RdfStore,
): Promise<BrickRecSource> {
  let data: unknown;

  if (typeof jsonLdContent === 'string') {
    try {
      data = JSON.parse(jsonLdContent);
    } catch (err) {
      throw new Error(`JSON-LD parse error: ${err instanceof Error ? err.message : 'Invalid JSON'}`);
    }
  } else {
    data = jsonLdContent;
  }
  
  if (!data || (typeof data !== 'object' && !Array.isArray(data))) {
    throw new Error('JSON-LD must be an object, array, or valid JSON string');
  }

  const store = await loadRdfStoreFromJsonLd(data as object, rdfStore);
  const graphParentByChild = extractParentLinksFromRdfStore(store);
  const normalized = await normalizeJsonLdGraph(data);
  return extractBrickRecSourceFromJsonLd(normalized, buildingId || 'bldg-parsed', graphParentByChild);
}

async function normalizeJsonLdGraph(data: unknown): Promise<JsonLdNode[]> {
  const expanded = await jsonld.expand(data as object);
  const flattened = await jsonld.flatten(expanded);
  const rawNodes = Array.isArray(flattened)
    ? flattened
    : Array.isArray((flattened as Record<string, unknown>)['@graph'])
      ? (flattened as Record<string, unknown>)['@graph'] as unknown[]
      : [flattened];

  return rawNodes.filter((item): item is JsonLdNode => typeof item === 'object' && item !== null);
}

function extractBrickRecSourceFromJsonLd(
  graphNodes: JsonLdNode[],
  buildingId: string,
  parentLinksFromSparql?: Map<string, string>,
): BrickRecSource {
  const nodeIndex = new Map<string, JsonLdNode>();
  for (const node of graphNodes) {
    const id = getNodeId(node);
    if (id) {
      nodeIndex.set(id, node);
    }
  }

  const parentByChild = parentLinksFromSparql ? new Map(parentLinksFromSparql) : new Map<string, string>();
  for (const node of graphNodes) {
    const parentId = getNodeId(node);
    if (!parentId) {
      continue;
    }

    for (const key of HAS_PART_KEYS) {
      for (const value of getValues(node, key)) {
        const childId = getReferenceId(value);
        if (childId && !parentByChild.has(childId)) {
          parentByChild.set(childId, parentId);
        }
      }
    }
  }

  const spaces: BrickRecSpaceSource[] = [];
  const assets: BrickRecAssetSource[] = [];
  const spatialNodeById = new Map<string, BrickRecSpatialNodeSource>();
  const spaceEquipmentIds = new Set<string>();
  const seenSpaces = new Set<string>();
  const seenAssets = new Set<string>();

  for (const node of graphNodes) {
    const nodeId = getNodeId(node);
    if (!nodeId) {
      continue;
    }

    const id = toCanonicalId(nodeId, 'node-unknown');
    const parentId = extractParentId(node, nodeIndex, parentByChild);
    const geometry = extractPolygonalGeometry(node, nodeIndex);
    if (!parentId && !geometry) {
      continue;
    }

    spatialNodeById.set(id, {
      id,
      parentId,
      geometry,
    });

    if (isSpaceLike(node)) {
      for (const value of getValues(node, `${BRICK_NS}hasEquipment`)) {
        const equipmentId = getReferenceId(value);
        if (equipmentId) {
          spaceEquipmentIds.add(equipmentId);
        }
      }
    }
  }

  for (const node of graphNodes) {
    if (isSpaceLike(node)) {
      const id = toCanonicalId(getNodeId(node), 'space-unknown');
      if (seenSpaces.has(id)) {
        continue;
      }
      seenSpaces.add(id);

      const { label, hasExplicitLabel } = getLabelWithExplicitFlag(node, nodeIndex, 'Unnamed Space');
      spaces.push({
        id,
        label,
        hasExplicitLabel,
        brickClass: getPrimaryType(node),
        parentId: extractParentId(node, nodeIndex, parentByChild),
        geometry: extractPolygonalGeometry(node, nodeIndex),
        volume: extractBrickVolume(node, nodeIndex),
      });
      continue;
    }

    if (isAssetLike(node)) {
      const id = toCanonicalId(getNodeId(node), 'asset-unknown');
      if (seenAssets.has(id)) {
        continue;
      }
      const position = extractAssetPosition(node, nodeIndex);
      if (!position) {
        continue;
      }
      seenAssets.add(id);

      assets.push({
        id,
        label: getLabel(node, nodeIndex, 'Unnamed Asset'),
        type: inferAssetType(node, nodeIndex, spaceEquipmentIds),
        brickClass: getPrimaryType(node),
        spaceId: extractSpaceId(node, nodeIndex),
        parentId: extractParentId(node, nodeIndex, parentByChild),
        coordinateSystem: extractAssetCoordinateSystem(node, nodeIndex),
        position,
        metadata: extractMetadata(node, [
          '@id',
          '@type',
          ...REC_NAMESPACES.map((namespace) => `${namespace}geometry`),
          ...REC_NAMESPACES.map((namespace) => `${namespace}position`),
          ...REC_NAMESPACES.map((namespace) => `${namespace}isLocatedIn`),
          `${BRICK_NS}isLocatedIn`,
          `${RDFS_NS}label`,
          `${SKOS_NS}prefLabel`,
          `${RDFS_NS}comment`,
          `${BRICK_NS}hasPart`,
        ]),
      });
    }
  }

  const floorNode = graphNodes.find((node) => hasType(node, 'floor'));
  const buildingNode = graphNodes.find((node) => hasType(node, 'building'));
  const { hvacNodes, hvacConnections } = extractHvacTopologyFromJsonLd(graphNodes, nodeIndex);

  return {
    id: buildingId,
    label: getLabel(buildingNode, nodeIndex, 'Building (from JSON-LD)'),
    floor: {
      id: toCanonicalId(getNodeId(floorNode), 'floor-default'),
      label: getLabel(floorNode, nodeIndex, 'Default Level'),
      levelIndex: 0,
    },
    spaces,
    spatialNodes: Array.from(spatialNodeById.values()),
    assets,
    annotations: extractAnnotations(graphNodes, spaces, assets),
    hvacNodes,
    hvacConnections,
  };
}

function extractParentLinksFromRdfStore(store: RdfStore): Map<string, string> | undefined {
  try {
    const hasPartPredicates = [
      DataFactory.namedNode(`${BRICK_NS}hasPart`),
      ...REC_NAMESPACES.map((namespace) => DataFactory.namedNode(`${namespace}hasPart`)),
    ];
    const locatedInPredicates = [
      DataFactory.namedNode(`${BRICK_NS}isLocatedIn`),
      ...REC_NAMESPACES.map((namespace) => DataFactory.namedNode(`${namespace}isLocatedIn`)),
    ];

    const parentByChild = new Map<string, string>();

    for (const predicate of hasPartPredicates) {
      for (const statement of store.statementsMatching(undefined, predicate, undefined, undefined)) {
        const parent = statement.subject.value;
        const child = statement.object.value;
        if (child && parent && !parentByChild.has(child)) {
          parentByChild.set(child, parent);
        }
      }
    }

    for (const predicate of locatedInPredicates) {
      for (const statement of store.statementsMatching(undefined, predicate, undefined, undefined)) {
        const child = statement.subject.value;
        const parent = statement.object.value;
        if (child && parent && !parentByChild.has(child)) {
          parentByChild.set(child, parent);
        }
      }
    }

    return parentByChild;
  } catch {
    // Fall back to JSON-LD object traversal if RDF traversal fails.
    return undefined;
  }
}

function extractHvacTopologyFromJsonLd(
  graphNodes: JsonLdNode[],
  nodeIndex: Map<string, JsonLdNode>,
): {
  hvacNodes: BrickRecHvacNodeSource[];
  hvacConnections: BrickRecHvacConnectionSource[];
} {
  const assetIdByNodeId = new Map<string, string>();
  const assetNodeIds = new Set<string>();

  for (const node of graphNodes) {
    if (!isRenderableHvacNode(node)) {
      continue;
    }

    const nodeId = getNodeId(node);
    if (!nodeId) {
      continue;
    }

    assetNodeIds.add(nodeId);
    assetIdByNodeId.set(nodeId, toCanonicalId(nodeId, 'asset-unknown'));
  }

  const scopedSeeds = collectHvacScopeSeedIds(graphNodes, nodeIndex, assetNodeIds);
  const fullEdges = extractDirectedHvacEdgesFromJsonLd(graphNodes, nodeIndex, assetIdByNodeId);

  let includedNodeIds = scopedSeeds;
  if (includedNodeIds && includedNodeIds.size > 0) {
    let changed = true;
    while (changed) {
      changed = false;
      for (const edge of fullEdges) {
        if (!includedNodeIds.has(edge.fromNodeId) && !includedNodeIds.has(edge.toNodeId)) {
          continue;
        }
        if (!includedNodeIds.has(edge.fromNodeId)) {
          includedNodeIds.add(edge.fromNodeId);
          changed = true;
        }
        if (!includedNodeIds.has(edge.toNodeId)) {
          includedNodeIds.add(edge.toNodeId);
          changed = true;
        }
      }
    }
  } else {
    includedNodeIds = new Set(assetNodeIds);
  }

  const hvacNodes: BrickRecHvacNodeSource[] = [];
  for (const nodeId of includedNodeIds) {
    const node = nodeIndex.get(nodeId);
    if (!node) {
      continue;
    }

    hvacNodes.push({
      id: assetIdByNodeId.get(nodeId) ?? toCanonicalId(nodeId, 'asset-unknown'),
      label: getLabel(node, nodeIndex, 'Unnamed Asset'),
      brickClass: getPrimaryType(node),
    });
  }
  hvacNodes.sort((left, right) => left.label.localeCompare(right.label));

  const hvacConnections: BrickRecHvacConnectionSource[] = fullEdges
    .filter((edge) => includedNodeIds.has(edge.fromNodeId) && includedNodeIds.has(edge.toNodeId))
    .map((edge) => ({
      fromAssetId: assetIdByNodeId.get(edge.fromNodeId) ?? toCanonicalId(edge.fromNodeId, 'asset-unknown'),
      toAssetId: assetIdByNodeId.get(edge.toNodeId) ?? toCanonicalId(edge.toNodeId, 'asset-unknown'),
      relation: 's223:cnx',
      inferred: edge.inferred,
    }));

  return { hvacNodes, hvacConnections };
}

function isRenderableHvacNode(node: JsonLdNode): boolean {
  if (!isAssetLike(node)) {
    return false;
  }

  if (HVAC_SCOPE_TYPE_KEYS.some((typeKey) => hasType(node, typeKey))) {
    return false;
  }

  return true;
}

function collectHvacScopeSeedIds(
  graphNodes: JsonLdNode[],
  nodeIndex: Map<string, JsonLdNode>,
  assetNodeIds: Set<string>,
): Set<string> | undefined {
  const rootIds = graphNodes
    .filter((node) => HVAC_SCOPE_TYPE_KEYS.some((typeKey) => hasType(node, typeKey)))
    .map((node) => getNodeId(node))
    .filter((nodeId): nodeId is string => Boolean(nodeId));

  if (rootIds.length === 0) {
    return undefined;
  }

  const visited = new Set<string>(rootIds);
  const queue = [...rootIds];
  const scopedAssets = new Set<string>();

  while (queue.length > 0) {
    const currentId = queue.shift() as string;
    if (assetNodeIds.has(currentId)) {
      scopedAssets.add(currentId);
    }

    const node = nodeIndex.get(currentId);
    if (!node) {
      continue;
    }

    for (const key of HAS_PART_KEYS) {
      for (const value of getValues(node, key)) {
        const childId = getReferenceId(value);
        if (!childId || visited.has(childId)) {
          continue;
        }
        visited.add(childId);
        queue.push(childId);
      }
    }
  }

  return scopedAssets;
}

function extractDirectedHvacEdgesFromJsonLd(
  graphNodes: JsonLdNode[],
  nodeIndex: Map<string, JsonLdNode>,
  assetIdByNodeId: Map<string, string>,
): Array<{ fromNodeId: string; toNodeId: string; inferred: boolean }> {
  const ownerByConnectionPointId = new Map<string, string>();
  for (const nodeId of assetIdByNodeId.keys()) {
    const node = nodeIndex.get(nodeId);
    if (!node) {
      continue;
    }

    for (const value of getValues(node, S223_HAS_CONNECTION_POINT_KEY)) {
      const connectionPointId = getReferenceId(value);
      if (connectionPointId && !ownerByConnectionPointId.has(connectionPointId)) {
        ownerByConnectionPointId.set(connectionPointId, nodeId);
      }
    }
  }

  const edges: Array<{ fromNodeId: string; toNodeId: string; inferred: boolean }> = [];
  const seenEdges = new Set<string>();

  for (const node of graphNodes) {
    const cnxValues = getValues(node, S223_CNX_KEY);
    if (cnxValues.length === 0) {
      continue;
    }

    const classifiedCPs = cnxValues
      .map((value) => getReferenceId(value))
      .filter((cpId): cpId is string => Boolean(cpId))
      .map((cpId) => {
        const cpNode = nodeIndex.get(cpId);
        const isOutlet = cpNode ? hasType(cpNode, 'outletconnectionpoint') : false;
        const isInlet = cpNode ? hasType(cpNode, 'inletconnectionpoint') : false;
        const isBidirectional = cpNode ? hasType(cpNode, 'bidirectionalconnectionpoint') : false;
        return {
          cpId,
          isOutlet,
          isInlet,
          isBidirectional,
          isUnknownDirection: !isOutlet && !isInlet && !isBidirectional,
        };
      });

    let connectorProducedEdge = false;

    for (const outletCp of classifiedCPs) {
      if (!outletCp.isOutlet && !outletCp.isBidirectional && !outletCp.isUnknownDirection) {
        continue;
      }

      const fromNodeId = ownerByConnectionPointId.get(outletCp.cpId);
      if (!fromNodeId) {
        continue;
      }

      for (const inletCp of classifiedCPs) {
        if (!inletCp.isInlet && !inletCp.isBidirectional && !inletCp.isUnknownDirection) {
          continue;
        }

        const toNodeId = ownerByConnectionPointId.get(inletCp.cpId);
        if (!toNodeId || toNodeId === fromNodeId) {
          continue;
        }

        const key = `${fromNodeId}|${toNodeId}`;
        if (seenEdges.has(key)) {
          continue;
        }
        seenEdges.add(key);
        edges.push({ fromNodeId, toNodeId, inferred: false });
        connectorProducedEdge = true;
      }
    }

    // If direction inference fails, preserve connectivity with deterministic fallback ordering.
    if (!connectorProducedEdge) {
      const ownerIds = classifiedCPs
        .map((cp) => ownerByConnectionPointId.get(cp.cpId))
        .filter((ownerId): ownerId is string => Boolean(ownerId));

      const uniqueOwners = Array.from(new Set(ownerIds));
      if (uniqueOwners.length >= 2) {
        const fromNodeId = uniqueOwners[0];
        for (let index = 1; index < uniqueOwners.length; index += 1) {
          const toNodeId = uniqueOwners[index];
          if (toNodeId === fromNodeId) {
            continue;
          }
          const key = `${fromNodeId}|${toNodeId}`;
          if (seenEdges.has(key)) {
            continue;
          }
          seenEdges.add(key);
          edges.push({ fromNodeId, toNodeId, inferred: true });
        }
      }
    }
  }

  return edges;
}

function getNodeId(node: unknown): string | undefined {
  if (!node || typeof node !== 'object') {
    return undefined;
  }

  const rawId = (node as { '@id'?: unknown })['@id'];
  return typeof rawId === 'string' && rawId.length > 0 ? rawId : undefined;
}

function getValues(node: JsonLdNode | undefined, key: string): unknown[] {
  if (!node) {
    return [];
  }

  const value = node[key];
  return Array.isArray(value) ? value : value === undefined ? [] : [value];
}

function getValuesForKeys(node: JsonLdNode | undefined, keys: string[]): unknown[] {
  return keys.flatMap((key) => getValues(node, key));
}

function getLiteralValue(value: unknown): string | number | boolean | null | undefined {
  if (value === null || typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value;
  }

  if (!value || typeof value !== 'object') {
    return undefined;
  }

  if ('@value' in value) {
    const literalValue = (value as { '@value'?: unknown })['@value'];
    return literalValue === null || typeof literalValue === 'string' || typeof literalValue === 'number' || typeof literalValue === 'boolean'
      ? literalValue
      : undefined;
  }

  return undefined;
}

function getLiteralString(value: unknown): string | undefined {
  const literalValue = getLiteralValue(value);
  return typeof literalValue === 'string' ? literalValue : literalValue === undefined || literalValue === null ? undefined : String(literalValue);
}

function getReferenceId(value: unknown): string | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const refId = (value as JsonLdReference)['@id'];
  return typeof refId === 'string' ? refId : undefined;
}

function getLocalName(value: string | undefined): string {
  if (!value) {
    return '';
  }

  const hashSplit = value.split('#').pop() ?? value;
  const slashSplit = hashSplit.split('/').pop() ?? hashSplit;
  return slashSplit.split(':').pop() ?? slashSplit;
}

function getTypeNames(node: JsonLdNode | undefined): string[] {
  if (!node) {
    return [];
  }

  const typeValue = node['@type'];
  if (Array.isArray(typeValue)) {
    return typeValue.filter((value): value is string => typeof value === 'string');
  }
  if (typeof typeValue === 'string') {
    return [typeValue];
  }
  return [];
}

function getPrimaryType(node: JsonLdNode | undefined): string | undefined {
  return getTypeNames(node)[0];
}

function hasType(node: JsonLdNode | undefined, needle: string): boolean {
  const loweredNeedle = needle.toLowerCase();
  return getTypeNames(node).some((typeName) => getLocalName(typeName).toLowerCase() === loweredNeedle || getLocalName(typeName).toLowerCase().includes(loweredNeedle));
}

function getFirstNodeByReference(nodeIndex: Map<string, JsonLdNode>, values: unknown[]): JsonLdNode | undefined {
  for (const value of values) {
    const refId = getReferenceId(value);
    if (!refId) {
      continue;
    }
    const resolved = nodeIndex.get(refId);
    if (resolved) {
      return resolved;
    }
  }
  return undefined;
}

function toLocalId(value: string | undefined, fallback: string): string {
  return value ? getLocalName(value) || fallback : fallback;
}

function toCanonicalId(value: string | undefined, fallback: string): string {
  return value ?? fallback;
}

function getLabel(node: JsonLdNode | undefined, nodeIndex: Map<string, JsonLdNode>, fallback: string): string {
  if (!node) {
    return fallback;
  }

  const directLabel = getValuesForKeys(node, [`${SKOS_NS}prefLabel`, `${RDFS_NS}label`])
    .map((value) => getLiteralString(value))
    .find((value): value is string => Boolean(value && value.trim()));
  if (directLabel) {
    return directLabel;
  }

  const refLabelNode = getFirstNodeByReference(nodeIndex, getValuesForKeys(node, [`${SKOS_NS}prefLabel`, `${RDFS_NS}label`]));
  if (refLabelNode) {
    const resolved = getLabel(refLabelNode, nodeIndex, fallback);
    if (resolved) {
      return resolved;
    }
  }

  return toLocalId(getNodeId(node), fallback);
}

function getLabelWithExplicitFlag(
  node: JsonLdNode | undefined,
  nodeIndex: Map<string, JsonLdNode>,
  fallback: string,
): { label: string; hasExplicitLabel: boolean } {
  if (!node) {
    return { label: fallback, hasExplicitLabel: false };
  }

  const directLabel = getValuesForKeys(node, [`${SKOS_NS}prefLabel`, `${RDFS_NS}label`])
    .map((value) => getLiteralString(value))
    .find((value): value is string => Boolean(value && value.trim()));
  if (directLabel) {
    return { label: directLabel, hasExplicitLabel: true };
  }

  const refLabelNode = getFirstNodeByReference(nodeIndex, getValuesForKeys(node, [`${SKOS_NS}prefLabel`, `${RDFS_NS}label`]));
  if (refLabelNode) {
    const resolved = getLabelWithExplicitFlag(refLabelNode, nodeIndex, fallback);
    if (resolved.label !== fallback) {
      return resolved;
    }
  }

  return { label: toLocalId(getNodeId(node), fallback), hasExplicitLabel: false };
}

function isSpaceLike(node: JsonLdNode): boolean {
  if (isAssetLike(node)) {
    return false;
  }

  const typeNames = getTypeNames(node).map((typeName) => getLocalName(typeName).toLowerCase());
  if (typeNames.some((typeName) => typeName.includes('space') || typeName.includes('room') || typeName === 'office' || typeName === 'lobby' || typeName === 'storage' || typeName === 'plenum')) {
    return true;
  }

  return getValuesForKeys(node, REC_NAMESPACES.map((namespace) => `${namespace}geometry`)).length > 0;
}

function isAssetLike(node: JsonLdNode): boolean {
  return getTypeNames(node)
    .map((typeName) => getLocalName(typeName).toLowerCase())
    .some((typeName) =>
      typeName.includes('asset') ||
      typeName.includes('equipment') ||
      typeName.includes('sensor') ||
      typeName.includes('actuator') ||
      typeName.includes('luminaire') ||
      typeName.includes('vav') ||
      typeName.includes('fan') ||
      typeName.includes('grille') ||
      typeName.includes('diffuser') ||
      typeName.includes('ahu') ||
      typeName.includes('hvac') ||
      typeName.includes('damper') ||
      typeName.includes('intake') ||
      typeName.includes('outlet') ||
      typeName.includes('filter') ||
      typeName.includes('plenum') ||
      typeName.includes('terminal') ||
      typeName.includes('source') ||
      typeName.includes('chiller') ||
      typeName.includes('boiler') ||
      typeName.includes('coil') ||
      typeName.includes('air_handling') ||
      typeName.includes('exchanger'),
    );
}

function hasPointReference(node: JsonLdNode, nodeIndex: Map<string, JsonLdNode>): boolean {
  for (const value of getValues(node, `${BRICK_NS}hasPoint`)) {
    const pointRef = getReferenceId(value);
    if (!pointRef) {
      continue;
    }

    const pointNode = nodeIndex.get(pointRef);
    if (pointNode) {
      return true;
    }

    if (pointRef) {
      return true;
    }
  }

  return false;
}

function inferAssetType(
  node: JsonLdNode,
  nodeIndex: Map<string, JsonLdNode>,
  spaceEquipmentIds: Set<string>,
): string {
  const typeNames = getTypeNames(node).map((typeName) => getLocalName(typeName).toLowerCase());
  if (typeNames.some((typeName) => typeName.includes('sensor'))) {
    return 'sensor';
  }
  if (typeNames.some((typeName) => typeName.includes('actuator'))) {
    return 'actuator';
  }
  const nodeId = getNodeId(node);
  if (nodeId && spaceEquipmentIds.has(nodeId) && hasPointReference(node, nodeIndex)) {
    return 'sensor';
  }
  return 'equipment';
}

function parseCoordinateLiteral(value: unknown): unknown[] | undefined {
  if (Array.isArray(value)) {
    return value;
  }

  const literalString = getLiteralString(value);
  if (!literalString) {
    return undefined;
  }

  try {
    const parsed = JSON.parse(literalString);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

function toRawCoordinateRing(value: unknown): RawCoordinate[] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const ring: RawCoordinate[] = [];
  for (const point of value) {
    const coordinate = toRawCoordinate(point);
    if (!coordinate) {
      return undefined;
    }
    ring.push(coordinate);
  }

  return ring;
}

function toRawCoordinateRings(value: unknown): RawCoordinate[][] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  if (value.length === 0) {
    return [];
  }

  const firstItem = value[0];
  if (Array.isArray(firstItem) && typeof firstItem[0] === 'number') {
    const ring = toRawCoordinateRing(value);
    return ring ? [ring] : undefined;
  }

  const rings: RawCoordinate[][] = [];
  for (const ringValue of value) {
    const ring = toRawCoordinateRing(ringValue);
    if (!ring) {
      return undefined;
    }
    rings.push(ring);
  }

  return rings;
}

function toRawCoordinatePolygons(value: unknown): RawCoordinate[][][] | undefined {
  if (!Array.isArray(value)) {
    return undefined;
  }

  const polygons: RawCoordinate[][][] = [];
  for (const polygonValue of value) {
    const polygon = toRawCoordinateRings(polygonValue);
    if (!polygon) {
      return undefined;
    }
    polygons.push(polygon);
  }

  return polygons;
}

function toRawCoordinate(value: unknown): [number, number] | [number, number, number] | undefined {
  if (!Array.isArray(value) || value.length < 2) {
    return undefined;
  }

  const numeric = value.slice(0, 3).map((item) => typeof item === 'number' ? item : Number(item));
  if (numeric.some((item) => !Number.isFinite(item))) {
    return undefined;
  }

  return numeric.length >= 3 ? [numeric[0], numeric[1], numeric[2]] : [numeric[0], numeric[1]];
}

function extractCoordinateSystemName(node: JsonLdNode | undefined): string | undefined {
  const coordinateSystemValues = getValuesForKeys(node, REC_NAMESPACES.map((namespace) => `${namespace}coordinateSystem`));
  for (const value of coordinateSystemValues) {
    const literal = getLiteralString(value);
    if (literal) {
      return literal;
    }

    const refId = getReferenceId(value);
    if (refId) {
      return getLocalName(refId);
    }
  }

  return undefined;
}

function extractPointGeometry(node: JsonLdNode | undefined): [number, number] | [number, number, number] | undefined {
  if (!node || !hasType(node, 'point')) {
    return undefined;
  }

  const coordinatesValue = getValuesForKeys(node, REC_NAMESPACES.map((namespace) => `${namespace}coordinates`))[0];
  return toRawCoordinate(parseCoordinateLiteral(coordinatesValue));
}

function extractBrickVolume(node: JsonLdNode, nodeIndex: Map<string, JsonLdNode>): number | undefined {
  const volumeKey = `${BRICK_NS}volume`;
  const valueKey = `${BRICK_NS}value`;

  const volumeRef = getReferenceId(getValues(node, volumeKey)[0]);
  if (!volumeRef) {
    return undefined;
  }

  const volumeNode = nodeIndex.get(volumeRef);
  if (!volumeNode) {
    return undefined;
  }

  const literalString = getLiteralString(getValues(volumeNode, valueKey)[0]);
  if (!literalString) {
    return undefined;
  }

  const parsed = parseFloat(literalString);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function extractPolygonalGeometry(node: JsonLdNode, nodeIndex: Map<string, JsonLdNode>): BrickRecSpaceSource['geometry'] {
  const geometryNode = getFirstNodeByReference(nodeIndex, getValuesForKeys(node, REC_NAMESPACES.map((namespace) => `${namespace}geometry`)));
  if (!geometryNode) {
    return undefined;
  }

  if (hasType(geometryNode, 'point')) {
    return undefined;
  }

  const coordinatesValue = getValuesForKeys(geometryNode, REC_NAMESPACES.map((namespace) => `${namespace}coordinates`))[0];
  const parsed = parseCoordinateLiteral(coordinatesValue);
  if (!parsed) {
    return undefined;
  }

  const coordinateSystem = extractCoordinateSystemName(geometryNode);

  if (hasType(geometryNode, 'multipolygon')) {
    const coordinates = toRawCoordinatePolygons(parsed);
    if (!coordinates) {
      return undefined;
    }

    return {
      type: 'MultiPolygon',
      coordinateSystem,
      coordinates,
    };
  }

  const coordinates = toRawCoordinateRings(parsed);
  if (!coordinates) {
    return undefined;
  }

  return {
    type: 'Polygon',
    coordinateSystem,
    coordinates,
  };
}

function extractSpaceId(node: JsonLdNode, nodeIndex: Map<string, JsonLdNode>): string | undefined {
  const locationValue = getValuesForKeys(node, [
    ...REC_NAMESPACES.map((namespace) => `${namespace}isLocatedIn`),
    `${BRICK_NS}isLocatedIn`,
  ]);
  const locatedInNode = getFirstNodeByReference(nodeIndex, locationValue);
  if (locatedInNode) {
    return toCanonicalId(getNodeId(locatedInNode), 'space-unknown');
  }

  const locationRef = locationValue.map((value) => getReferenceId(value)).find((value): value is string => Boolean(value));
  return locationRef ? toCanonicalId(locationRef, 'space-unknown') : undefined;
}

function extractParentId(
  node: JsonLdNode,
  nodeIndex: Map<string, JsonLdNode>,
  parentByChild: Map<string, string>,
): string | undefined {
  const locationValue = getValuesForKeys(node, [
    ...REC_NAMESPACES.map((namespace) => `${namespace}isLocatedIn`),
    `${BRICK_NS}isLocatedIn`,
  ]);
  const locatedInNode = getFirstNodeByReference(nodeIndex, locationValue);
  if (locatedInNode) {
    return toCanonicalId(getNodeId(locatedInNode), 'parent-unknown');
  }

  const locationRef = locationValue.map((value) => getReferenceId(value)).find((value): value is string => Boolean(value));
  if (locationRef) {
    return toCanonicalId(locationRef, 'parent-unknown');
  }

  const nodeId = getNodeId(node);
  if (!nodeId) {
    return undefined;
  }

  const parentId = parentByChild.get(nodeId);
  return parentId ? toCanonicalId(parentId, 'parent-unknown') : undefined;
}

function extractAssetCoordinateSystem(node: JsonLdNode, nodeIndex: Map<string, JsonLdNode>): string | undefined {
  const geometryNode = getFirstNodeByReference(
    nodeIndex,
    getValuesForKeys(node, REC_NAMESPACES.map((namespace) => `${namespace}geometry`)),
  );
  if (!geometryNode) {
    return undefined;
  }

  return extractCoordinateSystemName(geometryNode);
}

function extractAssetPosition(node: JsonLdNode, nodeIndex: Map<string, JsonLdNode>): [number, number] | [number, number, number] | undefined {
  const positionValue = getValuesForKeys(node, REC_NAMESPACES.map((namespace) => `${namespace}position`))[0];
  const directPosition = toRawCoordinate(parseCoordinateLiteral(positionValue));
  if (directPosition) {
    return directPosition;
  }

  const geometryNode = getFirstNodeByReference(nodeIndex, getValuesForKeys(node, REC_NAMESPACES.map((namespace) => `${namespace}geometry`)));
  return extractPointGeometry(geometryNode);
}

function extractMetadata(node: JsonLdNode, excludedKeys: string[]): Record<string, string | number | boolean | null> | undefined {
  const excluded = new Set(excludedKeys);
  const metadata: Record<string, string | number | boolean | null> = {};

  for (const [key] of Object.entries(node)) {
    if (excluded.has(key)) {
      continue;
    }

    const firstLiteral = getValues(node, key)
      .map((value) => getLiteralValue(value))
      .find((value) => value !== undefined);
    if (firstLiteral === undefined) {
      continue;
    }

    metadata[getLocalName(key) || key] = firstLiteral;
  }

  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

function extractAnnotations(
  graphNodes: JsonLdNode[],
  spaces: BrickRecSpaceSource[],
  assets: BrickRecAssetSource[],
): BrickRecAnnotationSource[] {
  const spaceIds = new Set(spaces.map((space) => space.id));
  const assetIds = new Set(assets.map((asset) => asset.id));

  return graphNodes.flatMap((node) => {
    const commentValue = getValuesForKeys(node, [`${RDFS_NS}comment`])[0];
    const label = getLiteralString(commentValue)?.trim();
    if (!label) {
      return [];
    }

    const targetId = toCanonicalId(getNodeId(node), 'unknown');
    if (!spaceIds.has(targetId) && !assetIds.has(targetId)) {
      return [];
    }

    return [{
      id: `ann-${targetId}-comment`,
      targetType: spaceIds.has(targetId) ? 'space' : 'asset',
      targetId,
      label,
      color: '#666666',
    }];
  });
}

/**
 * Parse Turtle/RDF BRICK ontology into BrickRecSource format.
 *
 * Supports Turtle serialization for RDF-native workflows.
 * JSON-LD is the canonical BRICK serialization format.
 */


export async function loadBrickRecFromTurtle(turtleContent: string, buildingId?: string): Promise<BrickRecSource> {
  const parser = new Parser();
  const store = new Store();

  // Parse Turtle content and add to store
  return new Promise((resolve, reject) => {
    parser.parse(turtleContent, (error: any, quad: any) => {
      if (error) {
        reject(new Error(`Turtle parse error: ${error.message}`));
        return;
      }
      if (quad) {
        store.addQuad(quad);
      } else {
        // Parse complete
        try {
          const source = extractBrickRecSource(store, buildingId || 'bldg-parsed');
          resolve(source);
        } catch (err) {
          reject(err);
        }
      }
    });
  });
}

function extractBrickRecSource(store: Store, buildingId: string): BrickRecSource {
  // Common prefixes
  const BRICK = 'https://brickschema.org/schema/Brick#';
  const REC = 'https://www.w3.org/2022/rec#';
  const RDFS = 'http://www.w3.org/2000/01/rdf-schema#';
  const RDF = 'http://www.w3.org/1999/02/22-rdf-syntax-ns#';
  const SKOS = 'http://www.w3.org/2004/02/skos/core#';

  const label = createNamedNode(RDFS + 'label');
  const prefLabel = createNamedNode(SKOS + 'prefLabel');
  const rdfType = createNamedNode(RDF + 'type');
  const hasGeometry = createNamedNode(REC + 'geometry');

  // Convert matching quads to array
  const matchToArray = (s: any, p: any, o: any) => {
    const quads: any[] = [];
    for (const quad of store.match(s, p, o)) {
      quads.push(quad);
    }
    return quads;
  };

  // Get label for a subject
  const getLabel = (subject: any): string => {
    const prefLabelQuads = matchToArray(subject, prefLabel, null);
    if (prefLabelQuads.length > 0) {
      return prefLabelQuads[0].object.value;
    }
    const labelQuads = matchToArray(subject, label, null);
    if (labelQuads.length > 0) {
      return labelQuads[0].object.value;
    }
    // Fallback to localName
    return subject.value.split(/[#/]/).pop() || subject.value;
  };

  // Get label with explicit flag for a subject
  const getLabelWithExplicitFlag = (subject: any): { label: string; hasExplicitLabel: boolean } => {
    const prefLabelQuads = matchToArray(subject, prefLabel, null);
    if (prefLabelQuads.length > 0) {
      return { label: prefLabelQuads[0].object.value, hasExplicitLabel: true };
    }
    const labelQuads = matchToArray(subject, label, null);
    if (labelQuads.length > 0) {
      return { label: labelQuads[0].object.value, hasExplicitLabel: true };
    }
    // Fallback to localName
    return { label: subject.value.split(/[#/]/).pop() || subject.value, hasExplicitLabel: false };
  };

  // Find all subjects with a given type
  const getByType = (typeUri: string) => {
    const typeNode = createNamedNode(typeUri);
    const subjects: any[] = [];
    for (const quad of store.match(null, rdfType, typeNode)) {
      subjects.push(quad.subject);
    }
    return subjects;
  };

  const getBrickLocalName = (uri: string): string => {
    return uri.split(/[#/]/).pop() || uri;
  };

  const isSpaceLikeBrickClass = (typeUri: string): boolean => {
    if (!typeUri.startsWith(BRICK)) {
      return false;
    }

    const localName = getBrickLocalName(typeUri).toLowerCase();
    return (
      localName.includes('space') ||
      localName.includes('room') ||
      localName === 'office' ||
      localName === 'lobby' ||
      localName === 'storage'
    );
  };

  const synthesizeSpaceGeometry = (spacesInput: BrickRecSpaceSource[]): BrickRecSpaceSource[] => {
    if (spacesInput.length === 0) {
      return spacesInput;
    }

    const hasAnyGeometry = spacesInput.some((space) => space.geometry !== undefined);
    if (hasAnyGeometry) {
      return spacesInput;
    }

    const columns = Math.max(1, Math.ceil(Math.sqrt(spacesInput.length)));
    const width = 12;
    const height = 8;
    const gap = 2;

    return spacesInput.map((space, index) => {
      const col = index % columns;
      const row = Math.floor(index / columns);
      const x0 = col * (width + gap);
      const y0 = row * (height + gap);
      const x1 = x0 + width;
      const y1 = y0 + height;

      return {
        ...space,
        geometry: {
          type: 'Polygon',
          coordinateSystem: 'LocalCoordinates',
          coordinates: [
            [
              [x0, y0],
              [x1, y0],
              [x1, y1],
              [x0, y1],
              [x0, y0],
            ],
          ],
        },
      };
    });
  };

  // Extract spaces from BRICK space-like classes (e.g. Space, Room, Office).
  const spaceSubjects: any[] = [];
  const seenSpaceSubjects = new Set<string>();

  for (const quad of store.match(null, rdfType, null)) {
    const subjectValue = quad.subject.value;
    const typeUri = quad.object.value;
    if (!isSpaceLikeBrickClass(typeUri)) {
      continue;
    }
    if (seenSpaceSubjects.has(subjectValue)) {
      continue;
    }
    seenSpaceSubjects.add(subjectValue);
    spaceSubjects.push(quad.subject);
  }

  const extractedSpaces: BrickRecSpaceSource[] = spaceSubjects.map((subject: any) => {
    const id = subject.value.split(/[#/]/).pop() || 'space-unknown';
    const { label: spaceLabel, hasExplicitLabel } = getLabelWithExplicitFlag(subject);

    let brickClass = BRICK + 'Space';
    const typeQuads = matchToArray(subject, rdfType, null);
    const brickTypeQuad = typeQuads.find((quad) => isSpaceLikeBrickClass(quad.object.value));
    if (brickTypeQuad) {
      brickClass = brickTypeQuad.object.value;
    }

    // Look for geometry
    const geometryQuads = matchToArray(subject, hasGeometry, null);
    let geometry: any = undefined;

    if (geometryQuads.length > 0) {
      const geomSubject = geometryQuads[0].object;
      geometry = extractGeometryFromStore(store, geomSubject, REC);
    }

    return {
      id,
      label: spaceLabel,
      hasExplicitLabel,
      brickClass,
      geometry,
    };
  });

  const spaces = synthesizeSpaceGeometry(extractedSpaces);

  // Extract assets (equipment, sensors, etc.)
  const assetSubjects = getByType(BRICK + 'Asset')
    .concat(getByType(BRICK + 'Equipment'))
    .concat(getByType(BRICK + 'Sensor'));

  const assets: BrickRecAssetSource[] = [];
  const hvacNodes: BrickRecHvacNodeSource[] = [];
  const assetIdByUri = new Map<string, string>();
  const spaceEquipmentUris = new Set<string>();
  const seen = new Set<string>();

  const hasEquipmentNode = createNamedNode(BRICK + 'hasEquipment');
  for (const quad of store.match(null, hasEquipmentNode, null)) {
    spaceEquipmentUris.add(quad.object.value);
  }

  assetSubjects.forEach((subject: any) => {
    const id = subject.value.split(/[#/]/).pop() || 'asset-unknown';
    if (seen.has(id)) return;
    seen.add(id);

    const assetLabel = getLabel(subject);
    const assetType = getAssetType(subject, store, spaceEquipmentUris);

    hvacNodes.push({
      id,
      label: assetLabel,
      brickClass: BRICK + 'Asset',
    });

    // Try to find which space this asset is in
    let spaceId: string | undefined;
    const isLocatedInNode = createNamedNode(BRICK + 'isLocatedIn');
    const spaceRef = matchToArray(subject, isLocatedInNode, null);
    if (spaceRef.length > 0) {
      spaceId = spaceRef[0].object.value.split(/[#/]/).pop();
    }

    // Try to get position from rec:position or similar
    const positionNode = createNamedNode(REC + 'position');
    const positionQuads = matchToArray(subject, positionNode, null);
    let position: [number, number] = [0, 0];
    if (positionQuads.length > 0) {
      const posStr = positionQuads[0].object.value;
      const coords = posStr.match(/[\d.]+/g);
      if (coords && coords.length >= 2) {
        position = [parseFloat(coords[0]), parseFloat(coords[1])];
      }
    }

    assets.push({
      id,
      label: assetLabel,
      type: assetType,
      brickClass: BRICK + 'Asset',
      spaceId,
      position,
    });
    assetIdByUri.set(subject.value, id);
  });

  const hvacConnections = extractHvacConnectionsFromStore(store, assetIdByUri);

  // Extract annotations (comments, notes attached to spaces/assets)
  const annotations: BrickRecAnnotationSource[] = [];
  const commentProp = createNamedNode(RDFS + 'comment');

  for (const quad of store.match(null, commentProp, null)) {
    if (quad.object.value.trim()) {
      const targetId = quad.subject.value.split(/[#/]/).pop();
      const targetType = spaces.some((s) => s.id === targetId) ? 'space' : 'asset';

      annotations.push({
        id: `ann-${targetId}-comment`,
        targetType,
        targetId,
        label: quad.object.value,
        color: '#666666',
      });
    }
  }

  // Default floor
  const floor = {
    id: 'floor-default',
    label: 'Default Level',
    levelIndex: 0,
  };

  return {
    id: buildingId,
    label: 'Building (from Turtle)',
    floor,
    spaces,
    assets,
    annotations,
    hvacNodes,
    hvacConnections,
  };
}

function extractHvacConnectionsFromStore(
  store: Store,
  assetIdByUri: Map<string, string>,
): BrickRecHvacConnectionSource[] {
  const hasConnectionPointNode = createNamedNode(S223_HAS_CONNECTION_POINT_KEY);
  const cnxNode = createNamedNode(S223_CNX_KEY);
  const rdfTypeNode = createNamedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
  const outletCpType = createNamedNode(`${S223_NS}OutletConnectionPoint`);
  const inletCpType = createNamedNode(`${S223_NS}InletConnectionPoint`);
  const bidirectionalCpType = createNamedNode(`${S223_NS}BidirectionalConnectionPoint`);

  // Build map: connection point URI → asset ID (owner)
  const cpOwnerByUri = new Map<string, string>();
  for (const [assetUri, assetId] of assetIdByUri) {
    const assetNode = createNamedNode(assetUri);
    for (const quad of store.match(assetNode, hasConnectionPointNode, null)) {
      if (!cpOwnerByUri.has(quad.object.value)) {
        cpOwnerByUri.set(quad.object.value, assetId);
      }
    }
  }

  const edges: BrickRecHvacConnectionSource[] = [];
  const seenEdges = new Set<string>();

  // Process all connector nodes (have s223:cnx predicates)
  // Collect groups by connector subject
  const connectorsByCpLists = new Map<string, string[]>();
  for (const quad of store.match(null, cnxNode, null)) {
    const connectorUri = quad.subject.value;
    if (!connectorsByCpLists.has(connectorUri)) {
      connectorsByCpLists.set(connectorUri, []);
    }
    connectorsByCpLists.get(connectorUri)!.push(quad.object.value);
  }

  // For each connector, extract outlet→inlet edges
  for (const cpUris of connectorsByCpLists.values()) {
    // Classify each CP
    type CPInfo = {
      uri: string;
      isOutlet: boolean;
      isInlet: boolean;
      isBidirectional: boolean;
      isUnknownDirection: boolean;
    };
    const cpInfos: CPInfo[] = [];

    for (const cpUri of cpUris) {
      const cpNode = createNamedNode(cpUri);
      let isOutlet = false;
      let isInlet = false;
      let isBidirectional = false;

      for (const quad of store.match(cpNode, rdfTypeNode, null)) {
        const typeUri = quad.object.value;
        if (typeUri === outletCpType.value) {
          isOutlet = true;
        } else if (typeUri === inletCpType.value) {
          isInlet = true;
        } else if (typeUri === bidirectionalCpType.value) {
          isBidirectional = true;
        }
      }

      cpInfos.push({
        uri: cpUri,
        isOutlet,
        isInlet,
        isBidirectional,
        isUnknownDirection: !isOutlet && !isInlet && !isBidirectional,
      });
    }

    let connectorProducedEdge = false;

    // Create edges from outlet CPs to inlet CPs
    for (const outletCp of cpInfos) {
      if (!outletCp.isOutlet && !outletCp.isBidirectional && !outletCp.isUnknownDirection) {
        continue;
      }
      const fromAssetId = cpOwnerByUri.get(outletCp.uri);
      if (!fromAssetId) {
        continue;
      }

      for (const inletCp of cpInfos) {
        if (!inletCp.isInlet && !inletCp.isBidirectional && !inletCp.isUnknownDirection) {
          continue;
        }
        const toAssetId = cpOwnerByUri.get(inletCp.uri);
        if (!toAssetId || toAssetId === fromAssetId) {
          continue;
        }

        const edgeKey = [fromAssetId, toAssetId].join('|');
        if (seenEdges.has(edgeKey)) {
          continue;
        }
        seenEdges.add(edgeKey);

        edges.push({
          fromAssetId,
          toAssetId,
          relation: 's223:cnx',
        });
        connectorProducedEdge = true;
      }
    }

    if (!connectorProducedEdge) {
      const uniqueOwners = Array.from(
        new Set(
          cpInfos
            .map((cpInfo) => cpOwnerByUri.get(cpInfo.uri))
            .filter((ownerId): ownerId is string => Boolean(ownerId)),
        ),
      );

      if (uniqueOwners.length >= 2) {
        const fromAssetId = uniqueOwners[0];
        for (let index = 1; index < uniqueOwners.length; index += 1) {
          const toAssetId = uniqueOwners[index];
          if (toAssetId === fromAssetId) {
            continue;
          }
          const edgeKey = [fromAssetId, toAssetId].join('|');
          if (seenEdges.has(edgeKey)) {
            continue;
          }
          seenEdges.add(edgeKey);
          edges.push({
            fromAssetId,
            toAssetId,
            relation: 's223:cnx',
          });
        }
      }
    }
  }

  return edges;
}

function extractGeometryFromStore(store: Store, geomSubject: any, REC: string): any {
  const rdfType = createNamedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');
  const hasCoordinates = createNamedNode(REC + 'coordinates');

  const matchToArray = (s: any, p: any, o: any) => {
    const quads: any[] = [];
    for (const quad of store.match(s, p, o)) {
      quads.push(quad);
    }
    return quads;
  };

  // Check geometry type
  const typeQuads = matchToArray(geomSubject, rdfType, null);
  let geometryType = 'Polygon';
  if (typeQuads.length > 0) {
    const typeUri = typeQuads[0].object.value;
    if (typeUri.includes('MultiPolygon')) {
      geometryType = 'MultiPolygon';
    }
  }

  // Extract coordinates
  const coordQuads = matchToArray(geomSubject, hasCoordinates, null);
  let coordinates: any[][] = [];

  if (coordQuads.length > 0) {
    // Assuming coordinates are serialized as a string like "[[0,0],[10,0],[10,10],[0,10],[0,0]]"
    const coordStr = coordQuads[0].object.value;
    try {
      const parsed = JSON.parse(coordStr);
      coordinates = Array.isArray(parsed[0]?.[0]) ? parsed : [parsed];
    } catch {
      // Fall back to dummy coordinates
      coordinates = [
        [
          [0, 0],
          [10, 0],
          [10, 10],
          [0, 10],
          [0, 0],
        ],
      ];
    }
  }

  // Extract coordinate system
  const coordinateSystemNode = createNamedNode(REC + 'coordinateSystem');
  const csysQuads = matchToArray(geomSubject, coordinateSystemNode, null);
  let csys = 'LocalCoordinates';
  if (csysQuads.length > 0) {
    csys = csysQuads[0].object.value.split(/[#/]/).pop() || 'LocalCoordinates';
  }

  return {
    type: geometryType,
    coordinateSystem: csys,
    coordinates,
  };
}

/**
 * Determine asset type (sensor, equipment, etc.) from BRICK class
 */
function hasPointReferenceInStore(subject: any, store: Store): boolean {
  const hasPoint = createNamedNode('https://brickschema.org/schema/Brick#hasPoint');

  for (const pointQuad of store.match(subject, hasPoint, null)) {
    if (pointQuad.object.value) {
      return true;
    }
  }

  return false;
}

function getAssetType(subject: any, store: Store, spaceEquipmentUris: Set<string>): string {
  const rdfType = createNamedNode('http://www.w3.org/1999/02/22-rdf-syntax-ns#type');

  for (const quad of store.match(subject, rdfType, null)) {
    const uri = quad.object.value;
    if (uri.includes('Sensor')) return 'sensor';
    if (uri.includes('Actuator')) return 'actuator';
  }

  if (spaceEquipmentUris.has(subject.value) && hasPointReferenceInStore(subject, store)) {
    return 'sensor';
  }

  for (const quad of store.match(subject, rdfType, null)) {
    if (quad.object.value.includes('Equipment')) return 'equipment';
  }

  return 'asset';
}
