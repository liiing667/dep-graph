import * as depGraphLib from '../../src';
import { loadFixture } from '../helpers';

function buildSharedPathGraph(): depGraphLib.DepGraph {
  const builder = new depGraphLib.DepGraphBuilder(
    { name: 'npm' },
    { name: 'root', version: '1.0.0' },
  );

  builder
    .addPkgNode({ name: 'left', version: '1.0.0' }, 'left')
    .addPkgNode({ name: 'right', version: '1.0.0' }, 'right')
    .addPkgNode({ name: 'target', version: '1.0.0' }, 'target')
    .addPkgNode({ name: 'other', version: '1.0.0' }, 'other')
    .addPkgNode({ name: 'other-parent', version: '1.0.0' }, 'other-parent');

  builder
    .connectDep('root-node', 'left')
    .connectDep('root-node', 'right')
    .connectDep('left', 'target')
    .connectDep('right', 'target')
    .connectDep('root-node', 'other-parent')
    .connectDep('other-parent', 'other');

  return builder.build();
}

function buildCyclicGraph(): depGraphLib.DepGraph {
  const builder = new depGraphLib.DepGraphBuilder(
    { name: 'npm' },
    { name: 'root', version: '1.0.0' },
  );

  builder
    .addPkgNode({ name: 'a', version: '1.0.0' }, 'a')
    .addPkgNode({ name: 'b', version: '1.0.0' }, 'b')
    .addPkgNode({ name: 'leaf', version: '1.0.0' }, 'leaf');

  builder
    .connectDep('root-node', 'a')
    .connectDep('a', 'b')
    .connectDep('b', 'a')
    .connectDep('b', 'leaf');

  return builder.build();
}

