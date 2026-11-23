import * as _isEqual from 'lodash.isequal';
import * as graphlib from '../graphlib';
import * as types from './types';
import { createFromJSON } from './create-from-json';
import { TraversalIncompleteError, ValidationError } from './errors';

export { DepGraphImpl };

type NodeId = string;
type PkgId = string;
interface GraphNode {
  pkgId: string;
  info?: types.NodeInfo;
}

interface PathCountCacheEntry {
  count: number;
  status: 'complete';
}

/**
 * Per-query traversal state. A state object is never shared between two
 * public queries, which is what keeps path budgets and partial counts from
 * leaking from one package (or one graph generation) to the next.
 */
interface TraversalState {
  readonly limit?: number;
  readonly budget?: number;
  expansions: number;
  visited: Set<NodeId>;
  budgetExhausted: boolean;
  incomplete: boolean;
  limitHit: boolean;
}

interface PathFrame {
  nodeId: NodeId;
  parentIds: NodeId[];
  nextParent: number;
  pathPkgs: types.PkgInfo[];
  ancestors: Set<NodeId>;
}

function normalizeLimit(limit?: number): number | undefined {
  if (limit === undefined) return undefined;
  if (
    typeof limit !== 'number' ||
    !Number.isFinite(limit) ||
    limit < 0 ||
    !Number.isInteger(limit)
  ) {
    throw new ValidationError(
      `path limit must be a non-negative finite integer, got ${String(limit)}`,
    );
  }
  // `0` has historically meant "no limit" (the old code used truthiness).
  return limit === 0 ? undefined : limit;
}

function normalizeBudget(budget?: number): number | undefined {
  if (budget === undefined) return undefined;
  if (
    typeof budget !== 'number' ||
    !Number.isFinite(budget) ||
    budget < 0 ||
    !Number.isInteger(budget)
  ) {
    throw new ValidationError(
      `traversal budget must be a non-negative finite integer, got ${String(
        budget,
      )}`,
    );
  }
  return budget;
}

function createTraversalState(
  limit?: number,
  budget?: number,
): TraversalState {
  return {
    limit,
    budget,
    expansions: 0,
    visited: new Set<NodeId>(),
    budgetExhausted: false,
    incomplete: false,
    limitHit: false,
  };
}

function consumeNode(state: TraversalState, nodeId: NodeId): boolean {
  if (state.budget !== undefined && state.expansions >= state.budget) {
    state.budgetExhausted = true;
    return false;
  }
  state.expansions++;
  state.visited.add(nodeId);
  return true;
}

function statusOf(state: TraversalState): {
  status: types.TraversalStatus;
  reason?: types.TraversalReason;
} {
  if (state.limitHit) {
    // An explicit cap was reached and there is still work left. That is a
    // known truncation even if the traversal budget also happened to run out.
    return { status: 'truncated', reason: 'limit' };
  }
  if (state.budgetExhausted) {
    return { status: 'unknown', reason: 'budget' };
  }
  if (state.incomplete) {
    return { status: 'unknown', reason: 'unreachable-root' };
  }
  return { status: 'complete' };
}

function packageInfo(pkg: types.Pkg): types.Pkg {
  return {
    name: pkg.name,
    version: pkg.version,
  };
}

class DepGraphImpl implements types.DepGraphInternal {
  public static SCHEMA_VERSION = '1.3.0';

  public static getPkgId(pkg: types.Pkg): string {
    return `${pkg.name}@${pkg.version || ''}`;
  }

  private _pkgList: types.PkgInfo[];
  private _depPkgsList: types.PkgInfo[];

  private _rootPkgId: PkgId;

  /**
   * Only complete, unbounded counts are stored here. Limited or budgeted
   * queries never read or write this cache, so a partial count from one query
   * can never be observed by another package.
   */
  private _countNodePathsToRootCache: Map<NodeId, PathCountCacheEntry> =
    new Map();

  private _hasCycles: boolean | undefined;
  private _hasCyclesComplete = false;

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

  public hasCycles(
    opts?: types.CycleQueryOptions & { withStatus?: false },
  ): boolean | undefined;
  public hasCycles(
    opts: types.CycleQueryOptions & { withStatus: true },
  ): types.CycleStatusResult;
  public hasCycles(
    opts: types.CycleQueryOptions = {},
  ): boolean | undefined | types.CycleStatusResult {
    const result = this.hasCyclesWithStatus(opts);
    return opts.withStatus ? result : result.hasCycles;
  }

