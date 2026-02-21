import {
  CallHandler,
  ExecutionContext,
  Injectable,
  NestInterceptor,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { Observable, throwError } from 'rxjs';
import { tap, catchError } from 'rxjs/operators';
import { randomUUID } from 'crypto';
import { Request, Response } from 'express';

export const IMTBL_EVENT_NAME = 'imtbl:eventName';

export interface ImmutableLogOptions {
  apiKey: string;
  apiUrl?: string;
  serviceName?: string;
  env?: string;
  skipPaths?: string[];
}

interface EventPayload {
  id: string;
  kind: 'success' | 'info' | 'error';
  message: string;
  timestamp: string;
  context: {
    ip: string;
    userAgent: string;
  };
  request: {
    requestId: string;
    method: string;
    path: string;
  };
  metrics: {
    latencyMs: number;
    statusCode: number;
  };
  error?: {
    exception?: string;
    exceptionMessage?: string;
    retryable?: boolean;
  };
  severity: 'low' | 'high';
}

const RETRYABLE_STATUSES = new Set([408, 429, 500, 502, 503, 504]);
const MAX_PAYLOAD_BYTES = 12 * 1024;

function resolveKind(status: number): 'success' | 'info' | 'error' {
  if (status >= 200 && status < 300) return 'success';
  if (status >= 300 && status < 400) return 'info';
  return 'error';
}

function getClientIp(req: Request): string {
  const forwarded = req.headers['x-forwarded-for'];
  if (forwarded) {
    return (Array.isArray(forwarded) ? forwarded[0] : forwarded).split(',')[0].trim();
  }
  return req.socket?.remoteAddress ?? 'unknown';
}

function clampPayload(payloadObj: EventPayload): string {
  let serialized = JSON.stringify(payloadObj);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_PAYLOAD_BYTES) return serialized;

  const trimmed = { ...payloadObj };
  delete trimmed.error;
  serialized = JSON.stringify(trimmed);
  if (Buffer.byteLength(serialized, 'utf8') <= MAX_PAYLOAD_BYTES) return serialized;

  const minimal = {
    id: payloadObj.id,
    kind: payloadObj.kind,
    message: payloadObj.message,
    timestamp: payloadObj.timestamp,
    context: payloadObj.context,
    request: payloadObj.request,
    metrics: payloadObj.metrics,
    severity: payloadObj.severity,
  };
  return JSON.stringify(minimal);
}

async function emitEvent(
  apiKey: string,
  apiUrl: string,
  serviceName: string,
  env: string,
  requestId: string,
  eventName: string,
  payloadObj: EventPayload,
): Promise<void> {
  const payloadStr = clampPayload(payloadObj);

  await fetch(`${apiUrl}/v1/events`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
      'Idempotency-Key': payloadObj.id,
      'Request-Id': requestId,
    },
    body: JSON.stringify({
      payload: payloadStr,
      meta: {
        type: payloadObj.kind,
        event_name: eventName,
        service: serviceName,
        request_id: requestId,
        env,
      },
    }),
  });
}

@Injectable()
export class ImmutableLogInterceptor implements NestInterceptor {
  private readonly apiKey: string;
  private readonly apiUrl: string;
  private readonly serviceName: string;
  private readonly env: string;
  private readonly skipPaths: string[];

  constructor(
    opts: ImmutableLogOptions,
    private readonly reflector: Reflector,
  ) {
    this.apiKey = opts.apiKey ?? '';
    this.apiUrl = opts.apiUrl ?? 'https://api.immutablelog.com';
    this.serviceName = opts.serviceName ?? 'nestjs-service';
    this.env = opts.env ?? 'production';
    this.skipPaths = opts.skipPaths ?? ['/health', '/healthz'];
  }

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    if (!this.apiKey) return next.handle();

    const http = context.switchToHttp();
    const req = http.getRequest<Request>();
    const res = http.getResponse<Response>();

    const path = req.path;
    if (this.skipPaths.some((p) => path === p || path.startsWith(p + '/'))) {
      return next.handle();
    }

    const startedAt = Date.now();
    const requestId = (req.headers['x-request-id'] as string) ?? randomUUID();
    res.setHeader('x-request-id', requestId);

    const eventNameMeta =
      this.reflector.get<string>(IMTBL_EVENT_NAME, context.getHandler()) ??
      this.reflector.get<string>(IMTBL_EVENT_NAME, context.getClass());

    return next.handle().pipe(
      tap(() => {
        const status = res.statusCode;
        const latencyMs = Date.now() - startedAt;
        const kind = resolveKind(status);
        const method = req.method.toUpperCase();
        const eventName = eventNameMeta ?? `http.${method}.${path}`;

        const payloadObj: EventPayload = {
          id: randomUUID(),
          kind,
          message: `${method} ${path} completed${kind === 'error' ? ' with error' : ' successfully'}`,
          timestamp: new Date().toISOString(),
          context: { ip: getClientIp(req), userAgent: req.headers['user-agent'] ?? '' },
          request: { requestId, method, path },
          metrics: { latencyMs, statusCode: status },
          severity: kind === 'error' ? 'high' : 'low',
        };

        if (kind === 'error') {
          payloadObj.error = { retryable: RETRYABLE_STATUSES.has(status) };
        }

        emitEvent(this.apiKey, this.apiUrl, this.serviceName, this.env, requestId, eventName, payloadObj).catch((err) => {
          console.warn('[ImmutableLog] Failed to emit event:', err?.message ?? err);
        });
      }),
      catchError((err: Error) => {
        const status = (err as any).status ?? (err as any).statusCode ?? 500;
        const latencyMs = Date.now() - startedAt;
        const method = req.method.toUpperCase();
        const eventName = eventNameMeta ?? `http.${method}.${path}`;

        const payloadObj: EventPayload = {
          id: randomUUID(),
          kind: 'error',
          message: `${method} ${path} threw an exception`,
          timestamp: new Date().toISOString(),
          context: { ip: getClientIp(req), userAgent: req.headers['user-agent'] ?? '' },
          request: { requestId, method, path },
          metrics: { latencyMs, statusCode: status },
          error: {
            exception: err.constructor.name,
            exceptionMessage: err.message,
            retryable: RETRYABLE_STATUSES.has(status),
          },
          severity: 'high',
        };

        emitEvent(this.apiKey, this.apiUrl, this.serviceName, this.env, requestId, eventName, payloadObj).catch((e) => {
          console.warn('[ImmutableLog] Failed to emit error event:', e?.message ?? e);
        });

        return throwError(() => err);
      }),
    );
  }
}
