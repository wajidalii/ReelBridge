import type { NextFunction, Request, Response } from 'express';
import { UsageLimitError } from './checkUsageLimit.js';

export function usageLimitErrorHandler(
  err: unknown,
  _req: Request,
  res: Response,
  next: NextFunction,
): void {
  if (err instanceof UsageLimitError) {
    res.status(402).json({
      error: err.message,
      code: 'plan_limit_reached',
      action: err.action,
      limit: err.limit,
      current: err.current,
    });
    return;
  }
  next(err);
}
