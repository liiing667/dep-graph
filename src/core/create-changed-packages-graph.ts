import { DepGraph, DepGraphInternal, NodeInfo, PkgInfo } from './types';
import { DepGraphImpl } from './dep-graph';
import { DepGraphBuilder } from './builder';
import { ValidationError } from './errors';
import { eventLoopSpinner } from 'event-loop-spinner';

type NodeId = string;
type PkgId = string;

interface PackageSnapshot {
  pkg: PkgInfo;
  pkgId: PkgId;
  nodeIds: NodeId[];
}

/**
 * Creates an induced subgraph of  {@param graphB} with only packages
 * that are not present in {@param graphA} or have a different version.
 *
 * The returned graph is tied to `graphB`'s current generation: the root node
 * id, root package info and root node info all come from `graphB`. Every
 * changed package node is connected to that root, and a changed package that
 * is not reachable from the root is rejected instead of being published as an
 * isolated node.
 *
 * @param graphA
 * @param graphB
 */
export async function createChangedPackagesGraph(
  graphA: DepGraph,
  graphB: DepGraph,
): Promise<DepGraph> {
  const depGraph = graphB as DepGraphInternal;

  // Snapshot the comparison input once. From here on both the change set and
  // the parent chains are derived from exactly the same two generations.
  const graphAPackageIds = new Set(
    graphA.getDepPkgs().map(DepGraphImpl.getPkgId),
  );
  const graphBPackages = getPackageSnapshots(depGraph);

  const changedNodeIds = new Set<NodeId>();
  for (const { pkg, nodeIds } of graphBPackages) {
    if (graphAPackageIds.has(DepGraphImpl.getPkgId(pkg))) {
      continue;
    }

    for (const nodeId of nodeIds) {
      changedNodeIds.add(nodeId);
    }
    if (eventLoopSpinner.isStarving()) {
      await eventLoopSpinner.spin();
    }
  }

  // Parent chains are only valid inside the current graph. A node that cannot
  // be reached from `graphB`'s root cannot have a genuine path back to that
  // root, so fail instead of returning a changed graph with orphan nodes.
  const reachableNodeIds = getReachableNodeIds(depGraph);
  for (const nodeId of changedNodeIds) {
    if (!reachableNodeIds.has(nodeId)) {
      throw new ValidationError(
        `changed package node "${nodeId}" (${DepGraphImpl.getPkgId(
          depGraph.getNodePkg(nodeId),
        )}) is not reachable from root "${depGraph.rootNodeId}"`,
      );
    }
  }

  const selectedNodeIds = new Set<NodeId>([depGraph.rootNodeId]);
  const edgesByParent = new Map<NodeId, Set<NodeId>>();
  const nodesToVisit: NodeId[] = [];
  const expandedNodeIds = new Set<NodeId>([depGraph.rootNodeId]);

  const enqueueNode = (nodeId: NodeId) => {
    selectedNodeIds.add(nodeId);
    if (expandedNodeIds.has(nodeId)) {
      return;
    }
    expandedNodeIds.add(nodeId);
    nodesToVisit.push(nodeId);
  };

  for (const nodeId of changedNodeIds) {
    enqueueNode(nodeId);
  }

  while (nodesToVisit.length > 0) {
    const nodeId = nodesToVisit.pop()!;

    const parentIds = depGraph.getNodeParentsNodeIds(nodeId);
    for (const parentId of parentIds) {
      // Ignore stray parent edges pointing in from a node that is not part of
      // the current root's graph.
      if (!reachableNodeIds.has(parentId)) {
        continue;
      }

      selectedNodeIds.add(parentId);
      addEdge(edgesByParent, parentId, nodeId);
      enqueueNode(parentId);

      if (eventLoopSpinner.isStarving()) {
        await eventLoopSpinner.spin();
      }
    }
  }

  // Build in a deterministic order so reordering `graphB`'s nodes or edges
  // does not reorder the result.
  const nodeSortKeys = new Map<NodeId, string>();
  for (const nodeId of selectedNodeIds) {
    nodeSortKeys.set(nodeId, getNodeSortKey(depGraph, nodeId));
  }

  const sortedNodeIds = Array.from(selectedNodeIds)
    .filter((nodeId) => nodeId !== depGraph.rootNodeId)
    .sort((a, b) => compareStrings(nodeSortKeys.get(a)!, nodeSortKeys.get(b)!));

  const depGraphBuilder = new DepGraphBuilder(
    depGraph.pkgManager,
    depGraph.rootPkg,
    getNodeInfo(depGraph, depGraph.rootNodeId),
    { rootNodeId: depGraph.rootNodeId },
  );

  for (const nodeId of sortedNodeIds) {
    depGraphBuilder.addPkgNode(
      depGraph.getNodePkg(nodeId),
      nodeId,
      getNodeInfo(depGraph, nodeId),
    );

    if (eventLoopSpinner.isStarving()) {
      await eventLoopSpinner.spin();
    }
  }

  const edges = getSortedEdges(edgesByParent, nodeSortKeys);
  for (const [parentId, dependencyNodeId] of edges) {
    depGraphBuilder.connectDep(parentId, dependencyNodeId);

    if (eventLoopSpinner.isStarving()) {
      await eventLoopSpinner.spin();
    }
  }

  return depGraphBuilder.build();
}

