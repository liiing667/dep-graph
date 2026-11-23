import { Graph } from '../graph';

export interface AcyclicResult {
  /**
   * `true`/`false` only when the whole graph was inspected (or a cycle was
   * found, which is already a definitive answer). `undefined` means the budget
   * ran out before a conclusion could be reached.
   */
  isAcyclic?: boolean;
  complete: boolean;
  visitedNodes: number;
  expansions: number;
  budget?: number;
}

/**
 * Cycle detection with an optional work budget.
 *
 * The traversal is iterative so a deep dependency chain cannot overflow the
 * JS call stack. Finding a back edge is a definitive result immediately; when
 * the budget is exhausted before either a cycle or a completed traversal is
 * seen, the result is explicitly incomplete instead of being reported as
 * acyclic.
 */
export function isAcyclicWithBudget(
  g: Graph,
  budget?: number,
): AcyclicResult {
  const colors = new Map<string, 1 | 2>();
  const visited = new Set<string>();
  let expansions = 0;

  const visit = (nodeId: string): boolean => {
    if (budget !== undefined && expansions >= budget) {
      return false;
    }
    expansions++;
    visited.add(nodeId);
    return true;
  };

  for (const start of g.nodes()) {
    if (colors.get(start) === 2) continue;
    if (!visit(start)) {
      return {
        isAcyclic: undefined,
        complete: false,
        visitedNodes: visited.size,
        expansions,
        budget,
      };
    }

    colors.set(start, 1);
    const stack: Array<{
      nodeId: string;
      successors: string[];
      next: number;
    }> = [
      {
        nodeId: start,
        successors: g.successors(start),
        next: 0,
      },
    ];

    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      if (frame.next >= frame.successors.length) {
        colors.set(frame.nodeId, 2);
        stack.pop();
        continue;
      }

      const successor = frame.successors[frame.next++];
      const color = colors.get(successor);
      if (color === 1) {
        return {
          isAcyclic: false,
          complete: true,
          visitedNodes: visited.size,
          expansions,
          budget,
        };
      }
      if (color === 2) continue;
      if (!visit(successor)) {
        return {
          isAcyclic: undefined,
          complete: false,
          visitedNodes: visited.size,
          expansions,
          budget,
        };
      }

      colors.set(successor, 1);
      stack.push({
        nodeId: successor,
        successors: g.successors(successor),
        next: 0,
      });
    }
  }

  return {
    isAcyclic: true,
    complete: true,
    visitedNodes: visited.size,
    expansions,
    budget,
  };
}

export function isAcyclic(g: Graph): boolean {
  return isAcyclicWithBudget(g).isAcyclic === true;
}
