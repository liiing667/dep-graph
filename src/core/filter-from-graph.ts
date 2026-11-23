import { DepGraph, DepGraphInternal, NodeInfo, PkgInfo } from './types';
import { DepGraphBuilder } from './builder';

type NodeId = string;
type PkgName = string;

export async function filterPackagesFromGraph(
  originalDepGraph: DepGraph,
  packagesToFilterOut: (PkgName | PkgInfo)[],
): Promise<DepGraph> {
  if (!packagesToFilterOut?.length) return originalDepGraph;

  const depGraph = originalDepGraph as DepGraphInternal;

  const packages = depGraph
    .getDepPkgs()
    .filter((existingPkg) =>
      packagesToFilterOut.some((pkgToFilter) =>
        isString(pkgToFilter)
          ? existingPkg.name === pkgToFilter
          : existingPkg.name === pkgToFilter.name &&
            existingPkg.version === pkgToFilter.version,
      ),
    );

  const nodeIdsToFilterOut: NodeId[] = [];
  for (const pkg of packages) {
    const nodeIds = depGraph.getPkgNodeIds(pkg);
    for (const nodeId of nodeIds) {
      nodeIdsToFilterOut.push(nodeId);
    }
  }

  return filterNodesFromGraph(originalDepGraph, nodeIdsToFilterOut);
}

export async function filterNodesFromGraph(
  originalDepGraph: DepGraph,
  nodeIdsToFilterOut: NodeId[],
): Promise<DepGraph> {
  if (!nodeIdsToFilterOut?.length) return originalDepGraph;

  const depGraph = originalDepGraph as DepGraphInternal;
  const existingNodeIds: Set<NodeId> = new Set(depGraph['_graph'].nodes());
  nodeIdsToFilterOut = nodeIdsToFilterOut.filter((nodeId) =>
    existingNodeIds.has(nodeId),
  );
  if (nodeIdsToFilterOut.length === 0) return originalDepGraph;

  const nodeIdsToFilterOutSet = new Set(nodeIdsToFilterOut);

  // Compute the set of nodes that remain reachable from the root once the
  // filtered-out nodes are removed. A node only survives when every edge on
  // at least one root-to-node path survives; descendants that become
  // unreachable (including nodes shared with an "unfiltered" ancestor) are
  // dropped here instead of being pulled back in by a sibling path later on.
  // This single reachable set drives both the subgraph reconstruction and the
  // parent-chain reporting, so they can never disagree.
  const reachableNodeIds = collectReachableNodeIds(
    depGraph,
    nodeIdsToFilterOutSet,
  );

  // Nothing reachable was removed (e.g. only already-orphaned nodes matched):
  // keep returning the original instance, preserving reference equality. The
  // root can never be orphaned, so equal cardinality here means every node
  // (including the root) stayed reachable.
  if (reachableNodeIds.size === existingNodeIds.size) {
    return originalDepGraph;
  }

  const depGraphBuilder = new DepGraphBuilder(
    depGraph.pkgManager,
    depGraph.rootPkg,
  );

  // Rebuild the subgraph strictly from the reachable set. Every edge of a
  // reachable node whose other endpoint is also reachable is reproduced, so
  // legitimate sibling edges of shared ancestors are kept. The `visited`
  // guard makes this safe for cyclic graphs.
  const visitedNodeIds: Set<NodeId> = new Set([depGraph.rootNodeId]);
  const queue: NodeId[] = [depGraph.rootNodeId];

  while (queue.length > 0) {
    const nodeId = queue.pop()!;

    for (const depNodeId of depGraph.getNodeDepsNodeIds(nodeId)) {
      if (!reachableNodeIds.has(depNodeId)) continue;

      const pkgInfo = depGraph.getNodePkg(depNodeId);
      let nodeInfo: NodeInfo | undefined = depGraph.getNode(depNodeId);
      if (isEmpty(nodeInfo)) nodeInfo = undefined;

      depGraphBuilder.addPkgNode(pkgInfo, depNodeId, nodeInfo);
      depGraphBuilder.connectDep(nodeId, depNodeId);

      if (!visitedNodeIds.has(depNodeId)) {
        visitedNodeIds.add(depNodeId);
        queue.push(depNodeId);
      }
    }
  }

  return depGraphBuilder.build();
}

/**
 * Walk the graph from the root, never crossing a filtered-out node, and
 * return the set of node ids that stay reachable. The walk is cycle-safe:
 * each node is enqueued at most once.
 */
function collectReachableNodeIds(
  depGraph: DepGraphInternal,
  nodeIdsToFilterOut: Set<NodeId>,
): Set<NodeId> {
  const reachableNodeIds: Set<NodeId> = new Set();

  if (nodeIdsToFilterOut.has(depGraph.rootNodeId)) {
    return reachableNodeIds;
  }

  const queue: NodeId[] = [depGraph.rootNodeId];
  reachableNodeIds.add(depGraph.rootNodeId);

  while (queue.length > 0) {
    const nodeId = queue.pop()!;

    for (const depNodeId of depGraph.getNodeDepsNodeIds(nodeId)) {
      if (
        nodeIdsToFilterOut.has(depNodeId) ||
        reachableNodeIds.has(depNodeId)
      ) {
        continue;
      }

      reachableNodeIds.add(depNodeId);
      queue.push(depNodeId);
    }
  }

  return reachableNodeIds;
}

function isString(pkgToFilter: string | PkgInfo): pkgToFilter is string {
  return typeof pkgToFilter === 'string';
}

function isEmpty(obj) {
  return !obj || Object.keys(obj).length === 0;
}
