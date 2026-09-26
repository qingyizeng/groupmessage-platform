import type { FastifyError, FastifyInstance } from 'fastify';
import { ZodError } from 'zod';
import { ErrorCode, type ApiErrorBody } from '@gmp/shared';

export class AppError extends Error {
  constructor(
    readonly statusCode: number,
    readonly code: string,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

export const unauthorized = (message = 'Authentication required') =>
  new AppError(401, ErrorCode.UNAUTHORIZED, message);
export const forbidden = (message = 'Insufficient permissions') => new AppError(403, ErrorCode.FORBIDDEN, message);
export const notFound = (code: string, message: string) => new AppError(404, code, message);
export const conflict = (code: string, message: string, extra?: Record<string, unknown>) =>
  new AppError(409, code, message, extra);

function body(requestId: string, code: string, message: string, extra: Record<string, unknown> = {}): ApiErrorBody {
  return { error: { ...extra, code, message, requestId } };
}

export function registerErrorHandling(app: FastifyInstance): void {
  app.setErrorHandler((err: FastifyError | AppError | ZodError | Error, req, reply) => {
    if (err instanceof AppError) {
      return reply.status(err.statusCode).send(body(req.id, err.code, err.message, err.extra));
    }
    if (err instanceof ZodError) {
      const message = err.issues.map((i) => `${i.path.join('.') || '(body)'}: ${i.message}`).join('; ');
      return reply.status(400).send(body(req.id, ErrorCode.VALIDATION_ERROR, message));
    }
    const fastifyErr = err as FastifyError;
    const status = fastifyErr.statusCode;
    if (status && status >= 400 && status < 500) {
      // Malformed JSON, unsupported content type, body too large, ...
      return reply.status(status).send(body(req.id, ErrorCode.VALIDATION_ERROR, fastifyErr.message));
    }
    req.log.error({ err }, 'unhandled error');
    return reply.status(500).send(body(req.id, ErrorCode.INTERNAL, 'Internal server error'));
  });

  app.setNotFoundHandler((req, reply) => {
    reply.status(404).send(body(req.id, ErrorCode.NOT_FOUND, `Route ${req.method} ${req.url} not found`));
  });
}
