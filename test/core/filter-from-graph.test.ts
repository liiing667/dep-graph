import * as depGraphLib from '../../src';
import * as helpers from '../helpers';
import {
  filterNodesFromGraph,
  filterPackagesFromGraph,
} from '../../src/core/filter-from-graph';
import { DepGraphBuilder, PkgInfo } from '../../src';

function buildDiamondGraph(): depGraphLib.DepGraph {
  //           root
  //          /    \
  //      left      right
  //         \      /
  //       filtered  (only under `left`)
  //           \
  //          shared
  //         /      \
  //      leaf-a    leaf-b   (siblings under `shared`)
  const builder = new DepGraphBuilder({ name: 'npm' }, {
    name: 'root',
    version: '1.0.0',
  });

  builder
    .addPkgNode({ name: 'left', version: '1.0.0' }, 'left')
    .addPkgNode({ name: 'right', version: '1.0.0' }, 'right')
    .addPkgNode({ name: 'filtered', version: '1.0.0' }, 'filtered')
    .addPkgNode({ name: 'hidden', version: '1.0.0' }, 'hidden')
    .addPkgNode({ name: 'shared', version: '1.0.0' }, 'shared')
    .addPkgNode({ name: 'leaf-a', version: '1.0.0' }, 'leaf-a')
    .addPkgNode({ name: 'leaf-b', version: '1.0.0' }, 'leaf-b');

  builder
    .connectDep('root-node', 'left')
    .connectDep('root-node', 'right')
    .connectDep('left', 'filtered')
    .connectDep('filtered', 'shared')
    .connectDep('filtered', 'hidden')
    .connectDep('right', 'shared')
    .connectDep('shared', 'leaf-a')
    .connectDep('shared', 'leaf-b');

  return builder.build();
}

function buildCyclicGraph(): depGraphLib.DepGraph {
  //       root -> a -> b -> c -> a (cycle), plus b -> leaf
  const builder = new DepGraphBuilder({ name: 'npm' }, {
    name: 'root',
    version: '1.0.0',
  });

  builder
    .addPkgNode({ name: 'a', version: '1.0.0' }, 'a')
    .addPkgNode({ name: 'b', version: '1.0.0' }, 'b')
    .addPkgNode({ name: 'c', version: '1.0.0' }, 'c')
    .addPkgNode(
      { name: 'leaf', version: '1.0.0' },
      'leaf',
      { labels: { scope: 'dev' } },
    );

  builder
    .connectDep('root-node', 'a')
    .connectDep('a', 'b')
    .connectDep('b', 'c')
    .connectDep('c', 'a')
    .connectDep('b', 'leaf');

  return builder.build();
}

function nodeIds(graph: depGraphLib.DepGraph): string[] {
  return graph.toJSON().graph.nodes.map((node) => node.nodeId);
}

function depsOf(graph: depGraphLib.DepGraph, nodeId: string): string[] {
  const node = graph
    .toJSON()
    .graph.nodes.find((candidate) => candidate.nodeId === nodeId);
  return (node?.deps || []).map((dep) => dep.nodeId);
}

