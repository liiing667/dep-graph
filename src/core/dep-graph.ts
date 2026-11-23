import * as _isEqual from 'lodash.isequal';
import * as graphlib from '../graphlib';
import * as types from './types';
import { createFromJSON } from './create-from-json';

export { DepGraphImpl };

type NodeId = string;
type PkgId = string;
interface GraphNode {
  pkgId: string;
  info?: types.NodeInfo;
}

/**
 * State captured for a single traversal of one immutable graph version.
 *
 * Path counting, cycle detection and parent-chain enumeration all use this
 * object. In particular, parent lists and package info are snapshotted here,
 * so a graph mutation (or a cache populated by another graph) can never make
 * one part of the result come from a different graph generation.
 */
interface TraversalContext {
  readonly generation: number;
  readonly graph: graphlib.Graph;
  readonly graphVersion: number;
  readonly epoch: string;
  readonly parents: Map<NodeId, NodeId[]>;
  readonly pkgs: Map<NodeId, types.PkgInfo>;
}

/**
 * Internal control-flow signal used when the underlying graph changes while a
 * traversal is still reading it. The public operation restarts from a fresh
 * generation instead of publishing a mixture of the old and new graph.
 */
class TraversalGenerationChangedError extends Error {
  constructor() {
    super('dep-graph changed during traversal');
    this.name = 'TraversalGenerationChangedError';
  }
}

class DepGraphImpl implements types.DepGraphInternal {
  public static SCHEMA_VERSION = '1.3.0';
  private static _nextTraversalNamespace = 1;
  private static _nextGraphId = 1;
  private static _graphIds = new WeakMap<graphlib.Graph, number>();

  public static getPkgId(pkg: types.Pkg): string {
    return `${pkg.name}@${pkg.version || ''}`;
  }

  private _pkgList: types.PkgInfo[];
  private _depPkgsList: types.PkgInfo[];

  private _rootPkgId: PkgId;

  private _countNodePathsToRootCache: Map<NodeId, number> = new Map();
  private _countNodePathsToRootCacheMeta: Map<
    NodeId,
    { epoch: string; count: number }
  > = new Map();
  private _countNodePathsToRootCacheCurrentEpoch: string | undefined;

  private _hasCycles: boolean | undefined;
  private _hasCyclesGraph: graphlib.Graph | undefined;
  private _hasCyclesGraphVersion: number | undefined;

  private _traversalGeneration = 0;
  private readonly _traversalNamespace =
    DepGraphImpl._nextTraversalNamespace++;

  public constructor(
    private _graph: graphlib.Graph,
    private _rootNodeId: NodeId,
    private _pkgs: Record<PkgId, types.PkgInfo>,
    private _pkgNodes: Record<PkgId, Set<NodeId>>,
    private _pkgManager: types.PkgManager,
  ) {
    this._rootPkgId = (_graph.node(_rootNodeId) as GraphNode).pkgId;

    this._pkgList = Object.values(_pkgs);
    this._depPkgsList = this._pkgList.filter((pkg) => pkg !== this.rootPkg);
  }

  get pkgManager() {
    return this._pkgManager;
  }

  get rootPkg(): types.PkgInfo {
    return this._pkgs[this._rootPkgId];
  }

  get rootNodeId(): string {
    return this._rootNodeId;
  }

  /**
   * Get all unique packages in the graph (including the root package)
   */
  public getPkgs(): types.PkgInfo[] {
    return this._pkgList;
  }

  /**
   * Get all unique packages in the graph (excluding the root package)
   */
  public getDepPkgs(): types.PkgInfo[] {
    return this._depPkgsList;
  }

  public getPkgNodes(pkg: types.Pkg): types.Node[] {
    const pkgId = DepGraphImpl.getPkgId(pkg);

    const nodes: types.Node[] = [];
    for (const nodeId of Array.from(this._pkgNodes[pkgId])) {
      const graphNode = this.getGraphNode(nodeId);

      nodes.push({
        info: graphNode.info || {},
      });
    }

    return nodes;
  }

  public getNode(nodeId: string): types.NodeInfo {
    return this.getGraphNode(nodeId).info || {};
  }

  public getNodePkg(nodeId: string): types.PkgInfo {
    return this._pkgs[this.getGraphNode(nodeId).pkgId];
  }

