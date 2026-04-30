import { useCallback, useEffect, useMemo, useState } from 'react';
import { Arrow, Circle, Group, Layer, Stage, Text } from 'react-konva';
import type Konva from 'konva';
import type { BrickRecSource } from './brickRecAdapter';

type HvacNode = {
  id: string;
  label: string;
  brickClass?: string;
  spaceId?: string;
};

type HvacEdge = {
  fromId: string;
  toId: string;
  inferred?: boolean;
};

export type HVACMapProps = {
  source: BrickRecSource;
  width: number;
  height: number;
  onAssetClick?: (assetId: string) => void;
};

function normalizeKey(value?: string): string {
  if (!value) {
    return '';
  }

  const lowered = value.toLowerCase();
  const hashSplit = lowered.split('#').pop() ?? lowered;
  const slashSplit = hashSplit.split('/').pop() ?? hashSplit;
  return slashSplit.split(':').pop() ?? slashSplit;
}

function buildTopology(source: BrickRecSource): { nodes: HvacNode[]; edges: HvacEdge[] } {
  const hvacNodeIds = new Set((source.hvacNodes ?? []).map((node) => node.id));
  const mergedById = new Map<string, HvacNode>();

  if ((source.hvacNodes ?? []).length > 0) {
    for (const node of source.hvacNodes ?? []) {
      mergedById.set(node.id, {
        id: node.id,
        label: node.label,
        brickClass: node.brickClass,
        spaceId: undefined,
      });
    }

    for (const asset of source.assets ?? []) {
      if (!hvacNodeIds.has(asset.id)) {
        continue;
      }

      mergedById.set(asset.id, {
        id: asset.id,
        label: asset.label,
        brickClass: asset.brickClass,
        spaceId: asset.spaceId,
      });
    }
  } else {
    for (const asset of source.assets ?? []) {
      mergedById.set(asset.id, {
        id: asset.id,
        label: asset.label,
        brickClass: asset.brickClass,
        spaceId: asset.spaceId,
      });
    }
  }

  const nodes = Array.from(mergedById.values());
  const edgeList = (source.hvacConnections ?? []).map((item) => ({
    fromId: item.fromAssetId,
    toId: item.toAssetId,
    inferred: item.inferred === true,
  }));

  const nodeIdSet = new Set(nodes.map((node) => node.id));
  const dedupEdgeByKey = new Map<string, HvacEdge>();
  const edges: HvacEdge[] = [];

  for (const edge of edgeList) {
    if (!nodeIdSet.has(edge.fromId) || !nodeIdSet.has(edge.toId) || edge.fromId === edge.toId) {
      continue;
    }
    const key = [edge.fromId, edge.toId].join('|');
    const existing = dedupEdgeByKey.get(key);
    if (existing && existing.inferred !== true) {
      continue;
    }
    dedupEdgeByKey.set(key, edge);
  }

  edges.push(...dedupEdgeByKey.values());

  return { nodes, edges };
}

/**
 * Topological level assignment via forward BFS from sources.
 * Returns a map of node ID → level (higher level = farther right/downstream).
 */
function assignLevels(
  nodes: HvacNode[],
  edges: HvacEdge[],
): Map<string, number> {
  const nodeIdSet = new Set(nodes.map((n) => n.id));
  const outgoingByNode = new Map<string, Set<string>>();
  const incomingByNode = new Map<string, Set<string>>();

  for (const nodeId of nodeIdSet) {
    outgoingByNode.set(nodeId, new Set<string>());
    incomingByNode.set(nodeId, new Set<string>());
  }

  for (const edge of edges) {
    if (nodeIdSet.has(edge.fromId) && nodeIdSet.has(edge.toId)) {
      outgoingByNode.get(edge.fromId)?.add(edge.toId);
      incomingByNode.get(edge.toId)?.add(edge.fromId);
    }
  }

  const sources = Array.from(nodeIdSet).filter((nodeId) => incomingByNode.get(nodeId)?.size === 0);

  const levels = new Map<string, number>();
  const queue: [string, number][] = [];

  for (const source of sources) {
    queue.push([source, 0]);
    levels.set(source, 0);
  }

  while (queue.length > 0) {
    const [nodeId, level] = queue.shift()!;
    for (const childId of outgoingByNode.get(nodeId) ?? []) {
      const childLevel = level + 1;
      if (!levels.has(childId) || levels.get(childId)! < childLevel) {
        levels.set(childId, childLevel);
        queue.push([childId, childLevel]);
      }
    }
  }

  for (const nodeId of nodeIdSet) {
    if (!levels.has(nodeId)) {
      levels.set(nodeId, 0);
    }
  }

  return levels;
}

