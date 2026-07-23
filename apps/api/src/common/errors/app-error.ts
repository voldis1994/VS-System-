import { HttpException, HttpStatus } from "@nestjs/common";
import type { ErrorCode } from "@nexus/domain";

export class AppError extends HttpException {
  constructor(
    code: ErrorCode | string,
    message: string,
    status: HttpStatus = HttpStatus.BAD_REQUEST,
    details: Record<string, unknown> = {},
  ) {
    super({ code, message, details }, status);
  }
}