  public getPkgNodeIds(pkg: types.Pkg): string[] {
    const pkgId = DepGraphImpl.getPkgId(pkg);

    if (!this._pkgs[pkgId]) {
      throw new Error(`no such pkg: ${pkgId}`);
    }

    return Array.from(this._pkgNodes[pkgId]);
  }

  public getNodeDepsNodeIds(nodeId: string): string[] {
    const deps = this._graph.successors(nodeId);
    if (!deps) {
      throw new Error(`no such node: ${nodeId}`);
    }
    return deps;
  }

  public getNodeParentsNodeIds(nodeId: string): string[] {
    const parents = this._graph.predecessors(nodeId);
    if (!parents) {
      throw new Error(`no such node: ${nodeId}`);
    }
    return parents;
  }

  public hasCycles(): boolean {
    if (
      this._hasCycles !== undefined &&
      this._hasCyclesGraph === this._graph &&
      this._hasCyclesGraphVersion === this._graph.version
    ) {
      return this._hasCycles;
    }
    return this.runTraversal((traversal) =>
      this.hasCyclesForTraversal(traversal),
    );
  }

  public pkgPathsToRoot(
    pkg: types.Pkg,
    opts?: { limit?: number },
  ): types.PkgInfo[][] {
    return this.runTraversal((traversal) => {
      const pathsToRoot: types.PkgInfo[][] = [];
      const limit = opts?.limit;

      for (const nodeId of this.getPkgNodeIds(pkg)) {
        const pathsFromNodeToRoot = this.pathsFromNodeToRoot(
          nodeId,
          [],
          { limit },
          traversal,
        );

        for (const path of pathsFromNodeToRoot) {
          pathsToRoot.push(path);
        }

        if (limit && pathsToRoot.length >= limit) {
          break;
        }
      }
      this.assertTraversalCurrent(traversal);
      // note: sorting to get shorter paths first -
      //  it's nicer - and better resembles older behaviour
      return pathsToRoot.sort((a, b) => a.length - b.length);
    });
  }

  public countPathsToRoot(pkg: types.Pkg, opts?: { limit?: number }): number {
    return this.runTraversal((traversal) => {
      let count = 0;
      const limit = opts?.limit;
      for (const nodeId of this.getPkgNodeIds(pkg)) {
        count += this.countNodePathsToRoot(nodeId, limit, traversal);
        if (limit && count >= limit) {
          this.assertTraversalCurrent(traversal);
          return limit;
        }
      }
      this.assertTraversalCurrent(traversal);
      return count;
    });
  }

  public isTransitive(pkg: types.Pkg): boolean {
    const checking = new Set(this.getPkgNodeIds(pkg));
    for (const directDep of this.getNodeDepsNodeIds(this.rootNodeId)) {
      if (checking.has(directDep)) return false;
    }
    return true;
  }

  public equals(
    other: types.DepGraph,
    { compareRoot = true }: { compareRoot?: boolean } = {},
  ): boolean {
    let otherDepGraph;

    if (other instanceof DepGraphImpl) {
      otherDepGraph = other as types.DepGraphInternal;
    } else {
      // At runtime theoretically we can have multiple versions of
      // @snyk/dep-graph. If "other" is not an instance of the same class it is
      // safer to rebuild it from JSON.
      otherDepGraph = createFromJSON(other.toJSON()) as types.DepGraphInternal;
    }

    // In theory, for the graphs created by standard means, `_.isEquals(this._data, otherDepGraph._data)`
    // should suffice, since node IDs will be generated in a predictable way.
    // However, there might be different versions of graph and inconsistencies
    // in the ordering of the arrays, so we perform a deep comparison.
    return this.nodeEquals(
      this,
      this.rootNodeId,
      otherDepGraph,
      otherDepGraph.rootNodeId,
      compareRoot,
    );
  }

  public directDepsLeadingTo(pkg: types.Pkg): types.PkgInfo[] {
    return this.runTraversal((traversal) => {
      const pkgNodes = this.getPkgNodeIds(pkg);
      const directDeps = this.getNodeDepsNodeIds(this.rootNodeId);
      const nodes = directDeps.filter((directDep) => {
        const reachableNodes = graphlib.alg.postorder(this._graph, [directDep]);
        return reachableNodes.filter((node) => pkgNodes.includes(node)).length;
      });
      this.assertTraversalCurrent(traversal);
      return nodes.map((node) => this.getNodePkg(node));
    });
  }