function compareNodesForLayout(left: HvacNode, right: HvacNode): number {
  const leftSpace = left.spaceId ?? 'zzzz-no-space';
  const rightSpace = right.spaceId ?? 'zzzz-no-space';
  if (leftSpace !== rightSpace) {
    return leftSpace.localeCompare(rightSpace);
  }

  const leftKey = normalizeKey(left.brickClass);
  const rightKey = normalizeKey(right.brickClass);
  if (leftKey !== rightKey) {
    return leftKey.localeCompare(rightKey);
  }

  return left.label.localeCompare(right.label);
}

function nodeText(node: HvacNode): string {
  const key = normalizeKey(node.brickClass);
  const label = node.label.toLowerCase();
  return `${key} ${label}`;
}

function isOutsideSupplyStart(node: HvacNode): boolean {
  const text = nodeText(node);
  return text.includes('outside air intake') || (text.includes('outside') && text.includes('intake'));
}

function isReturnGrille(node: HvacNode): boolean {
  const text = nodeText(node);
  return text.includes('return grille');
}

function isSupplyDiffuser(node: HvacNode): boolean {
  const text = nodeText(node);
  return text.includes('supply diffuser') || normalizeKey(node.brickClass).includes('diffuser');
}

function isExhaustTerminal(node: HvacNode): boolean {
  const text = nodeText(node);
  return text.includes('exhaust outlet');
}

function computeForwardDepths(
  startIds: string[],
  outgoingByNode: Map<string, Set<string>>,
): Map<string, number> {
  const depths = new Map<string, number>();
  const queue: string[] = [];

  for (const startId of startIds) {
    if (depths.has(startId)) {
      continue;
    }
    depths.set(startId, 0);
    queue.push(startId);
  }

  while (queue.length > 0) {
    const nodeId = queue.shift() as string;
    const depth = depths.get(nodeId) ?? 0;

    for (const nextId of outgoingByNode.get(nodeId) ?? []) {
      const nextDepth = depth + 1;
      if (!depths.has(nextId) || (depths.get(nextId) ?? 0) < nextDepth) {
        depths.set(nextId, nextDepth);
        queue.push(nextId);
      }
    }
  }

  return depths;
}

function computeDistanceToTargets(
  targetIds: string[],
  incomingByNode: Map<string, Set<string>>,
): Map<string, number> {
  const distances = new Map<string, number>();
  const queue: string[] = [];

  for (const targetId of targetIds) {
    if (distances.has(targetId)) {
      continue;
    }
    distances.set(targetId, 0);
    queue.push(targetId);
  }

  while (queue.length > 0) {
    const nodeId = queue.shift() as string;
    const distance = distances.get(nodeId) ?? 0;

    for (const previousId of incomingByNode.get(nodeId) ?? []) {
      const nextDistance = distance + 1;
      if (!distances.has(previousId) || (distances.get(previousId) ?? 0) < nextDistance) {
        distances.set(previousId, nextDistance);
        queue.push(previousId);
      }
    }
  }

  return distances;
}

function applyFlowGuidedLevels(nodes: HvacNode[], edges: HvacEdge[], levels: Map<string, number>): Map<string, number> {
  const guided = new Map(levels);
  const { incomingByNode, outgoingByNode } = buildAdjacency(edges);

  const outsideStartIds = nodes.filter((node) => isOutsideSupplyStart(node)).map((node) => node.id);
  const returnStartIds = nodes.filter((node) => isReturnGrille(node)).map((node) => node.id);
  const exhaustTargetIds = nodes.filter((node) => isExhaustTerminal(node)).map((node) => node.id);

  const supplyDepths = computeForwardDepths(outsideStartIds, outgoingByNode);
  for (const [nodeId, depth] of supplyDepths) {
    guided.set(nodeId, depth);
  }

  const returnDepths = computeForwardDepths(returnStartIds, outgoingByNode);
  const distanceToExhaust = computeDistanceToTargets(exhaustTargetIds, incomingByNode);

  for (const [nodeId] of returnDepths) {
    const distance = distanceToExhaust.get(nodeId);
    if (distance === undefined) {
      continue;
    }
    guided.set(nodeId, distance);
  }

  for (const outsideId of outsideStartIds) {
    guided.set(outsideId, 0);
  }

  let maxLevel = 0;
  for (const level of guided.values()) {
    maxLevel = Math.max(maxLevel, level);
  }
  for (const returnStartId of returnStartIds) {
    guided.set(returnStartId, Math.max(guided.get(returnStartId) ?? 0, maxLevel));
  }

  return guided;
}

