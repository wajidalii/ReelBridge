import type { NextFunction, Request, Response } from 'express';
import { ResourceNotFoundError } from './assertOwnership.js';

type AssertOwnershipFn = (userId: string, resourceId: string) => Promise<void>;

/**
 * Wraps an assert*Ownership check into route middleware so every tenant-scoped
 * route uses the same boundary consistently, e.g.:
 *   router.get('/targets/:targetId', requireAuth, requireOwnership('targetId', assertTargetOwnership), handler)
 */
export function requireOwnership(paramName: string, assertFn: AssertOwnershipFn) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const resourceId = req.params[paramName];
    if (!resourceId || Array.isArray(resourceId)) {
      res.status(400).json({ error: `Missing route param: ${paramName}` });
      return;
    }
    assertFn(req.userId!, resourceId)
      .then(() => next())
      .catch(next);
  };
}

export function ownershipErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof ResourceNotFoundError) {
    res.status(404).json({ error: err.message });
    return;
  }
  next(err);
}
