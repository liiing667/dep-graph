import * as depGraphLib from '../../src';

import * as helpers from '../helpers';

function loadMalformed(name: string) {
  return helpers.loadFixture(`malformed/${name}`);
}

function expectInvalid(name: string, messages: RegExp[]) {
  const go = () => depGraphLib.createFromJSON(loadMalformed(name));

  expect(go).toThrow(depGraphLib.Errors.ValidationError);
  for (const message of messages) {
    expect(go).toThrow(message);
  }
}

function normalizeNodes(nodes): any[] {
  return nodes
    .map((node) => ({
      ...node,
      deps: node.deps
        .map((dep) => dep.nodeId)
        .sort()
        .map((nodeId) => ({ nodeId })),
    }))
    .sort((a, b) => a.nodeId.localeCompare(b.nodeId));
}

describe('createFromJSON graph integrity', () => {
  test('rejects a dangling dependency instead of materializing a node for it', () => {
    expectInvalid('dangling-dep.json', [
      /graph\.nodes\[1\]\.deps\[0\]/,
      /node "a@1\.0\.0\|x" depends on unknown node "ghost@9\.9\.9\|x"/,
      /non-existing/,
    ]);
  });

  test('rejects an instance that references a package missing from pkgs', () => {
    expectInvalid('unknown-package.json', [
      /graph\.nodes\[1\]/,
      /node "ghost@1\.0\.0"\) references unknown package "ghost@1\.0\.0"/,
      /non-existing pkgIds/,
    ]);
  });

  test('rejects a graph with multiple roots', () => {
    expectInvalid('multi-root.json', [
      /not all graph nodes are reachable from root "root-node"/,
      /multiple roots/,
      /"b@1\.0\.0"/,
    ]);
  });

  test('rejects an unreachable cycle', () => {
    expectInvalid('unreachable-cycle.json', [
      /not all graph nodes are reachable from root/,
      /"x@1\.0\.0"/,
      /"y@1\.0\.0"/,
    ]);
  });

  test('rejects a forged root that is reached through another node', () => {
    expectInvalid('forged-root.json', [
      /"a@1\.0\.0" is not really the root/,
      /incoming edge\(s\) from "root-node"/,
    ]);
  });

  test('rejects nodes that became unreachable after an edge was deleted', () => {
    expectInvalid('deleted-edge.json', [
      /not all graph nodes are reachable from root/,
      /"a@1\.0\.0"/,
      /"b@1\.0\.0"/,
    ]);
  });

  test('rejects an empty graph without inventing a root', () => {
    expectInvalid('empty-nodes.json', [
      /root graph node is missing/,
      /"" is not present in graph\.nodes/,
    ]);
  });

  test('does not build implicit nodes even when expensive validation is skipped', () => {
    const go = () =>
      depGraphLib.createFromJSON(loadMalformed('dangling-dep.json'), {
        shouldValidate: false,
      });

    expect(go).toThrow(depGraphLib.Errors.ValidationError);
    expect(go).toThrow(/depends on unknown node "ghost@9\.9\.9\|x"/);
  });

  test('preserves all declared nodes and edges when validation is skipped', () => {
    const json = loadMalformed('deleted-edge.json');
    const graph = depGraphLib.createFromJSON(json, { shouldValidate: false });
    const roundTrip = graph.toJSON();

    expect(graph.getPkgs()).toHaveLength(3);
    expect(normalizeNodes(roundTrip.graph.nodes)).toEqual(
      normalizeNodes(json.graph.nodes),
    );
  });

  test('keeps all nodes and edges for a cyclic graph across toJSON()', () => {
    const json = helpers.loadFixture('cyclic-dep-graph.json');
    const graph = depGraphLib.createFromJSON(json) as any;

    expect(graph.hasCycles()).toBe(true);
    expect(graph.getNodeDepsNodeIds('foo@2|x')).toEqual(['bar@3|x']);
    expect(graph.getNodeParentsNodeIds('foo@2|x').sort()).toEqual(
      ['baz@4|x', 'toor'].sort(),
    );

    const roundTrip = graph.toJSON();
    expect(roundTrip.schemaVersion).toBe('1.3.0');
    expect(roundTrip.graph.rootNodeId).toBe(json.graph.rootNodeId);
    expect(roundTrip.pkgs).toEqual(json.pkgs);
    expect(normalizeNodes(roundTrip.graph.nodes)).toEqual(
      normalizeNodes(json.graph.nodes),
    );
  });

  test('keeps old-schema graphs loadable and reports the same node/edge set', () => {
    const json = helpers.loadFixture(
      'old-schema-compat/simple-graph-1.0.0.json',
    );
    const graph = depGraphLib.createFromJSON(json);

    expect(graph.getPkgs()).toHaveLength(7);

    const roundTrip = graph.toJSON();
    expect(roundTrip.schemaVersion).toBe('1.3.0');
    expect(roundTrip.graph.rootNodeId).toBe(json.graph.rootNodeId);
    expect(normalizeNodes(roundTrip.graph.nodes)).toEqual(
      normalizeNodes(json.graph.nodes),
    );
  });

  test('keeps a root-only graph as a valid empty dependency graph', () => {
    const json = helpers.loadFixture('os-linux-scratch-dep-graph.json');
    const graph = depGraphLib.createFromJSON(json);

    expect(graph.getDepPkgs()).toEqual([]);
    expect(graph.toJSON().graph.nodes).toHaveLength(1);
  });

  test('treats prototype-like node ids as ordinary graph ids', () => {
    const json = {
      schemaVersion: '1.3.0',
      pkgManager: { name: 'npm' },
      pkgs: [
        {
          id: '__proto__@1.0.0',
          info: { name: '__proto__', version: '1.0.0' },
        },
      ],
      graph: {
        rootNodeId: '__proto__',
        nodes: [
          {
            nodeId: '__proto__',
            pkgId: '__proto__@1.0.0',
            deps: [],
          },
        ],
      },
    };

    const graph = depGraphLib.createFromJSON(json as any);
    const roundTrip = graph.toJSON();

    expect(roundTrip.graph.rootNodeId).toBe('__proto__');
    expect(roundTrip.graph.nodes).toHaveLength(1);
    expect(roundTrip.graph.nodes[0].nodeId).toBe('__proto__');
  });
});
