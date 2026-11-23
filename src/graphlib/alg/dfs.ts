import { Graph } from '../graph';

/*
 * A helper that preforms a pre- or post-order traversal on the input graph
 * and returns the nodes in the order they were visited. If the graph is
 * undirected then this algorithm will navigate using neighbors. If the graph
 * is directed then this algorithm will navigate using successors.
 *
 * Order must be one of "pre" or "post".
 */
export function dfs(g: Graph, vs: string[], order: 'pre' | 'post'): string[] {
  if (!Array.isArray(vs)) {
    vs = [vs];
  }

  const navigation = (g.isDirected() ? g.successors : g.neighbors).bind(g);

  const acc: string[] = [];
  const visited: Set<string> = new Set();

  for (const v of vs) {
    if (!g.hasNode(v)) {
      throw new Error('Graph does not have node: ' + v);
    }

    if (visited.has(v)) continue;

    const postorder = order === 'post';
    visited.add(v);
    if (!postorder) acc.push(v);

    const stack: Array<{
      nodeId: string;
      neighbors: string[];
      next: number;
    }> = [
      {
        nodeId: v,
        neighbors: navigation(v),
        next: 0,
      },
    ];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.next >= frame.neighbors.length) {
        stack.pop();
        if (postorder) acc.push(frame.nodeId);
        continue;
      }

      const next = frame.neighbors[frame.next++];
      if (visited.has(next)) continue;

      visited.add(next);
      if (!postorder) acc.push(next);
      stack.push({
        nodeId: next,
        neighbors: navigation(next),
        next: 0,
      });
    }
  }

  return acc;
}