function buildAdjacency(edges: HvacEdge[]): {
  incomingByNode: Map<string, Set<string>>;
  outgoingByNode: Map<string, Set<string>>;
} {
  const incomingByNode = new Map<string, Set<string>>();
  const outgoingByNode = new Map<string, Set<string>>();

  for (const edge of edges) {
    if (!incomingByNode.has(edge.toId)) {
      incomingByNode.set(edge.toId, new Set<string>());
    }
    incomingByNode.get(edge.toId)?.add(edge.fromId);

    if (!outgoingByNode.has(edge.fromId)) {
      outgoingByNode.set(edge.fromId, new Set<string>());
    }
    outgoingByNode.get(edge.fromId)?.add(edge.toId);
  }

  return { incomingByNode, outgoingByNode };
}

function averageNeighborOrder(
  nodeId: string,
  neighborsByNode: Map<string, Set<string>>,
  orderedNeighborIds: string[],
): number {
  const neighbors = neighborsByNode.get(nodeId);
  if (!neighbors || neighbors.size === 0) {
    return Number.POSITIVE_INFINITY;
  }

  const indexById = new Map<string, number>();
  orderedNeighborIds.forEach((id, index) => {
    indexById.set(id, index);
  });

  let total = 0;
  let count = 0;
  for (const neighborId of neighbors) {
    const index = indexById.get(neighborId);
    if (index === undefined) {
      continue;
    }
    total += index;
    count += 1;
  }

  return count === 0 ? Number.POSITIVE_INFINITY : total / count;
}

function orderNodesWithinLevels(
  nodesByLevel: Map<number, HvacNode[]>,
  sortedLevels: number[],
  edges: HvacEdge[],
): Map<number, HvacNode[]> {
  const ordered = new Map<number, HvacNode[]>();
  const { incomingByNode, outgoingByNode } = buildAdjacency(edges);

  for (const level of sortedLevels) {
    ordered.set(level, [...(nodesByLevel.get(level) ?? [])].sort(compareNodesForLayout));
  }

  for (let pass = 0; pass < 3; pass += 1) {
    for (let index = 1; index < sortedLevels.length; index += 1) {
      const level = sortedLevels[index];
      const previousLevel = sortedLevels[index - 1];
      const previousIds = (ordered.get(previousLevel) ?? []).map((node) => node.id);
      const currentNodes = [...(ordered.get(level) ?? [])];

      currentNodes.sort((left, right) => {
        const leftScore = averageNeighborOrder(left.id, incomingByNode, previousIds);
        const rightScore = averageNeighborOrder(right.id, incomingByNode, previousIds);
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }
        return compareNodesForLayout(left, right);
      });

      ordered.set(level, currentNodes);
    }

    for (let index = sortedLevels.length - 2; index >= 0; index -= 1) {
      const level = sortedLevels[index];
      const nextLevel = sortedLevels[index + 1];
      const nextIds = (ordered.get(nextLevel) ?? []).map((node) => node.id);
      const currentNodes = [...(ordered.get(level) ?? [])];

      currentNodes.sort((left, right) => {
        const leftScore = averageNeighborOrder(left.id, outgoingByNode, nextIds);
        const rightScore = averageNeighborOrder(right.id, outgoingByNode, nextIds);
        if (leftScore !== rightScore) {
          return leftScore - rightScore;
        }
        return compareNodesForLayout(left, right);
      });

      ordered.set(level, currentNodes);
    }
  }

  return ordered;
}

