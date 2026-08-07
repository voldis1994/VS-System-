import {
  ExceptionFilter,
  Catch,
  ArgumentsHost,
  HttpException,
  HttpStatus,
} from "@nestjs/common";
import { Prisma } from "@prisma/client";
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
    } else if (exception instanceof Prisma.PrismaClientKnownRequestError) {
      if (exception.code === "P2002") {
        status = HttpStatus.CONFLICT;
        code = ErrorCodes.VALIDATION_FAILED;
        const target = Array.isArray(exception.meta?.target)
          ? (exception.meta?.target as string[]).join(", ")
          : String(exception.meta?.target ?? "unique");
        message = `DB unique conflict (${target}). STOP, tad SAVE/START. Ja kļūdā rādās api-desktop/botPosition — PC darbojas NEPAREIZS API (nav VS System main).`;
      } else {
        message = `Database error ${exception.code}`;
      }
    } else if (exception instanceof Error) {
      message = sanitizePublicError(exception.message);
    }

    response.status(status).json({
      code,
      message,
      details,
      correlationId: request.correlationId ?? "unknown",
      timestamp: toUtcIso(),
      service: "vs-system-api",
    });
  }
}

/** Keep mobile UI readable — strip long Prisma/Node stacks. */
function sanitizePublicError(raw: string): string {
  const s = String(raw ?? "");
  if (/botPosition|api-desktop|bot-runtime/i.test(s)) {
    return (
      "PC darbojas vecs/nepareizs API (api-desktop/botPosition). " +
      "Aizver to, mapē jābūt apps\\api (ne api-desktop). Palaid START-VS-SYSTEM.bat no git main."
    );
  }
  if (/PrismaClientKnownRequestError|Invalid\s+`prisma\./i.test(s)) {
    const short = s.split("\n")[0]?.slice(0, 180) ?? "Database error";
    return short;
  }
  if (s.length > 400) return `${s.slice(0, 400)}…`;
  return s;
}
