export class AppError extends Error {
  constructor(
    public readonly statusCode: number,
    public readonly code: string,
    message: string,
    public readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
  }

  static badRequest(message: string, details?: unknown): AppError {
    return new AppError(400, 'BAD_REQUEST', message, details);
  }

  static notFound(message = 'Resource not found'): AppError {
    return new AppError(404, 'NOT_FOUND', message);
  }

  static conflict(message: string): AppError {
    return new AppError(409, 'CONFLICT', message);
  }

  static unauthorized(message = 'Authentication required'): AppError {
    return new AppError(401, 'UNAUTHORIZED', message);
  }

  static authNotConfigured(): AppError {
    return new AppError(
      503,
      'AUTH_NOT_CONFIGURED',
      'GitHub login is not configured on this server',
    );
  }

  static rateLimited(resetAt?: Date): AppError {
    return new AppError(
      429,
      'RATE_LIMITED',
      'GitHub rate limit reached, try again later',
      resetAt ? { resetAt: resetAt.toISOString() } : undefined,
    );
  }

  static upstream(message = 'GitHub is unavailable right now'): AppError {
    return new AppError(502, 'UPSTREAM_ERROR', message);
  }
}