  /**
   * Create a JSON representation of a dep graph. This is typically used to
   * send the dep graph over the wire
   */
  public toJSON(): types.DepGraphData {
    const nodeIds = this._graph.nodes();

    const nodes = nodeIds.reduce((acc: types.GraphNode[], nodeId: string) => {
      const deps = (this._graph.successors(nodeId) || []).map((depNodeId) => ({
        nodeId: depNodeId,
      }));

      const node = this._graph.node(nodeId) as GraphNode;
      const elem: types.GraphNode = {
        nodeId,
        pkgId: node.pkgId,
        deps,
      };
      if (node.info && Object.keys(node.info).length > 0) {
        elem.info = node.info;
      }
      acc.push(elem);
      return acc;
    }, []);

    const pkgs: Array<{ id: string; info: types.PkgInfo }> = Object.keys(
      this._pkgs,
    ).map((pkgId: string) => ({
      id: pkgId,
      info: this._pkgs[pkgId],
    }));

    return {
      schemaVersion: DepGraphImpl.SCHEMA_VERSION,
      pkgManager: this._pkgManager,
      pkgs,
      graph: {
        rootNodeId: this._rootNodeId,
        nodes,
      },
    };
  }

  private nodeEquals(
    graphA: types.DepGraphInternal,
    nodeIdA: string,
    graphB: types.DepGraphInternal,
    nodeIdB: string,
    compareRoot: boolean,
    traversedPairs = new Set<string>(),
  ): boolean {
    // Skip root nodes comparison if needed.
    if (
      compareRoot ||
      (nodeIdA !== graphA.rootNodeId && nodeIdB !== graphB.rootNodeId)
    ) {
      const pkgA = graphA.getNodePkg(nodeIdA);
      const pkgB = graphB.getNodePkg(nodeIdB);

      // Compare PkgInfo (name and version).
      if (!_isEqual(pkgA, pkgB)) {
        return false;
      }

      const infoA = graphA.getNode(nodeIdA);
      const infoB = graphB.getNode(nodeIdB);

      // Compare NodeInfo (VersionProvenance and labels).
      if (!_isEqual(infoA, infoB)) {
        return false;
      }
    }

    let depsA = graphA.getNodeDepsNodeIds(nodeIdA);
    let depsB = graphB.getNodeDepsNodeIds(nodeIdB);

    // Number of dependencies should be the same.
    if (depsA.length !== depsB.length) {
      return false;
    }

    // Sort dependencies by name@version string.
    const sortFn =
      (graph: types.DepGraphInternal) => (idA: string, idB: string) => {
        const pkgA = graph.getNodePkg(idA);
        const pkgB = graph.getNodePkg(idB);
        return DepGraphImpl.getPkgId(pkgA).localeCompare(
          DepGraphImpl.getPkgId(pkgB),
        );
      };

    depsA = depsA.sort(sortFn(graphA));
    depsB = depsB.sort(sortFn(graphB));

    // Compare Each dependency recursively.
    for (let i = 0; i < depsA.length; i++) {
      const pairKey = `${depsA[i]}_${depsB[i]}`;

      // Prevent cycles.
      if (traversedPairs.has(pairKey)) {
        continue;
      }

      traversedPairs.add(pairKey);

      if (
        !this.nodeEquals(
          graphA,
          depsA[i],
          graphB,
          depsB[i],
          compareRoot,
          traversedPairs,
        )
      ) {
        return false;
      }
    }

    return true;
  }

  private getGraphNode(nodeId: string): GraphNode {
    const node = this._graph.node(nodeId) as GraphNode;
    if (!node) {
      throw new Error(`no such node: ${nodeId}`);
    }
    return node;
  }

  /**
   * Run an operation against one graph version. If the graph is mutated while
   * the operation is running (for example by a re-entrant consumer), discard
   * the partial result and start again with a fresh generation.
   */
  private runTraversal<T>(fn: (traversal: TraversalContext) => T): T {
    // The first retry handles the common "replace the graph once" case. A few
    // more attempts make re-entrant caches resilient, while still failing
    // closed instead of returning a mixed-generation result under constant
    // mutation.
    const maxAttempts = 8;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const traversal = this.startTraversal();
      try {
        const result = fn(traversal);
        if (this.isTraversalCurrent(traversal)) {
          return result;
        }
      } catch (error) {
        if (!(error instanceof TraversalGenerationChangedError)) {
          throw error;
        }
      }
    }