describe('path query status', () => {
  describe('small graphs keep their legacy output', () => {
    const depGraph = depGraphLib.createFromJSON(
      loadFixture('plain-dep-graph.json'),
    );
    const pkg = { name: 'e', version: '5.0.0' };

    it('keeps complete paths and their array shape', () => {
      const paths = depGraph.pkgPathsToRoot(pkg);

      expect(Array.isArray(paths)).toBe(true);
      expect(paths).toHaveLength(7);
      expect((paths as any).status).toBe('complete');
      expect((paths as any).unknown).toBe(false);
    });

    it('keeps explicit limits and reports them as truncated', () => {
      const paths = depGraph.pkgPathsToRoot(pkg, { limit: 2 });

      expect(paths).toHaveLength(2);
      expect((paths as any).status).toBe('truncated');
      expect((paths as any).reason).toBe('limit');
      expect(depGraph.countPathsToRoot(pkg, { limit: 2 })).toBe(2);
    });

    it('keeps zero as the historical no-limit value', () => {
      expect(depGraph.pkgPathsToRoot(pkg, { limit: 0 })).toHaveLength(7);
      expect(depGraph.countPathsToRoot(pkg, { limit: 0 })).toBe(7);
    });

    it('returns the status objects on request', () => {
      const paths = depGraph.pkgPathsToRoot(pkg, { withStatus: true });
      const count = depGraph.countPathsToRoot(pkg, { withStatus: true });

      expect(paths.status).toBe('complete');
      expect(paths.paths).toHaveLength(7);
      expect(count.status).toBe('complete');
      expect(count.count).toBe(7);
    });
  });

  describe('budgeted path queries', () => {
    const graph = buildSharedPathGraph();
    const target = { name: 'target', version: '1.0.0' };

    it('does not publish a half parent chain when the budget runs out', () => {
      const result = graph.pkgPathsToRoot(target, {
        budget: 2,
        withStatus: true,
      });

      expect(result.status).toBe('unknown');
      expect(result.reason).toBe('budget');
      expect(result.paths).toEqual([]);
      expect(() => graph.pkgPathsToRoot(target, { budget: 2 })).toThrow(
        depGraphLib.Errors.TraversalIncompleteError,
      );
    });

    it('keeps only complete root paths when a budget stops a later branch', () => {
      const result = graph.pkgPathsToRoot(target, {
        budget: 4,
        withStatus: true,
      });

      expect(result.status).toBe('unknown');
      expect(result.paths).toHaveLength(1);
      expect(result.paths[0][0]).toEqual(target);
      expect(result.paths[0][result.paths[0].length - 1]).toEqual(
        graph.rootPkg,
      );
    });

    it('recovers with a larger budget and reaches the complete answer', () => {
      const result = graph.pkgPathsToRoot(target, {
        budget: 5,
        withStatus: true,
      });

      expect(result.status).toBe('complete');
      expect(result.paths).toHaveLength(2);
      expect(result.paths.every((path) => path[0].name === 'target')).toBe(
        true,
      );

      expect(
        graph.pkgPathsToRoot(target, { limit: 2, withStatus: true }),
      ).toMatchObject({
        status: 'complete',
      });
    });

    it('restarts the budget for each interleaved package query', () => {
      const first = graph.pkgPathsToRoot(target, {
        budget: 2,
        withStatus: true,
      });
      const second = graph.pkgPathsToRoot(
        { name: 'other', version: '1.0.0' },
        { budget: 2, withStatus: true },
      );

      expect(first.status).toBe('unknown');
      expect(second.status).toBe('unknown');
      expect(graph.pkgPathsToRoot(target)).toHaveLength(2);
      expect(
        graph.pkgPathsToRoot({ name: 'other', version: '1.0.0' }),
      ).toHaveLength(1);
    });
  });

  describe('half parent chains', () => {
    it('does not report a non-root sink as a complete path', () => {
      const builder = new depGraphLib.DepGraphBuilder(
        { name: 'npm' },
        { name: 'root', version: '1.0.0' },
      );
      builder.addPkgNode({ name: 'orphan', version: '1.0.0' }, 'orphan');
      const graph = builder.build();

      const result = graph.pkgPathsToRoot(
        { name: 'orphan', version: '1.0.0' },
        { withStatus: true },
      );

      expect(result.status).toBe('unknown');
      expect(result.reason).toBe('unreachable-root');
      expect(result.paths).toEqual([]);
      expect(() =>
        graph.pkgPathsToRoot({ name: 'orphan', version: '1.0.0' }),
      ).toThrow(depGraphLib.Errors.TraversalIncompleteError);
    });
  });

  describe('budgeted path counts and cache isolation', () => {
    const graph = buildSharedPathGraph();
    const target = { name: 'target', version: '1.0.0' };
    const other = { name: 'other', version: '1.0.0' };

    it('marks a budget-limited count as unknown instead of reusing a partial cache', () => {
      const first = graph.countPathsToRoot(target, {
        budget: 2,
        withStatus: true,
      });
      const second = graph.countPathsToRoot(other, {
        budget: 2,
        withStatus: true,
      });

      expect(first.status).toBe('unknown');
      expect(first.count).toBeUndefined();
      expect(first.partialCount).toBe(0);
      expect(second.status).toBe('unknown');
      expect(() => graph.countPathsToRoot(target, { budget: 2 })).toThrow(
        depGraphLib.Errors.TraversalIncompleteError,
      );
    });

    it('does not let a limited query seed the next package query', () => {
      expect(graph.countPathsToRoot(target, { limit: 1 })).toBe(1);
      expect(graph.countPathsToRoot(other, { limit: 1 })).toBe(1);
      expect(graph.countPathsToRoot(target)).toBe(2);
      expect(graph.countPathsToRoot(other)).toBe(1);
    });

    it('distinguishes an exact limit from a real truncation', () => {
      expect(
        graph.countPathsToRootWithStatus(target, { limit: 2 }),
      ).toMatchObject({
        status: 'complete',
        count: 2,
      });
      expect(
        graph.countPathsToRootWithStatus(target, { limit: 1 }),
      ).toMatchObject({
        status: 'truncated',
        count: 1,
      });
    });

    it('restores the full count when the budget is increased', () => {
      const result = graph.countPathsToRoot(target, {
        budget: 5,
        withStatus: true,
      });

      expect(result.status).toBe('complete');
      expect(result.count).toBe(2);
    });
  });

  describe('risk output distinguishes unknown from acyclic', () => {
    const cyclic = buildCyclicGraph();
    const acyclic = depGraphLib.createFromJSON(
      loadFixture('plain-dep-graph.json'),
    );

    it('does not call a partially traversed graph acyclic', () => {
      expect(cyclic.hasCycles({ budget: 1 })).toBeUndefined();
      expect(cyclic.hasCycles({ budget: 1, withStatus: true })).toMatchObject({
        status: 'unknown',
        hasCycles: undefined,
        reason: 'budget',
      });
    });

    it('still reports cycles and acyclic graphs once traversal completes', () => {
      expect(cyclic.hasCycles({ budget: 4 })).toBe(true);
      expect(acyclic.hasCycles()).toBe(false);
      expect(acyclic.hasCycles({ withStatus: true })).toMatchObject({
        status: 'complete',
        hasCycles: false,
      });
    });
  });

  describe('invalid bounds fail closed', () => {
    const graph = buildSharedPathGraph();
    const target = { name: 'target', version: '1.0.0' };

    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects a limit of %s',
      (limit) => {
        expect(() => graph.pkgPathsToRoot(target, { limit })).toThrow(
          depGraphLib.Errors.ValidationError,
        );
        expect(() => graph.countPathsToRoot(target, { limit })).toThrow(
          depGraphLib.Errors.ValidationError,
        );
      },
    );

    it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY])(
      'rejects a budget of %s',
      (budget) => {
        expect(() =>
          graph.pkgPathsToRoot(target, { budget, withStatus: true }),
        ).toThrow(depGraphLib.Errors.ValidationError);
        expect(() => graph.hasCycles({ budget })).toThrow(
          depGraphLib.Errors.ValidationError,
        );
      },
    );

    it('treats a zero budget as an explicitly incomplete traversal', () => {
      const result = graph.pkgPathsToRoot(target, {
        budget: 0,
        withStatus: true,
      });
      expect(result.status).toBe('unknown');
      expect(result.paths).toEqual([]);
    });
  });
});