describe('filter-from-graph', function () {
  let depGraph;

  beforeEach(async () => {
    depGraph = depGraphLib.createFromJSON(
      helpers.loadFixture('goof-graph.json'),
    );
  });

  describe('filterNodesFromGraph', () => {
    describe('should return same depGraph if nodeIdsToFilterOut is empty', () => {
      const testCases = [null, undefined, []];

      it.each(testCases)('%s', async (nodeIdsToFilterOut) => {
        const result = await filterNodesFromGraph(
          depGraph,
          nodeIdsToFilterOut as any,
        );

        expect(result).toBe(depGraph);
      });
    });

    it('should remove direct dependencies', async () => {
      const result = await filterNodesFromGraph(depGraph, ['adm-zip@0.4.7']);

      expect(result.getDepPkgs().length).toEqual(
        depGraph.getDepPkgs().length - 1,
      );

      expect(result.toJSON()).toMatchSnapshot({
        schemaVersion: expect.any(String),
      });
    });

    it('should not mutate original depGraph', async () => {
      const depGraphCloneJson = JSON.parse(JSON.stringify(depGraph.toJSON()));

      await filterNodesFromGraph(depGraph, ['adm-zip@0.4.7']);

      expect(depGraph.toJSON()).toEqual(depGraphCloneJson);
    });

    it("should return same instance if node ids to filter don't exists", async () => {
      const result = await filterNodesFromGraph(depGraph, ['blabla@1.2.3']);

      expect(result).toBe(depGraph);
    });

    describe('reachable set consistency', () => {
      it(
        'removes descendants hidden behind a filtered node even when a ' +
          'shared ancestor reaches them',
        async () => {
          const graph = buildDiamondGraph();

          // `filtered` sits on the `left` branch only. A naive traversal
          // keeps walking its subtree and reconnects nodes from the stale
          // parent context, while `shared` legitimately remains reachable
          // via `right`.
          const result = await filterNodesFromGraph(graph, ['filtered']);

          expect(nodeIds(result).sort()).toEqual(
            [
              'leaf-a',
              'leaf-b',
              'left',
              'right',
              'root-node',
              'shared',
            ].sort(),
          );
          // The exclusive descendant of the filtered node must not be
          // pulled back by any shared ancestor.
          expect(nodeIds(result)).not.toContain('hidden');

          // The edge through the filtered node is gone...
          expect(depsOf(result, 'left')).toEqual([]);
          // ...while the legitimate sibling path survives intact, including
          // both sibling edges under the shared ancestor.
          expect(depsOf(result, 'right')).toEqual(['shared']);
          expect(depsOf(result, 'shared').sort()).toEqual([
            'leaf-a',
            'leaf-b',
          ]);
        },
      );

      it(
        'keeps every legitimate sibling edge of a shared ancestor',
        async () => {
          const graph = buildDiamondGraph();

          const result = await filterNodesFromGraph(graph, ['leaf-a']);

          expect(nodeIds(result).sort()).toEqual(
            [
              'filtered',
              'hidden',
              'leaf-b',
              'left',
              'right',
              'root-node',
              'shared',
            ].sort(),
          );
          // Only the filtered edge is cut; the sibling edge remains.
          expect(depsOf(result, 'shared')).toEqual(['leaf-b']);
          expect(depsOf(result, 'filtered').sort()).toEqual([
            'hidden',
            'shared',
          ]);
        },
      );

      it(
        'filters by package name and PkgInfo against the same reachable set',
        async () => {
          const graph = buildDiamondGraph();

          const byName = await filterPackagesFromGraph(graph, ['filtered']);
          const byPkg = await filterPackagesFromGraph(graph, [
            { name: 'filtered', version: '1.0.0' },
          ]);

          expect(byName.toJSON()).toEqual(byPkg.toJSON());
          expect(nodeIds(byName)).not.toContain('filtered');
          expect(nodeIds(byName)).toContain('shared');
          expect(depsOf(byName, 'left')).toEqual([]);
        },
      );

      it(
        'handles cyclic graphs without looping and keeps the cycle',
        async () => {
          const graph = buildCyclicGraph();

          const result = await filterNodesFromGraph(graph, ['leaf']);

          expect(result.hasCycles()).toBe(true);
          expect(nodeIds(result).sort()).toEqual([
            'a',
            'b',
            'c',
            'root-node',
          ]);
          expect(depsOf(result, 'b')).toEqual(['c']);
          expect(depsOf(result, 'c')).toEqual(['a']);
        },
      );

      it(
        'breaks a cycle when the filtered node is part of it',
        async () => {
          const graph = buildCyclicGraph();

          const result = await filterNodesFromGraph(graph, ['c']);

          expect(result.hasCycles()).toBe(false);
          expect(nodeIds(result).sort()).toEqual([
            'a',
            'b',
            'leaf',
            'root-node',
          ]);
          expect(depsOf(result, 'b')).toEqual(['leaf']);
        },
      );

      it('preserves node info on surviving nodes', async () => {
        const graph = buildCyclicGraph();

        const result = await filterNodesFromGraph(graph, ['c']);

        expect(result.getNode('leaf')).toEqual({
          labels: { scope: 'dev' },
        });
      });

      it(
        'produces a graph whose parent chains never traverse a filtered node',
        async () => {
          const graph = buildDiamondGraph();

          const result = await filterNodesFromGraph(graph, ['filtered']);

          const paths = result.pkgPathsToRoot({
            name: 'shared',
            version: '1.0.0',
          });

          expect(paths).toHaveLength(1);
          expect(paths[0].map((pkg) => pkg.name)).toEqual([
            'shared',
            'right',
            'root',
          ]);
        },
      );

      it(
        'leaves a root-only graph when every dependency is filtered out',
        async () => {
          const graph = buildCyclicGraph();

          const result = await filterNodesFromGraph(graph, ['a']);

          expect(nodeIds(result)).toEqual(['root-node']);
          expect(result.getDepPkgs()).toHaveLength(0);
          expect(result.hasCycles()).toBe(false);
        },
      );
    });
  });

  describe('filterPackagesFromGraph', () => {
    const admZip = { name: 'adm-zip', version: '0.4.7' };
    const bytes = { name: 'bytes', version: '1.0.0' };
    const testCases = [
      ['one existing name', [admZip.name]],
      ['one existing PkgInfo', [admZip]],
      ['two existing names', [admZip.name, bytes.name]],
      ['two existing PkgInfos', [admZip, bytes]],
    ] as [string, (string | PkgInfo)[]][];

    it.each(testCases)('%s', async (_, pkgs) => {
      const result = await filterPackagesFromGraph(depGraph, pkgs);

      expect(result.getDepPkgs().length).toEqual(
        depGraph.getDepPkgs().length - pkgs.length,
      );
      expect(result.toJSON()).toMatchSnapshot({
        schemaVersion: expect.any(String),
      });
    });

    it('should return an empty graph', async () => {
      const pkgs = depGraph.getDepPkgs();
      const result = await filterPackagesFromGraph(depGraph, pkgs);

      expect(result.getDepPkgs().length).toBe(0);
      expect(result.toJSON()).toMatchSnapshot({
        schemaVersion: expect.any(String),
      });
    });
  });
});