function getPackageSnapshots(depGraph: DepGraphInternal): PackageSnapshot[] {
  const snapshots = new Map<PkgId, PackageSnapshot>();

  for (const pkg of depGraph.getDepPkgs()) {
    const pkgId = DepGraphImpl.getPkgId(pkg);
    const existing = snapshots.get(pkgId);
    if (existing) {
      existing.pkg = pkg;
      continue;
    }

    snapshots.set(pkgId, {
      pkg,
      pkgId,
      nodeIds: depGraph.getPkgNodeIds(pkg).slice(),
    });
  }

  return Array.from(snapshots.values()).sort((a, b) =>
    compareStrings(a.pkgId, b.pkgId),
  );
}

function getReachableNodeIds(depGraph: DepGraphInternal): Set<NodeId> {
  const reachable = new Set<NodeId>([depGraph.rootNodeId]);
  const stack: NodeId[] = [depGraph.rootNodeId];

  while (stack.length > 0) {
    const nodeId = stack.pop()!;
    for (const dependencyNodeId of depGraph.getNodeDepsNodeIds(nodeId)) {
      if (reachable.has(dependencyNodeId)) {
        continue;
      }
      reachable.add(dependencyNodeId);
      stack.push(dependencyNodeId);
    }
  }

  return reachable;
}

function addEdge(
  edgesByParent: Map<NodeId, Set<NodeId>>,
  parentId: NodeId,
  dependencyNodeId: NodeId,
): void {
  let dependencies = edgesByParent.get(parentId);
  if (!dependencies) {
    dependencies = new Set<NodeId>();
    edgesByParent.set(parentId, dependencies);
  }
  dependencies.add(dependencyNodeId);
}

function getSortedEdges(
  edgesByParent: Map<NodeId, Set<NodeId>>,
  nodeSortKeys: Map<NodeId, string>,
): Array<[NodeId, NodeId]> {
  const edges: Array<[NodeId, NodeId]> = [];

  for (const [parentId, dependencies] of edgesByParent) {
    for (const dependencyNodeId of dependencies) {
      edges.push([parentId, dependencyNodeId]);
    }
  }

  return edges.sort(([parentA, dependencyA], [parentB, dependencyB]) => {
    const byParent = compareStrings(
      nodeSortKeys.get(parentA)!,
      nodeSortKeys.get(parentB)!,
    );
    if (byParent !== 0) {
      return byParent;
    }
    return compareStrings(
      nodeSortKeys.get(dependencyA)!,
      nodeSortKeys.get(dependencyB)!,
    );
  });
}

function getNodeSortKey(depGraph: DepGraphInternal, nodeId: NodeId): string {
  return `${DepGraphImpl.getPkgId(depGraph.getNodePkg(nodeId))}\u0000${nodeId}`;
}

function compareStrings(a: string, b: string): number {
  if (a < b) {
    return -1;
  }
  if (a > b) {
    return 1;
  }
  return 0;
}

function getNodeInfo(
  depGraph: DepGraphInternal,
  nodeId: string,
): NodeInfo | undefined {
  const nodeInfo: NodeInfo = depGraph.getNode(nodeId);
  if (!nodeInfo || Object.keys(nodeInfo).length === 0) {
    return undefined;
  }
  return nodeInfo;
}
