import * as semver from 'semver';
import * as graphlib from '../graphlib';
import * as types from './types';

import { DepGraph, DepGraphData } from './types';
import { ValidationError } from './errors';
import { validateGraph } from './validate-graph';
import { DepGraphImpl } from './dep-graph';

export const SUPPORTED_SCHEMA_RANGE = '^1.0.0';
export interface Options {
  shouldValidate?: boolean;
}

/**
 * Create a DepGraph instance from a JSON representation of a dep graph. This
 * is typically used after passing the graph over the wire as `DepGraphData`.
 */
export function createFromJSON(
  depGraphData: DepGraphData,
  options: Options = {},
): DepGraph {
  // Validate by default, unless skipped by user provided options
  const shouldValidate = options?.shouldValidate ?? true;
  if (shouldValidate) {
    assertValidSchema(depGraphData);
  }

  const graph = new graphlib.Graph({
    directed: true,
    multigraph: false,
    compound: false,
  });
  // Use null-prototype maps so ids such as `__proto__` or `constructor` are
  // treated as ordinary ids instead of accidentally resolving through
  // Object.prototype.
  const pkgs: { [pkgId: string]: types.PkgInfo } = Object.create(null);
  const pkgNodes: { [pkgId: string]: Set<string> } = Object.create(null);

  for (let i = 0; i < depGraphData.pkgs.length; i++) {
    const pkg = depGraphData.pkgs[i];
    assert(
      !!pkg && typeof pkg === 'object',
      `.pkgs[${i}] is missing or not an object`,
    );
    const { id, info } = pkg;
    assert(
      typeof id === 'string',
      `.pkgs[${i}].id is missing or not a string`,
    );
    assert(!!info && typeof info === 'object', `.pkgs[${i}] is missing .info`);
    if (shouldValidate) {
      assertValidPkg(id, info, pkgs, i);
    } else {
      // Even when the expensive checks are skipped, a duplicate id must not
      // silently replace the package that was already parsed.
      assert(
        !Object.prototype.hasOwnProperty.call(pkgs, id),
        `more than one pkg with same id: "${id}" (.pkgs[${i}])`,
      );
    }
    pkgs[id] = info.version ? info : { ...info, version: undefined };
  }

  const rootNodeId = depGraphData.graph.rootNodeId;
  let rootNode: types.GraphNode | undefined;
  const declaredNodeIds = new Set<string>();

  for (let i = 0; i < depGraphData.graph.nodes.length; i++) {
    const node = depGraphData.graph.nodes[i];
    assert(
      !!node && typeof node.nodeId === 'string',
      `graph.nodes[${i}].nodeId is missing or not a string`,
    );
    assert(
      !declaredNodeIds.has(node.nodeId),
      `more than one node with same id: "${node.nodeId}" (graph.nodes[${i}])`,
    );
    assert(
      typeof node.pkgId === 'string' && !!pkgs[node.pkgId],
      `some instance nodes belong to non-existing pkgIds: graph.nodes[${i}] ` +
        `(node "${node.nodeId}") references unknown package "${node.pkgId}"`,
    );

    declaredNodeIds.add(node.nodeId);
    if (node.nodeId === rootNodeId) rootNode = node;
    const pkgId = node.pkgId;
    if (!pkgNodes[pkgId]) {
      pkgNodes[pkgId] = new Set();
    }
    pkgNodes[pkgId].add(node.nodeId);

    graph.setNode(node.nodeId, { pkgId, info: node.info });
  }

  for (let i = 0; i < depGraphData.graph.nodes.length; i++) {
    const node = depGraphData.graph.nodes[i];
    assert(
      Array.isArray(node.deps),
      `graph.nodes[${i}].deps is missing or not an array`,
    );

    for (let j = 0; j < node.deps.length; j++) {
      const depNodeId = node.deps[j];
      assert(
        !!depNodeId && typeof depNodeId.nodeId === 'string',
        `graph.nodes[${i}].deps[${j}].nodeId is missing or not a string`,
      );
      // Never let graphlib create a node implicitly for a dangling edge: that
      // would silently change the graph that is validated and later reported.
      assert(
        declaredNodeIds.has(depNodeId.nodeId),
        `node "${node.nodeId}" depends on unknown node "${depNodeId.nodeId}" ` +
          `(graph.nodes[${i}].deps[${j}].nodeId is non-existing in graph.nodes)`,
      );
      graph.setEdge(node.nodeId, depNodeId.nodeId);
    }
  }

  assert(
    !!rootNode,
    `root graph node is missing: "${rootNodeId}" is not present in graph.nodes`,
  );
  const rootPkgId = rootNode!.pkgId;
  assert(!!pkgs[rootPkgId], `.${rootPkgId} root pkg missing`);

  if (shouldValidate) {
    validateGraph(graph, rootNodeId, pkgs, pkgNodes);
  }

  return new DepGraphImpl(
    graph,
    rootNodeId,
    pkgs,
    pkgNodes,
    depGraphData.pkgManager,
  );
}

function assert(condition: boolean, msg: string) {
  if (!condition) {
    throw new ValidationError(msg);
  }
}

function assertValidSchema(depGraphData: DepGraphData) {
  assert(
    !!depGraphData && typeof depGraphData === 'object',
    'dep-graph data is missing or not an object',
  );

  const { schemaVersion, pkgManager } = depGraphData;
  assert(
    !!semver.valid(schemaVersion) &&
      semver.satisfies(schemaVersion, SUPPORTED_SCHEMA_RANGE),
    `dep-graph schemaVersion not in "${SUPPORTED_SCHEMA_RANGE}"`,
  );
  assert(
    !!pkgManager && typeof pkgManager === 'object',
    '.pkgManager is missing',
  );
  assert(
    typeof pkgManager.name === 'string' && !!pkgManager.name,
    '.pkgManager.name is missing',
  );
  assert(Array.isArray(depGraphData.pkgs), '.pkgs is missing or not an array');
  assert(
    !!depGraphData.graph && typeof depGraphData.graph === 'object',
    '.graph is missing',
  );
  assert(
    typeof depGraphData.graph.rootNodeId === 'string',
    '.graph.rootNodeId is missing or not a string',
  );
  assert(
    Array.isArray(depGraphData.graph.nodes),
    '.graph.nodes is missing or not an array',
  );
}

function assertValidPkg(id, info, pkgs, index?: number) {
  assert(
    !Object.prototype.hasOwnProperty.call(pkgs, id),
    `more than one pkg with same id: "${id}" (.pkgs[${index}])`,
  );
  assert(!!info, '.pkgs item missing .info');
  assert(id === DepGraphImpl.getPkgId(info), 'pkgs ids should be name@version');
  assert(!!info.name, 'some .pkgs elements have no .name field');
}