    throw new Error(
      'dep-graph changed repeatedly during traversal; refusing to return a mixed-generation result',
    );
  }

  private startTraversal(): TraversalContext {
    const graph = this._graph;
    const graphVersion = graph.version;
    const graphId = DepGraphImpl.getGraphId(graph);
    const epoch = `${this._traversalNamespace}:${graphId}:${graphVersion}`;

    if (this._countNodePathsToRootCacheCurrentEpoch !== epoch) {
      this._countNodePathsToRootCache.clear();
      this._countNodePathsToRootCacheMeta.clear();
      this._countNodePathsToRootCacheCurrentEpoch = epoch;
      this._hasCycles = undefined;
      this._hasCyclesGraph = undefined;
      this._hasCyclesGraphVersion = undefined;
    }

    return {
      generation: ++this._traversalGeneration,
      graph,
      graphVersion,
      epoch,
      parents: new Map(),
      pkgs: new Map(),
    };
  }

  private static getGraphId(graph: graphlib.Graph): number {
    let graphId = DepGraphImpl._graphIds.get(graph);
    if (graphId === undefined) {
      graphId = DepGraphImpl._nextGraphId++;
      DepGraphImpl._graphIds.set(graph, graphId);
    }
    return graphId;
  }

  private isTraversalCurrent(traversal: TraversalContext): boolean {
    return (
      this._graph === traversal.graph &&
      this._graph.version === traversal.graphVersion
    );
  }

  private assertTraversalCurrent(traversal: TraversalContext): void {
    if (!this.isTraversalCurrent(traversal)) {
      throw new TraversalGenerationChangedError();
    }
  }

  private getParentsForTraversal(
    traversal: TraversalContext,
    nodeId: NodeId,
  ): NodeId[] {
    const memoized = traversal.parents.get(nodeId);
    if (memoized) {
      return memoized;
    }

    this.assertTraversalCurrent(traversal);
    const parents = this.getNodeParentsNodeIds(nodeId).slice();
    this.assertTraversalCurrent(traversal);
    traversal.parents.set(nodeId, parents);
    return parents;
  }

  private getPkgForTraversal(
    traversal: TraversalContext,
    nodeId: NodeId,
  ): types.PkgInfo {
    const memoized = traversal.pkgs.get(nodeId);
    if (memoized) {
      return memoized;
    }

    this.assertTraversalCurrent(traversal);
    const pkg = this.getNodePkg(nodeId);
    this.assertTraversalCurrent(traversal);
    traversal.pkgs.set(nodeId, pkg);
    return pkg;
  }

  private getCachedPathCount(
    nodeId: NodeId,
    epoch: string,
  ): number | undefined {
    const cachedCount = this._countNodePathsToRootCache.get(nodeId);
    if (cachedCount === undefined) {
      return undefined;
    }

    const meta = this._countNodePathsToRootCacheMeta.get(nodeId);
    if (!meta || meta.epoch !== epoch || meta.count !== cachedCount) {
      this._countNodePathsToRootCache.delete(nodeId);
      this._countNodePathsToRootCacheMeta.delete(nodeId);
      return undefined;
    }

    return cachedCount;
  }

  private cachePathCount(nodeId: NodeId, epoch: string, count: number): void {
    this._countNodePathsToRootCache.set(nodeId, count);
    this._countNodePathsToRootCacheMeta.set(nodeId, { epoch, count });
  }

  private hasCyclesForTraversal(traversal: TraversalContext): boolean {
    if (
      this._hasCycles !== undefined &&
      this._hasCyclesGraph === traversal.graph &&
      this._hasCyclesGraphVersion === traversal.graphVersion
    ) {
      return this._hasCycles;
    }

    const hasCycles = !graphlib.alg.isAcyclic(this._graph);
    this.assertTraversalCurrent(traversal);
    this._hasCycles = hasCycles;
    this._hasCyclesGraph = traversal.graph;
    this._hasCyclesGraphVersion = traversal.graphVersion;
    return hasCycles;
  }

  private pathsFromNodeToRoot(
    nodeId: string,
    ancestors: string[] = [],
    opts: { limit?: number },
    traversal?: TraversalContext,
  ): types.PkgInfo[][] {
    const activeTraversal = traversal || this.startTraversal();
    const parentNodesIds = this.getParentsForTraversal(activeTraversal, nodeId);
    const pkgInfo = this.getPkgForTraversal(activeTraversal, nodeId);

    if (nodeId === this._rootNodeId || parentNodesIds.length === 0) {
      this.assertTraversalCurrent(activeTraversal);
      return [[pkgInfo]];
    }

    const allPaths: types.PkgInfo[][] = [];
    ancestors = ancestors.concat(nodeId);
    const limit = opts.limit;

    for (const id of parentNodesIds) {
      if (ancestors.includes(id)) continue;

      const pathsFromNodeToRoot = this.pathsFromNodeToRoot(
        id,
        ancestors,
        opts,
        activeTraversal,
      );

      for (const path of pathsFromNodeToRoot) {
        allPaths.push([pkgInfo].concat(path));
      }

      if (limit && allPaths.length >= limit) {
        break;
      }
    }

    this.assertTraversalCurrent(activeTraversal);
    return allPaths;
  }

  private countNodePathsToRoot(
    nodeId: string,
    limit?: number,
    traversal?: TraversalContext,
  ): number {
    const activeTraversal = traversal || this.startTraversal();
    const cached = this.getCachedPathCount(nodeId, activeTraversal.epoch);
    if (cached !== undefined) {
      this.assertTraversalCurrent(activeTraversal);
      return cached;
    }

    let count: number;
    if (nodeId === this._rootNodeId) {
      count = 1;
    } else if (this.hasCycles()) {
      // When cycles exist, we must walk every path individually to avoid
      // counting paths that loop back on themselves.
      count = this.countNodePathsToRootBacktracking(
        nodeId,
        limit,
        0,
        new Set(),
        activeTraversal,
      );
    } else {
      // Without cycles, we can compute path counts by summing each parent's
      // count. This avoids the exponential cost of enumerating every path.
      count = this.countNodePathsToRootMemoized(nodeId, limit, activeTraversal);
    }

    if (!limit) {
      this.assertTraversalCurrent(activeTraversal);
      this.cachePathCount(nodeId, activeTraversal.epoch, count);
    }
    this.assertTraversalCurrent(activeTraversal);
    return count;
  }

  /**
   * Memoized path counting, the count is the sum of the counts of the parents.
   * Only valid for acyclic graphs.
   */
  private countNodePathsToRootMemoized(
    nodeId: string,
    limit = 0,
    traversal?: TraversalContext,
  ): number {
    const activeTraversal = traversal || this.startTraversal();
    let count = 0;
    for (const parentNodeId of this.getParentsForTraversal(
      activeTraversal,
      nodeId,
    )) {
      count += this.countNodePathsToRoot(parentNodeId, limit, activeTraversal);
      if (limit && count >= limit) {
        this.assertTraversalCurrent(activeTraversal);
        return limit;
      }
    }
    this.assertTraversalCurrent(activeTraversal);
    return count;
  }

  /**
   * Backtracking approach that enumerates simple paths.
   * Required for cyclic graphs where memoization is not applicable.
   */
  private countNodePathsToRootBacktracking(
    nodeId: string,
    limit = 0,
    count = 0,
    visited: Set<string> = new Set(),
    traversal?: TraversalContext,
  ): number {
    const activeTraversal = traversal || this.startTraversal();
    if (nodeId === this._rootNodeId) {
      this.assertTraversalCurrent(activeTraversal);
      return count + 1;
    }
    visited.add(nodeId);
    for (const parentNodeId of this.getParentsForTraversal(
      activeTraversal,
      nodeId,
    )) {
      if (visited.has(parentNodeId)) {
        continue;
      }
      count = this.countNodePathsToRootBacktracking(
        parentNodeId,
        limit,
        count,
        visited,
        activeTraversal,
      );
      if (limit && count >= limit) {
        visited.delete(nodeId);
        this.assertTraversalCurrent(activeTraversal);
        return limit;
      }
    }
    visited.delete(nodeId);
    this.assertTraversalCurrent(activeTraversal);
    return count;
  }
}
