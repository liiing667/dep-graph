import { CustomError } from './custom-error';
import {
  TraversalReason,
  TraversalStatus,
} from '../types';

export class TraversalIncompleteError extends CustomError {
  public readonly status: Exclude<TraversalStatus, 'complete'>;
  public readonly reason?: TraversalReason;
  public readonly evidence: Record<string, unknown>;

  constructor(
    status: Exclude<TraversalStatus, 'complete'>,
    evidence: object = {},
  ) {
    const reason = (evidence as Record<string, unknown>)
      .reason as TraversalReason | undefined;
    super(
      `path traversal ${status}${reason ? ` (${reason})` : ''}; ` +
        'refusing to return a partial result as complete',
    );
    Object.setPrototypeOf(this, TraversalIncompleteError.prototype);
    this.status = status;
    this.reason = reason;
    this.evidence = evidence as Record<string, unknown>;
  }
}
