import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Request, Response } from "express";
import { ErrorCodes } from "@nexus/domain";
import { toUtcIso } from "@nexus/shared";

@Catch()
export class AllExceptionsFilter implements ExceptionFilter {
  catch(exception: unknown, host: ArgumentsHost) {
    const ctx = host.switchToHttp();
    const response = ctx.getResponse<Response>();
    const request = ctx.getRequest<Request & { correlationId?: string }>();

    let status = HttpStatus.INTERNAL_SERVER_ERROR;
    let code: string = ErrorCodes.SYSTEM_INTERNAL_ERROR;
    let message = "Internal server error";
    let details: Record<string, unknown> = {};

    if (exception instanceof HttpException) {
      status = exception.getStatus();
      const body = exception.getResponse();
      if (typeof body === "string") {
        message = body;
      } else if (typeof body === "object" && body !== null) {
        const obj = body as Record<string, unknown>;
        message = String(obj.message ?? message);
        code = String(obj.code ?? code);
        details = (obj.details as Record<string, unknown>) ?? {};
        if (Array.isArray(obj.message)) {
          message = obj.message.join(", ");
          code = ErrorCodes.VALIDATION_FAILED;
        }
      }
    } else if (exception instanceof Error) {
      message = exception.message;
    }

    response.status(status).json({
      code,
      message,
      details,
      correlationId: request.correlationId ?? "unknown",
      timestamp: toUtcIso(),
    });
  }
}