function distributeLevelVertically(
  nodes: HvacNode[],
  targetHeight: number,
  rowGap: number,
  groupGap: number,
): Array<{ node: HvacNode; y: number }> {
  const positioned: Array<{ node: HvacNode; y: number }> = [];
  let cursorY = 0;
  let previousSpaceId: string | undefined;

  for (const node of nodes) {
    if (previousSpaceId !== undefined && node.spaceId !== previousSpaceId) {
      cursorY += groupGap;
    }

    positioned.push({ node, y: cursorY });
    cursorY += rowGap;
    previousSpaceId = node.spaceId;
  }

  if (positioned.length === 0) {
    return positioned;
  }

  const contentHeight = positioned[positioned.length - 1].y;
  const offsetY = Math.max(0, (targetHeight - contentHeight) / 2);
  return positioned.map((entry) => ({ ...entry, y: entry.y + offsetY }));
}

function computeLayoutSpacing(
  nodesByLevel: Map<number, HvacNode[]>,
): { leftMargin: number; topMargin: number; columnGap: number; rowGap: number; groupGap: number } {
  const levelCount = Math.max(1, nodesByLevel.size);
  let maxNodesInLevel = 0;
  for (const nodes of nodesByLevel.values()) {
    maxNodesInLevel = Math.max(maxNodesInLevel, nodes.length);
  }

  if (levelCount >= 9 || maxNodesInLevel >= 14) {
    return { leftMargin: 72, topMargin: 50, columnGap: 160, rowGap: 48, groupGap: 18 };
  }
  if (levelCount >= 7 || maxNodesInLevel >= 10) {
    return { leftMargin: 78, topMargin: 52, columnGap: 172, rowGap: 52, groupGap: 20 };
  }
  return { leftMargin: 84, topMargin: 56, columnGap: 186, rowGap: 56, groupGap: 24 };
}

function layoutNodes(
  nodes: HvacNode[],
  edges: HvacEdge[],
  _width: number,
  height: number,
): Map<string, { x: number; y: number }> {
  const levels = applyFlowGuidedLevels(nodes, edges, assignLevels(nodes, edges));
  const nodesByLevel = new Map<number, HvacNode[]>();
  for (const node of nodes) {
    const level = levels.get(node.id) ?? 0;
    if (!nodesByLevel.has(level)) {
      nodesByLevel.set(level, []);
    }
    nodesByLevel.get(level)!.push(node);
  }

  const sortedLevels = Array.from(nodesByLevel.keys()).sort((a, b) => a - b);
  const orderedNodesByLevel = orderNodesWithinLevels(nodesByLevel, sortedLevels, edges);
  const positions = new Map<string, { x: number; y: number }>();
  const { leftMargin, topMargin, columnGap, rowGap, groupGap } = computeLayoutSpacing(nodesByLevel);
  const usableHeight = Math.max(height - topMargin * 2, 320);

  for (let levelIndex = 0; levelIndex < sortedLevels.length; levelIndex++) {
    const level = sortedLevels[levelIndex];
    const nodesAtLevel = orderedNodesByLevel.get(level) ?? [];

    const x = leftMargin + levelIndex * columnGap;
    for (const entry of distributeLevelVertically(nodesAtLevel, usableHeight, rowGap, groupGap)) {
      positions.set(entry.node.id, { x, y: topMargin + entry.y });
    }
  }

  return positions;
}

function nodeColor(brickClass?: string): string {
  const key = normalizeKey(brickClass);
  if (key.includes('diffuser')) {
    return '#0369a1';
  }
  if (key.includes('vav')) {
    return '#6d28d9';
  }
  if (key.includes('duct') || key.includes('plenum')) {
    return '#b45309';
  }
  if (key.includes('damper')) {
    return '#166534';
  }
  if (key.includes('grille')) {
    return '#155e75';
  }
  if (key.includes('ahu') || key.includes('airhandling')) {
    return '#1d4ed8';
  }
  return '#374151';
}

function computeFitTransform(
  positions: Map<string, { x: number; y: number }>,
  width: number,
  height: number,
): { scale: number; x: number; y: number } {
  if (positions.size === 0 || width <= 0 || height <= 0) {
    return { scale: 1, x: 0, y: 0 };
  }

  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;

  for (const position of positions.values()) {
    minX = Math.min(minX, position.x);
    minY = Math.min(minY, position.y);
    maxX = Math.max(maxX, position.x);
    maxY = Math.max(maxY, position.y);
  }

  const padding = 56;
  const graphWidth = Math.max(1, maxX - minX);
  const graphHeight = Math.max(1, maxY - minY);
  const usableWidth = Math.max(1, width - padding * 2);
  const usableHeight = Math.max(1, height - padding * 2);
  const scale = Math.max(0.12, Math.min(3, Math.min(usableWidth / graphWidth, usableHeight / graphHeight)));

  const centerX = (minX + maxX) / 2;
  const centerY = (minY + maxY) / 2;
  const x = width / 2 - centerX * scale;
  const y = height / 2 - centerY * scale;

  return { scale, x, y };
}

