export {
  DepGraph,
  DepGraphData,
  Pkg,
  PkgInfo,
  PkgManager,
  VersionProvenance,
  TraversalStatus,
  TraversalReason,
  TraversalOptions,
  PathQueryOptions,
  TraversalEvidence,
  PathsToRootResult,
  PathCountResult,
  CycleQueryOptions,
  CycleStatusResult,
  DirectDepsResult,
} from './core/types';
export { createFromJSON } from './core/create-from-json';
export { DepGraphBuilder } from './core/builder';
export { createChangedPackagesGraph } from './core/create-changed-packages-graph';

import * as Errors from './core/errors';

export { Errors };
export {
  TraversalIncompleteError,
  ValidationError,
} from './core/errors';

import * as legacy from './legacy';

export { legacy };