  public hasCyclesWithStatus(
    opts: types.CycleQueryOptions = {},
  ): types.CycleStatusResult {
    const requestedBudget = opts.budget ?? opts.limit;
    const budget = normalizeBudget(requestedBudget);

    if (this._hasCyclesComplete) {
      return {
        status: 'complete',
        hasCycles: this._hasCycles,
        budget: requestedBudget,
        visitedNodes: 0,
        expansions: 0,
      };
    }

    const detection = graphlib.alg.isAcyclicWithBudget(this._graph, budget);
    if (detection.complete) {
      this._hasCycles = detection.isAcyclic === false;
      this._hasCyclesComplete = true;
    }

    return {
      status: detection.complete ? 'complete' : 'unknown',
      hasCycles:
        detection.isAcyclic === undefined ? undefined : !detection.isAcyclic,
      budget: requestedBudget,
      visitedNodes: detection.visitedNodes,
      expansions: detection.expansions,
      reason: detection.complete ? undefined : 'budget',
    };
  }

  public pkgPathsToRoot(
    pkg: types.Pkg,
    opts?: types.PathQueryOptions & { withStatus?: false },
  ): types.PkgInfo[][];
  public pkgPathsToRoot(
    pkg: types.Pkg,
    opts: types.PathQueryOptions & { withStatus: true },
  ): types.PathsToRootResult;
  public pkgPathsToRoot(
    pkg: types.Pkg,
    opts: types.PathQueryOptions = {},
  ): types.PkgInfo[][] | types.PathsToRootResult {
    const result = this.pkgPathsToRootWithStatus(pkg, opts);

    if (opts.withStatus) {
      return result;
    }

    if (result.status === 'unknown' && !opts.allowIncomplete) {
      throw new TraversalIncompleteError('unknown', { ...result });
    }

    return this.attachPathArrayMetadata(result.paths, result);
  }

  public pkgPathsToRootWithStatus(
    pkg: types.Pkg,
    opts: types.PathQueryOptions = {},
  ): types.PathsToRootResult {
    const limit = normalizeLimit(opts.limit);
    const budget = normalizeBudget(opts.budget);
    const state = createTraversalState(limit, budget);
    const paths: types.PkgInfo[][] = [];
    const nodeIds = this.getPkgNodeIds(pkg);

    for (let i = 0; i < nodeIds.length; i++) {
      if (state.budgetExhausted || state.limitHit) break;

      this.enumeratePathsFromNode(
        nodeIds[i],
        state,
        i < nodeIds.length - 1,
        paths,
      );
    }

    // Note: sorting to get shorter paths first -
    //  it's nicer - and better resembles older behaviour.
    paths.sort((a, b) => a.length - b.length);

    const { status, reason } = statusOf(state);
    return {
      target: packageInfo(pkg),
      paths,
      status,
      complete: status === 'complete',
      truncated: status === 'truncated',
      unknown: status === 'unknown',
      limit: opts.limit,
      budget: opts.budget,
      visitedNodes: state.visited.size,
      expansions: state.expansions,
      reason,
    };
  }

  public countPathsToRoot(
    pkg: types.Pkg,
    opts?: types.PathQueryOptions & { withStatus?: false },
  ): number;
  public countPathsToRoot(
    pkg: types.Pkg,
    opts: types.PathQueryOptions & { withStatus: true },
  ): types.PathCountResult;
  public countPathsToRoot(
    pkg: types.Pkg,
    opts: types.PathQueryOptions = {},
  ): number | types.PathCountResult {
    const result = this.countPathsToRootWithStatus(pkg, opts);

    if (opts.withStatus) {
      return result;
    }

    if (result.status === 'unknown') {
      if (opts.allowIncomplete && result.partialCount !== undefined) {
        return result.partialCount;
      }
      throw new TraversalIncompleteError('unknown', { ...result });
    }

    return result.count as number;
  }

