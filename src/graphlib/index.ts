export { Graph } from './graph';
import { isAcyclic, isAcyclicWithBudget } from './alg/is-acyclic';
import { postorder } from './alg/postorder';

export const alg = {
  isAcyclic,
  isAcyclicWithBudget,
  postorder,
};
