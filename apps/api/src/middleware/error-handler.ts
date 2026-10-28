import type { ErrorRequestHandler, RequestHandler } from 'express';
import { ZodError } from 'zod';
import type { ErrorResponse } from '@repointelligence/shared';
import { AppError } from '../errors.js';

export const notFoundHandler: RequestHandler = (_req, _res, next) => {
  next(AppError.notFound('Route not found'));
};

// Errors raised by Express itself (for example malformed JSON) carry a 4xx status.
function clientErrorStatus(err: unknown): number | undefined {
  if (typeof err !== 'object' || err === null || !('status' in err)) return undefined;
  const { status } = err;
  return typeof status === 'number' && status >= 400 && status < 500 ? status : undefined;
}

export const errorHandler: ErrorRequestHandler = (err: unknown, req, res, _next) => {
  let status = 500;
  let code = 'INTERNAL_ERROR';
  let message = 'Something went wrong';
  let details: unknown;

  const clientStatus = clientErrorStatus(err);
  if (err instanceof AppError) {
    ({ statusCode: status, code, message, details } = err);
  } else if (err instanceof ZodError) {
    status = 400;
    code = 'VALIDATION_ERROR';
    message = 'Request validation failed';
    details = err.issues.map((issue) => ({ path: issue.path, message: issue.message }));
  } else if (clientStatus !== undefined) {
    status = clientStatus;
    code = 'BAD_REQUEST';
    message = 'Bad request';
  }

  if (status >= 500) {
    req.log.error({ err }, 'unhandled error');
  }

  const body: ErrorResponse = {
    error: {
      code,
      message,
      requestId: typeof req.id === 'string' ? req.id : undefined,
      ...(details !== undefined && { details }),
    },
  };
  res.status(status).json(body);
};