  public countPathsToRootWithStatus(
    pkg: types.Pkg,
    opts: types.PathQueryOptions = {},
  ): types.PathCountResult {
    const limit = normalizeLimit(opts.limit);
    const budget = normalizeBudget(opts.budget);
    // Probe one path past the caller's cap so an answer that happens to end
    // exactly at the cap can still be reported as complete.
    const probeLimit = limit === undefined ? undefined : limit + 1;
    const state = createTraversalState(probeLimit, budget);
    let count = 0;

    if (budget === undefined) {
      for (const nodeId of this.getPkgNodeIds(pkg)) {
        count += this.countNodePathsToRootComplete(nodeId, probeLimit, state);
        if (probeLimit !== undefined && count >= probeLimit) {
          count = limit as number;
          state.limitHit = true;
          break;
        }
      }
    } else {
      for (const nodeId of this.getPkgNodeIds(pkg)) {
        if (state.budgetExhausted || state.limitHit) break;

        const outcome = this.countNodePathsToRootBudgeted(nodeId, state);
        count += outcome.count;
        if (probeLimit !== undefined && count >= probeLimit) {
          count = limit as number;
          state.limitHit = true;
          break;
        }
        if (outcome.status === 'unknown') break;
      }
    }

    const { status, reason } = statusOf(state);
    return {
      target: packageInfo(pkg),
      count: status === 'unknown' ? undefined : count,
      partialCount: status === 'unknown' ? count : undefined,
      status,
      complete: status === 'complete',
      truncated: status === 'truncated',
      unknown: status === 'unknown',
      limit: opts.limit,
      budget: opts.budget,
      visitedNodes: state.visited.size,
      expansions: state.expansions,
      reason,
    };
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

  public directDepsLeadingTo(
    pkg: types.Pkg,
    opts?: types.PathQueryOptions & { withStatus?: false },
  ): types.PkgInfo[];
  public directDepsLeadingTo(
    pkg: types.Pkg,
    opts: types.PathQueryOptions & { withStatus: true },
  ): types.DirectDepsResult;
  public directDepsLeadingTo(
    pkg: types.Pkg,
    opts: types.PathQueryOptions = {},
  ): types.PkgInfo[] | types.DirectDepsResult {
    const result = this.directDepsLeadingToWithStatus(pkg, opts);

    if (opts.withStatus) {
      return result;
    }

    if (result.status === 'unknown' && !opts.allowIncomplete) {
      throw new TraversalIncompleteError('unknown', { ...result });
    }

    return result.directDeps;
  }

  public directDepsLeadingToWithStatus(
    pkg: types.Pkg,
    opts: types.PathQueryOptions = {},
  ): types.DirectDepsResult {
    const budget = normalizeBudget(opts.budget);
    const state = createTraversalState(undefined, budget);
    const pkgNodes = new Set(this.getPkgNodeIds(pkg));
    const directDeps = this.getNodeDepsNodeIds(this.rootNodeId);
    const leadingDeps: types.PkgInfo[] = [];

    for (const directDep of directDeps) {
      if (state.budgetExhausted) break;

      const reachesPkg = this.reachesAnyNode(directDep, pkgNodes, state);
      if (reachesPkg === undefined) {
        state.budgetExhausted = true;
        break;
      }
      if (reachesPkg) {
        leadingDeps.push(this.getNodePkg(directDep));
      }
    }

    const { status, reason } = statusOf(state);
    return {
      target: packageInfo(pkg),
      directDeps: leadingDeps,
      status,
      complete: status === 'complete',
      truncated: status === 'truncated',
      unknown: status === 'unknown',
      limit: opts.limit,
      budget: opts.budget,
      visitedNodes: state.visited.size,
      expansions: state.expansions,
      reason,
    };
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

  private attachPathArrayMetadata(
    paths: types.PkgInfo[][],
    result: types.PathsToRootResult,
  ): types.PkgInfo[][] {
    const metadata: PropertyDescriptorMap = {};
    for (const key of [
      'status',
      'complete',
      'truncated',
      'unknown',
      'limit',
      'budget',
      'reason',
      'visitedNodes',
      'expansions',
      'target',
    ] as const) {
      metadata[key] = {
        value: result[key],
        enumerable: false,
        configurable: true,
      };
    }
    Object.defineProperties(paths, metadata);
    return paths;
  }

  /**
   * Enumerate complete root paths in explicit stack form. A path is only
   * returned when it actually reaches the root; dead ends are recorded as an
   * incomplete traversal rather than being published as half parent chains.
   */
  private enumeratePathsFromNode(
    startNodeId: NodeId,
    state: TraversalState,
    hasMoreStartNodes: boolean,
    paths: types.PkgInfo[][],
  ): void {
    if (!consumeNode(state, startNodeId)) return;

    const startPkg = this.getNodePkg(startNodeId);
    const pathsBefore = paths.length;
    if (startNodeId === this._rootNodeId) {
      paths.push([startPkg]);
      this.noteLimitReached(state, paths, [], hasMoreStartNodes);
      return;
    }

    const startParents = this.getNodeParentsNodeIds(startNodeId);
    if (startParents.length === 0) {
      // A non-root node with no predecessors cannot produce a path to root.
      state.incomplete = true;
      return;
    }

    const stack: PathFrame[] = [
      {
        nodeId: startNodeId,
        parentIds: startParents,
        nextParent: 0,
        pathPkgs: [startPkg],
        ancestors: new Set<NodeId>([startNodeId]),
      },
    ];

    while (stack.length > 0) {
      if (state.budgetExhausted || state.limitHit) return;

      const frame = stack[stack.length - 1];
      if (frame.nextParent >= frame.parentIds.length) {
        stack.pop();
        continue;
      }

      const parentId = frame.parentIds[frame.nextParent++];
      if (frame.ancestors.has(parentId)) continue;
      if (!consumeNode(state, parentId)) return;

      const parentPkg = this.getNodePkg(parentId);

      if (parentId === this._rootNodeId) {
        paths.push(frame.pathPkgs.concat(parentPkg));
        this.noteLimitReached(state, paths, stack, hasMoreStartNodes);
        continue;
      }

      const parentIds = this.getNodeParentsNodeIds(parentId);
      if (parentIds.length === 0) {
        // Half parent chain: do not publish it and do not claim the query is
        // complete.
        state.incomplete = true;
        continue;
      }

      stack.push({
        nodeId: parentId,
        parentIds,
        nextParent: 0,
        pathPkgs: frame.pathPkgs.concat(parentPkg),
        ancestors: new Set<NodeId>(frame.ancestors).add(parentId),
      });
    }

    if (paths.length === pathsBefore) {
      // Every branch was pruned (for example a component that cannot reach
      // root), so silently returning [] would be an unjustified complete
      // "no paths" answer.
      state.incomplete = true;
    }
  }

  private noteLimitReached(
    state: TraversalState,
    paths: types.PkgInfo[][],
    stack: PathFrame[],
    hasMoreStartNodes: boolean,
  ): void {
    if (state.limit === undefined || paths.length < state.limit) return;
    if (hasMoreStartNodes || this.hasPendingPathWork(stack)) {
      state.limitHit = true;
    }
  }

  private hasPendingPathWork(stack: PathFrame[]): boolean {
    return stack.some((frame) => frame.nextParent < frame.parentIds.length);
  }

  /**
   * Complete (unbounded) path counting. Only this path is allowed to populate
   * the count cache.
   */
  private countNodePathsToRootComplete(
    nodeId: NodeId,
    limit: number | undefined,
    state: TraversalState,
  ): number {
    state.expansions++;
    state.visited.add(nodeId);

    if (limit === undefined) {
      const cached = this._countNodePathsToRootCache.get(nodeId);
      if (cached) {
        return cached.count;
      }
    }

    let count: number;
    if (nodeId === this._rootNodeId) {
      count = 1;
    } else if (this.hasCyclesWithStatus().hasCycles === true) {
      // When cycles exist, we must walk every simple path individually to
      // avoid counting paths that loop back on themselves.
      count = this.countNodePathsToRootBacktracking(
        nodeId,
        state,
        limit,
        0,
        new Set(),
      );
    } else {
      // Without cycles, we can compute path counts by summing each parent's
      // count. This avoids the exponential cost of enumerating every path.
      count = this.countNodePathsToRootMemoized(nodeId, limit, state);
    }

    if (limit === undefined) {
      this._countNodePathsToRootCache.set(nodeId, {
        count,
        status: 'complete',
      });
    }
    return count;
  }

  /**
   * Memoized path counting, the count is the sum of the counts of the parents.
   * Only valid for acyclic graphs.
   */
  private countNodePathsToRootMemoized(
    nodeId: NodeId,
    limit: number | undefined,
    state: TraversalState,
  ): number {
    let count = 0;
    for (const parentNodeId of this.getNodeParentsNodeIds(nodeId)) {
      count += this.countNodePathsToRootComplete(parentNodeId, limit, state);
      if (limit !== undefined && count >= limit) {
        return limit;
      }
    }
    return count;
  }

  /**
   * Backtracking approach that enumerates simple paths.
   * Required for cyclic graphs where memoization is not applicable.
   */
  private countNodePathsToRootBacktracking(
    nodeId: NodeId,
    state: TraversalState,
    limit: number | undefined = undefined,
    count = 0,
    visited: Set<NodeId> = new Set(),
  ): number {
    state.expansions++;
    state.visited.add(nodeId);

    if (nodeId === this._rootNodeId) {
      return count + 1;
    }
    visited.add(nodeId);
    for (const parentNodeId of this.getNodeParentsNodeIds(nodeId)) {
      if (visited.has(parentNodeId)) {
        continue;
      }
      count = this.countNodePathsToRootBacktracking(
        parentNodeId,
        state,
        limit,
        count,
        visited,
      );
      if (limit !== undefined && count >= limit) {
        visited.delete(nodeId);
        return limit;
      }
    }
    visited.delete(nodeId);
    return count;
  }

  /**
   * Budgeted path counting uses the same simple-path semantics as the cyclic
   * backtracking implementation, so it is correct for both cyclic and acyclic
   * graphs. It never touches the shared cache.
   */
  private countNodePathsToRootBudgeted(
    startNodeId: NodeId,
    state: TraversalState,
  ): { count: number; status: types.TraversalStatus } {
    if (!consumeNode(state, startNodeId)) {
      return { count: 0, status: 'unknown' };
    }
    if (startNodeId === this._rootNodeId) {
      state.limitHit = state.limit !== undefined && state.limit <= 1;
      return { count: 1, status: state.limitHit ? 'truncated' : 'complete' };
    }

    const startParents = this.getNodeParentsNodeIds(startNodeId);
    if (startParents.length === 0) {
      return { count: 0, status: 'complete' };
    }

    let count = 0;
    const stack: Array<{
      nodeId: NodeId;
      parentIds: NodeId[];
      nextParent: number;
      ancestors: Set<NodeId>;
    }> = [
      {
        nodeId: startNodeId,
        parentIds: startParents,
        nextParent: 0,
        ancestors: new Set<NodeId>([startNodeId]),
      },
    ];

    while (stack.length > 0) {
      if (state.budgetExhausted) {
        return { count, status: 'unknown' };
      }

      const frame = stack[stack.length - 1];
      if (frame.nextParent >= frame.parentIds.length) {
        stack.pop();
        continue;
      }

      const parentId = frame.parentIds[frame.nextParent++];
      if (frame.ancestors.has(parentId)) continue;
      if (!consumeNode(state, parentId)) {
        return { count, status: 'unknown' };
      }

      if (parentId === this._rootNodeId) {
        count++;
        if (state.limit !== undefined && count >= state.limit) {
          state.limitHit = true;
          return { count, status: 'truncated' };
        }
        continue;
      }

      const parentIds = this.getNodeParentsNodeIds(parentId);
      if (parentIds.length === 0) {
        continue;
      }

      stack.push({
        nodeId: parentId,
        parentIds,
        nextParent: 0,
        ancestors: new Set<NodeId>(frame.ancestors).add(parentId),
      });
    }

    return { count, status: 'complete' };
  }

  private reachesAnyNode(
    startNodeId: NodeId,
    targets: Set<NodeId>,
    state: TraversalState,
  ): boolean | undefined {
    if (!consumeNode(state, startNodeId)) return undefined;
    if (targets.has(startNodeId)) return true;

    const stack: NodeId[] = [startNodeId];
    const seen = new Set<NodeId>([startNodeId]);

    while (stack.length > 0) {
      if (state.budgetExhausted) return undefined;

      const nodeId = stack.pop()!;
      for (const depNodeId of this.getNodeDepsNodeIds(nodeId)) {
        if (seen.has(depNodeId)) continue;
        if (!consumeNode(state, depNodeId)) return undefined;
        if (targets.has(depNodeId)) return true;
        seen.add(depNodeId);
        stack.push(depNodeId);
      }
    }

    return false;
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
}
