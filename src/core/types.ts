// using .ts instead of .d.ts for this file,
//   as otherwise it's referenced from the auto-generated `index.d.ts`,
//   but not copied over to the `./dist` folder
//   and thus fails the compilation of a typescript project that imports this lib

export interface Pkg {
  name: string;
  version?: string;
}

export type PurlString = string;

export interface PkgInfo {
  name: string;
  version?: string;
  purl?: PurlString;

  // NOTE: consider adding in the future
  // requires?: {
  //   name: string;
  //   versionRange: string;
  //   dev?: boolean;
  //   exclusions?: string[];
  // }[];
  // resolved?: {
  //   registry: string;
  //   url: string;
  // };
  // parentManifestUri?: string;
  // issues?: {
  //   id: string;
  //   type: string;
  //   title: string;
  //   severity: string;
  // }[];
}

export interface VersionProvenance {
  type: string;
  location: string;
  property?: {
    name: string;
  };
}

export interface NodeInfo {
  versionProvenance?: VersionProvenance;
  labels?: {
    [key: string]: string | undefined;
    scope?: 'dev' | 'prod';
    pruned?: 'cyclic' | 'true';
  };
}

export interface Node {
  // id: string; - can be added later once it's useful as input to other methods
  // pkg: PkgInfo; - it can be nice to return this, consider when exposing more node related methods
  info: NodeInfo;
}

/**
 * Outcome of a bounded graph operation.
 *
 * - `complete`: the operation inspected everything it needed to answer.
 * - `truncated`: the caller's explicit `limit` was reached, so the answer is
 *   valid but intentionally incomplete.
 * - `unknown`: a traversal budget was exhausted (or the graph could not be
 *   traversed completely), so the answer must not be treated as final.
 */
export type TraversalStatus = 'complete' | 'truncated' | 'unknown';

export type TraversalReason =
  | 'limit'
  | 'budget'
  | 'unreachable-root'
  | 'traversal-error';

export interface TraversalOptions {
  /**
   * Explicit upper bound on the number of returned paths / path count.
   * `0` keeps the historical meaning of "no limit".
   */
  limit?: number;

  /**
   * Upper bound on the number of node visits performed by the operation.
   * When exhausted, the result is marked `unknown` instead of being reported
   * as a complete answer.
   */
  budget?: number;
}

export interface PathQueryOptions extends TraversalOptions {
  /** Return a status-bearing result object instead of the legacy value. */
  withStatus?: boolean;

  /**
   * Legacy methods throw when the answer is unknown. Set this to receive the
   * best complete paths/count discovered before the budget was exhausted.
   */
  allowIncomplete?: boolean;
}

export interface TraversalEvidence extends TraversalOptions {
  /** Package whose paths/count are being queried. */
  target: Pkg;
  /** Number of distinct nodes reached while answering the query. */
  visitedNodes: number;
  /** Number of node expansions charged against `budget`. */
  expansions: number;
  reason?: TraversalReason;
}

export interface PathsToRootResult extends TraversalEvidence {
  paths: PkgInfo[][];
  status: TraversalStatus;
  complete: boolean;
  truncated: boolean;
  unknown: boolean;
}

export interface PathCountResult extends TraversalEvidence {
  /**
   * Exact count when `status` is `complete`, the requested cap when
   * `status` is `truncated`, and absent when `status` is `unknown`.
   */
  count?: number;
  /**
   * Best-known partial count, only present when `status` is `unknown`.
   * It must never be treated as a final path count.
   */
  partialCount?: number;
  status: TraversalStatus;
  complete: boolean;
  truncated: boolean;
  unknown: boolean;
}

export interface CycleQueryOptions {
  /** Alias for `budget`, useful when reusing the same options object. */
  limit?: number;
  budget?: number;
  /** Return a status-bearing result object instead of the legacy boolean. */
  withStatus?: boolean;
}

export interface CycleStatusResult {
  status: TraversalStatus;
  /**
   * `true`/`false` only when `status` is `complete`; `undefined` when the
   * budget was exhausted before a final answer could be established.
   */
  hasCycles?: boolean;
  budget?: number;
  visitedNodes: number;
  expansions: number;
  reason?: TraversalReason;
}

export interface DirectDepsResult extends TraversalEvidence {
  directDeps: PkgInfo[];
  status: TraversalStatus;
  complete: boolean;
  truncated: boolean;
  unknown: boolean;
}

export interface GraphNode {
  nodeId: string;
  pkgId: string;
  info?: NodeInfo;
  deps: Array<{
    nodeId: string;
    // NOTE: consider adding later:
    // meta?: JsonMap;
  }>;
}

export interface PkgManager {
  name: string;
  version?: string;
  repositories?: Array<{
    alias: string;
  }>;
}

export interface DepGraphData {
  schemaVersion: string;
  pkgManager: PkgManager;
  pkgs: Array<{
    id: string;
    info: PkgInfo;
  }>;
  graph: {
    rootNodeId: string;
    nodes: GraphNode[];
  };
}

export interface DepGraph {
  readonly pkgManager: PkgManager;
  readonly rootPkg: PkgInfo;
  getPkgs(): PkgInfo[];
  getDepPkgs(): PkgInfo[];
  getPkgNodes(pkg: Pkg): Node[];
  toJSON(): DepGraphData;
  pkgPathsToRoot(
    pkg: Pkg,
    opts?: PathQueryOptions & { withStatus?: false },
  ): PkgInfo[][];
  pkgPathsToRoot(
    pkg: Pkg,
    opts: PathQueryOptions & { withStatus: true },
  ): PathsToRootResult;
  pkgPathsToRootWithStatus(
    pkg: Pkg,
    opts?: PathQueryOptions,
  ): PathsToRootResult;
  isTransitive(pkg: Pkg): boolean;
  directDepsLeadingTo(
    pkg: Pkg,
    opts?: PathQueryOptions & { withStatus?: false },
  ): PkgInfo[];
  directDepsLeadingTo(
    pkg: Pkg,
    opts: PathQueryOptions & { withStatus: true },
  ): DirectDepsResult;
  directDepsLeadingToWithStatus(
    pkg: Pkg,
    opts?: PathQueryOptions,
  ): DirectDepsResult;
  countPathsToRoot(
    pkg: Pkg,
    opts?: PathQueryOptions & { withStatus?: false },
  ): number;
  countPathsToRoot(
    pkg: Pkg,
    opts: PathQueryOptions & { withStatus: true },
  ): PathCountResult;
  countPathsToRootWithStatus(
    pkg: Pkg,
    opts?: PathQueryOptions,
  ): PathCountResult;
  hasCycles(
    opts?: CycleQueryOptions & { withStatus?: false },
  ): boolean | undefined;
  hasCycles(opts: CycleQueryOptions & { withStatus: true }): CycleStatusResult;
  hasCyclesWithStatus(opts?: CycleQueryOptions): CycleStatusResult;
  equals(other: DepGraph, options?: { compareRoot?: boolean }): boolean;
}

// NOTE/TODO(shaun): deferring any/all design decisions here
// Revisit when we actually start using things
export interface DepGraphInternal extends DepGraph {
  readonly rootNodeId: string;
  getNode(nodeId: string): NodeInfo;
  getNodePkg(nodeId: string): PkgInfo;
  getPkgNodeIds(pkg: Pkg): string[];
  getNodeDepsNodeIds(nodeId: string): string[];
  getNodeParentsNodeIds(nodeId: string): string[];
}