export function HVACMap({ source, width, height, onAssetClick }: HVACMapProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const [windowSize, setWindowSize] = useState({
    width: typeof window === 'undefined' ? width : window.innerWidth,
    height: typeof window === 'undefined' ? height : window.innerHeight,
  });
  const mapWidth = isExpanded ? windowSize.width : width;
  const mapHeight = isExpanded ? windowSize.height : height;

  const topology = useMemo(() => buildTopology(source), [source]);
  const [showSupplyDiffusers, setShowSupplyDiffusers] = useState(true);
  const [showReturnGrilles, setShowReturnGrilles] = useState(true);

  const visibleTopology = useMemo(() => {
    const nodes = topology.nodes.filter((node) => {
      if (!showSupplyDiffusers && isSupplyDiffuser(node)) {
        return false;
      }
      if (!showReturnGrilles && isReturnGrille(node)) {
        return false;
      }
      return true;
    });

    const visibleIds = new Set(nodes.map((node) => node.id));
    const edges = topology.edges.filter((edge) => visibleIds.has(edge.fromId) && visibleIds.has(edge.toId));

    return { nodes, edges };
  }, [showReturnGrilles, showSupplyDiffusers, topology.edges, topology.nodes]);

  const positions = useMemo(
    () => layoutNodes(visibleTopology.nodes, visibleTopology.edges, mapWidth, mapHeight),
    [mapHeight, mapWidth, visibleTopology.edges, visibleTopology.nodes],
  );

  const [stagePos, setStagePos] = useState({ x: 0, y: 0 });
  const [stageScale, setStageScale] = useState(1);
  const fitTransform = useMemo(() => computeFitTransform(positions, mapWidth, mapHeight), [mapHeight, mapWidth, positions]);

  useEffect(() => {
    if (!isExpanded) {
      return;
    }

    const handleResize = () => {
      setWindowSize({ width: window.innerWidth, height: window.innerHeight });
    };

    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    window.addEventListener('resize', handleResize);
    return () => {
      document.body.style.overflow = previousOverflow;
      window.removeEventListener('resize', handleResize);
    };
  }, [isExpanded]);

  const fitGraph = useCallback(() => {
    setStageScale(fitTransform.scale);
    setStagePos({ x: fitTransform.x, y: fitTransform.y });
  }, [fitTransform.scale, fitTransform.x, fitTransform.y]);

  useEffect(() => {
    fitGraph();
  }, [fitGraph]);

  const handleStageWheel = (e: Konva.KonvaEventObject<WheelEvent>) => {
    e.evt.preventDefault();
    const stage = e.target.getStage();
    if (!stage) return;

    const pointer = stage.getPointerPosition();
    if (!pointer) return;

    const scaleBy = 1.1;
    const newScale = e.evt.deltaY < 0 ? stageScale * scaleBy : stageScale / scaleBy;
    const clampedScale = Math.max(0.12, Math.min(newScale, 3));

    const oldScale = stageScale;
    const x = pointer.x - (pointer.x - stagePos.x) * (clampedScale / oldScale);
    const y = pointer.y - (pointer.y - stagePos.y) * (clampedScale / oldScale);

    setStageScale(clampedScale);
    setStagePos({ x, y });
  };

  const handleStageDragEnd = (e: Konva.KonvaEventObject<DragEvent>) => {
    const stage = e.target as Konva.Stage;
    setStagePos({ x: stage.x(), y: stage.y() });
  };

  return (
    <div
      style={{
        width: mapWidth,
        height: mapHeight,
        position: 'relative',
        overflow: 'hidden',
        backgroundColor: '#f9fafb',
        ...(isExpanded
          ? {
              position: 'fixed',
              inset: 0,
              zIndex: 80,
            }
          : {}),
      }}
    >
      <div
        style={{
          position: 'absolute',
          top: 10,
          left: 10,
          zIndex: 10,
          display: 'flex',
          alignItems: 'center',
          gap: 12,
          padding: '8px 10px',
          borderRadius: 8,
          background: 'rgba(255,255,255,0.92)',
          border: '1px solid #d1d5db',
        }}
      >
        <button
          type="button"
          onClick={() => setIsExpanded((value) => !value)}
          style={{
            border: '1px solid #9ca3af',
            borderRadius: 6,
            background: '#ffffff',
            color: '#111827',
            fontSize: 12,
            padding: '4px 8px',
            cursor: 'pointer',
          }}
        >
          {isExpanded ? 'Exit Full Screen' : 'Full Screen'}
        </button>
        <button
          type="button"
          onClick={fitGraph}
          style={{
            border: '1px solid #9ca3af',
            borderRadius: 6,
            background: '#ffffff',
            color: '#111827',
            fontSize: 12,
            padding: '4px 8px',
            cursor: 'pointer',
          }}
        >
          Fit
        </button>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#111827' }}>
          <input
            type="checkbox"
            checked={showSupplyDiffusers}
            onChange={(event) => setShowSupplyDiffusers(event.target.checked)}
          />
          Supply Diffusers
        </label>
        <label style={{ display: 'flex', alignItems: 'center', gap: 6, fontSize: 12, color: '#111827' }}>
          <input
            type="checkbox"
            checked={showReturnGrilles}
            onChange={(event) => setShowReturnGrilles(event.target.checked)}
          />
          Return Grilles
        </label>
      </div>

      <Stage
        width={mapWidth}
        height={mapHeight}
        x={stagePos.x}
        y={stagePos.y}
        scaleX={stageScale}
        scaleY={stageScale}
        draggable
        onWheel={handleStageWheel}
        onDragEnd={handleStageDragEnd}
      >
        <Layer>

        {/* Edges */}
        {visibleTopology.edges.map((edge) => {
          const from = positions.get(edge.fromId);
          const to = positions.get(edge.toId);
          if (!from || !to) {
            return null;
          }

          const dx = to.x - from.x;
          const dy = to.y - from.y;
          const length = Math.hypot(dx, dy);
          if (length < 1) {
            return null;
          }

          const ux = dx / length;
          const uy = dy / length;
          const nodeRadius = 11;
          const startPad = nodeRadius + 2;
          const endPad = nodeRadius + 3;
          const startX = from.x + ux * startPad;
          const startY = from.y + uy * startPad;
          const endX = to.x - ux * endPad;
          const endY = to.y - uy * endPad;

          return (
            <Arrow
              key={`${edge.fromId}->${edge.toId}`}
              points={[startX, startY, endX, endY]}
              stroke={edge.inferred ? '#9ca3af' : '#6b7280'}
              strokeWidth={2.25}
              fill={edge.inferred ? '#9ca3af' : '#6b7280'}
              dash={edge.inferred ? [8, 6] : undefined}
              pointerLength={8}
              pointerWidth={8}
              opacity={edge.inferred ? 0.7 : 0.85}
            />
          );
        })}

        {/* Nodes */}
        {visibleTopology.nodes.map((node) => {
          const point = positions.get(node.id);
          if (!point) {
            return null;
          }

          const fill = nodeColor(node.brickClass);

          return (
            <Group key={node.id}>
              <Circle
                x={point.x}
                y={point.y}
                radius={11}
                fill={fill}
                stroke="#e5e7eb"
                strokeWidth={2}
                onClick={() => onAssetClick?.(node.id)}
              />
              <Text
                x={point.x - 72}
                y={point.y - 30}
                width={144}
                align="center"
                text={node.label}
                fontSize={12}
                fill="#111827"
              />
            </Group>
          );
        })}

        {/* Empty state messages */}
        {visibleTopology.nodes.length === 0 ? (
          <Text
            x={24}
            y={24}
            text="No HVAC topology nodes found in source."
            fontSize={14}
            fill="#6b7280"
          />
        ) : null}

        {visibleTopology.edges.length === 0 && visibleTopology.nodes.length > 0 ? (
          <Text
            x={24}
            y={46}
            text="No s223:cnx connections were found for these nodes."
            fontSize={12}
            fill="#9ca3af"
          />
        ) : null}
        </Layer>
      </Stage>
    </div>
  );
}
