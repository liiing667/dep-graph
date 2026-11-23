import * as graphlib from '../graphlib';
import { ValidationError } from './errors';

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new ValidationError(msg);
  }
}

export function validateGraph(
  graph: graphlib.Graph,
  rootNodeId: string,
  pkgs: { [pkgId: string]: any },
  pkgNodes: { [nodeId: string]: Set<string> },
): void {
  const rootParents = graph.predecessors(rootNodeId);
  assert(
    rootParents.length === 0,
    `"${rootNodeId}" is not really the root: it has incoming edge(s) from ${formatNodeIds(
      rootParents,
    )}`,
  );

  const reachableFromRoot = graphlib.alg.postorder(graph, [rootNodeId]);
  const reachableFromRootSet = new Set(reachableFromRoot);
  const nodeIds = graph.nodes();
  const unreachableNodeIds = nodeIds.filter(
    (nodeId) => !reachableFromRootSet.has(nodeId),
  );

  if (unreachableNodeIds.length > 0) {
    const unreachableNodeIdSet = new Set(unreachableNodeIds);
    const otherRoots = graph
      .sources()
      .filter((nodeId) => unreachableNodeIdSet.has(nodeId));
    const multipleRoots =
      otherRoots.length > 0
        ? ` (multiple roots: ${formatNodeIds([rootNodeId, ...otherRoots])})`
        : '';

    throw new ValidationError(
      `not all graph nodes are reachable from root "${rootNodeId}": ` +
        `${formatNodeIds(unreachableNodeIds)}${multipleRoots}`,
    );
  }

  const nodeIdsWithoutPkgs = nodeIds.filter((nodeId) => {
    const node = graph.node(nodeId) as { pkgId?: string } | undefined;
    return !node || typeof node.pkgId !== 'string' || !pkgs[node.pkgId];
  });
  assert(
    nodeIdsWithoutPkgs.length === 0,
    `some instance nodes belong to non-existing pkgIds: ${formatNodeIds(
      nodeIdsWithoutPkgs,
    )}`,
  );

  const pkgIds = Object.keys(pkgs);
  const pkgsWithoutInstances = pkgIds.filter(
    (pkgId) => !pkgNodes[pkgId] || pkgNodes[pkgId].size === 0,
  );
  assert(
    pkgsWithoutInstances.length === 0,
    `not all pkgs have instance nodes: ${formatNodeIds(pkgsWithoutInstances)}`,
  );
}

function formatNodeIds(nodeIds: string[]): string {
  return nodeIds.map((nodeId) => `"${nodeId}"`).join(', ');
}
