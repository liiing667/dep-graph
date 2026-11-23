import * as depGraphLib from '../../src';
import { createChangedPackagesGraph } from '../../src';

function graph(
  rootNodeId: string,
  pkgs: any[],
  nodes: any[],
): depGraphLib.DepGraph {
  return depGraphLib.createFromJSON({
    schemaVersion: '1.3.0',
    pkgManager: { name: 'npm' },
    pkgs,
    graph: { rootNodeId, nodes },
  });
}

function pkg(id: string, name: string, version: string) {
  return { id, info: { name, version } };
}

function node(
  nodeId: string,
  pkgId: string,
  deps: string[] = [],
  info?: any,
) {
  const value: any = {
    nodeId,
    pkgId,
    deps: deps.map((dependencyNodeId) => ({ nodeId: dependencyNodeId })),
  };
  if (info) {
    value.info = info;
  }
  return value;
}

describe('createChangedPackagesGraph graph identity', () => {
  it('keeps the current root id, node info and parent chain', async () => {
    const a = graph(
      'project-root',
      [pkg('root@1', 'root', '1'), pkg('parent@1', 'parent', '1')],
      [
        node('project-root', 'root@1', ['parent-node']),
        node('parent-node', 'parent@1'),
      ],
    );

    const b = graph(
      'project-root',
      [
        pkg('root@1', 'root', '1'),
        pkg('parent@1', 'parent', '1'),
        pkg('child@1', 'child', '1'),
      ],
      [
        node('project-root', 'root@1', ['parent-node'], {
          labels: { scope: 'prod' },
        }),
        node('parent-node', 'parent@1', ['child-node'], {
          labels: { scope: 'prod' },
        }),
        node('child-node', 'child@1'),
      ],
    );

    const result = await createChangedPackagesGraph(a, b);
    const internal = result as any;
    const childParents = internal.getNodeParentsNodeIds('child-node');
    const parentParents = internal.getNodeParentsNodeIds('parent-node');
    const childPathNames = result
      .pkgPathsToRoot({ name: 'child', version: '1' })
      .map((path) => path.map((item) => item.name));

    expect(internal.rootNodeId).toBe('project-root');
    expect(internal.getNode('project-root')).toEqual({
      labels: { scope: 'prod' },
    });
    expect(childParents).toEqual(['parent-node']);
    expect(parentParents).toEqual(['project-root']);
    expect(childPathNames).toEqual([['child', 'parent', 'root']]);
  });

  it('is stable when graph B nodes and edges are reordered', async () => {
    const a = graph(
      'project-root',
      [pkg('root@1', 'root', '1')],
      [node('project-root', 'root@1')],
    );
    const b = graph(
      'project-root',
      [
        pkg('root@1', 'root', '1'),
        pkg('parent@1', 'parent', '1'),
        pkg('first@1', 'first', '1'),
        pkg('second@1', 'second', '1'),
      ],
      [
        node('project-root', 'root@1', ['parent-node']),
        node('parent-node', 'parent@1', ['first-node', 'second-node']),
        node('first-node', 'first@1'),
        node('second-node', 'second@1'),
      ],
    );

    const bJSON = b.toJSON();
    const reorderedB = graph(
      bJSON.graph.rootNodeId,
      bJSON.pkgs.slice().reverse(),
      bJSON.graph.nodes
        .slice()
        .reverse()
        .map((graphNode) => ({
          ...graphNode,
          deps: graphNode.deps.slice().reverse(),
        })),
    );

    const first = await createChangedPackagesGraph(a, b);
    const second = await createChangedPackagesGraph(a, reorderedB);

    expect(first.toJSON()).toEqual(second.toJSON());
  });

  it('keeps shared parents but not unchanged siblings', async () => {
    const a = graph(
      'project-root',
      [
        pkg('root@1', 'root', '1'),
        pkg('shared@1', 'shared', '1'),
        pkg('removed@1', 'removed', '1'),
        pkg('upgraded@1', 'upgraded', '1'),
        pkg('stable@1', 'stable', '1'),
      ],
      [
        node('project-root', 'root@1', ['shared-node']),
        node('shared-node', 'shared@1', [
          'removed-node',
          'upgraded-node',
          'stable-node',
        ]),
        node('removed-node', 'removed@1'),
        node('upgraded-node', 'upgraded@1'),
        node('stable-node', 'stable@1'),
      ],
    );

    const b = graph(
      'project-root',
      [
        pkg('root@1', 'root', '1'),
        pkg('shared@1', 'shared', '1'),
        pkg('upgraded@2', 'upgraded', '2'),
        pkg('added@1', 'added', '1'),
        pkg('stable@1', 'stable', '1'),
      ],
      [
        node('project-root', 'root@1', ['shared-node']),
        node('shared-node', 'shared@1', [
          'upgraded-node',
          'added-node',
          'stable-node',
        ]),
        node('upgraded-node', 'upgraded@2'),
        node('added-node', 'added@1'),
        node('stable-node', 'stable@1'),
      ],
    );

    const result = await createChangedPackagesGraph(a, b);
    const resultPkgIds = result
      .getDepPkgs()
      .map((item) => `${item.name}@${item.version}`)
      .sort();
    const hasUnchangedSibling = result
      .getDepPkgs()
      .some((item) => item.name === 'stable');

    expect(resultPkgIds).toEqual(['added@1', 'shared@1', 'upgraded@2']);
    expect(hasUnchangedSibling).toBe(false);

    for (const changedPkg of [
      { name: 'added', version: '1' },
      { name: 'upgraded', version: '2' },
    ]) {
      const pathNames = result
        .pkgPathsToRoot(changedPkg)
        .map((path) => path.map((item) => item.name));
      expect(pathNames).toEqual([[changedPkg.name, 'shared', 'root']]);
    }
  });

  it('keeps cycle edges and a path to the current root', async () => {
    const a = graph(
      'project-root',
      [
        pkg('root@1', 'root', '1'),
        pkg('parent@1', 'parent', '1'),
        pkg('cycle@1', 'cycle', '1'),
      ],
      [
        node('project-root', 'root@1', ['parent-node']),
        node('parent-node', 'parent@1', ['cycle-node']),
        node('cycle-node', 'cycle@1'),
      ],
    );

    const b = graph(
      'project-root',
      [
        pkg('root@1', 'root', '1'),
        pkg('parent@1', 'parent', '1'),
        pkg('cycle@1', 'cycle', '1'),
        pkg('changed@1', 'changed', '1'),
      ],
      [
        node('project-root', 'root@1', ['parent-node']),
        node('parent-node', 'parent@1', ['changed-node']),
        node('changed-node', 'changed@1', ['cycle-node']),
        node('cycle-node', 'cycle@1', ['changed-node']),
      ],
    );

    const result = await createChangedPackagesGraph(a, b);
    const changedPathNames = result
      .pkgPathsToRoot({ name: 'changed', version: '1' })
      .map((path) => path.map((item) => item.name));

    expect((result as any).hasCycles()).toBe(true);
    expect(changedPathNames).toEqual([['changed', 'parent', 'root']]);
  });

  it('rejects a changed package unreachable from the root', async () => {
    const graphA = new depGraphLib.DepGraphBuilder(
      { name: 'npm' },
      { name: 'root', version: '1' },
    ).build();

    const graphBBuilder = new depGraphLib.DepGraphBuilder(
      { name: 'npm' },
      { name: 'root', version: '1' },
    );
    graphBBuilder.addPkgNode({ name: 'orphan', version: '1' }, 'orphan-node');
    const graphB = graphBBuilder.build();

    const result = createChangedPackagesGraph(graphA, graphB);
    await expect(result).rejects.toThrow(depGraphLib.Errors.ValidationError);
  });
});
