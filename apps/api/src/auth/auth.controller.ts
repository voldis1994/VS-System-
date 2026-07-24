import {
  Body,
  Controller,
  Get,
  Post,
  Req,
  Res,
  UseGuards,
} from "@nestjs/common";
import { Request, Response } from "express";
import { AuthService } from "./auth.service";
import { JwtAuthGuard } from "./jwt-auth.guard";
import type { AuthUser } from "../common/guards/permissions.guard";

@Controller("auth")
export class AuthController {
  constructor(private readonly auth: AuthService) {}

  @Post("register")
  async register(
    @Body() body: unknown,
    @Req() req: Request & { correlationId?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.register(body, {
      ip: req.ip,
      ua: req.headers["user-agent"],
      correlationId: req.correlationId ?? "unknown",
    });
    this.setAuthCookie(res, result.accessToken);
    return result;
  }

  @Post("login")
  async login(
    @Body() body: unknown,
    @Req() req: Request & { correlationId?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.login(body, {
      ip: req.ip,
      ua: req.headers["user-agent"],
      correlationId: req.correlationId ?? "unknown",
    });
    if ("accessToken" in result && result.accessToken) {
      this.setAuthCookie(res, result.accessToken);
    }
    return result;
  }

  @Post("2fa/verify")
  async verify2FA(
    @Body() body: unknown,
    @Req() req: Request & { correlationId?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.verify2FA(body, {
      ip: req.ip,
      ua: req.headers["user-agent"],
      correlationId: req.correlationId ?? "unknown",
    });
    this.setAuthCookie(res, result.accessToken);
    return result;
  }

  @Post("2fa/enable")
  @UseGuards(JwtAuthGuard)
  async enable2FA(@Req() req: Request & { user: AuthUser; correlationId?: string }) {
    return this.auth.enable2FA(
      req.user.userId,
      req.user.organizationId,
      req.correlationId ?? "unknown",
    );
  }

  @Post("trading-pin/verify")
  @UseGuards(JwtAuthGuard)
  async verifyPin(
    @Body() body: unknown,
    @Req() req: Request & { user: AuthUser; correlationId?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const tokens = await this.auth.verifyTradingPin(
      req.user.userId,
      req.user.organizationId,
      req.user.role,
      req.user.email,
      body,
      {
        correlationId: req.correlationId ?? "unknown",
        ip: req.ip,
        ua: req.headers["user-agent"],
      },
    );
    this.setAuthCookie(res, tokens.accessToken);
    return { ...tokens, tradingPinVerified: true };
  }

  @Post("logout")
  @UseGuards(JwtAuthGuard)
  async logout(
    @Req() req: Request & { user: AuthUser; correlationId?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    await this.auth.logout(
      req.user.userId,
      req.user.organizationId,
      req.correlationId ?? "unknown",
    );
    res.clearCookie("access_token");
    return { ok: true };
  }

  @Post("refresh")
  async refresh(
    @Body() body: { refreshToken?: string; accessToken?: string },
    @Req() req: Request & { correlationId?: string },
    @Res({ passthrough: true }) res: Response,
  ) {
    const result = await this.auth.refresh(body, {
      ip: req.ip,
      ua: req.headers["user-agent"],
      correlationId: req.correlationId ?? "unknown",
    });
    this.setAuthCookie(res, result.accessToken);
    return result;
  }

  @Get("me")
  @UseGuards(JwtAuthGuard)
  async me(@Req() req: Request & { user: AuthUser }) {
    return this.auth.me(req.user.userId, req.user.organizationId);
  }

  private setAuthCookie(res: Response, token: string) {
    res.cookie("access_token", token, {
      httpOnly: true,
      sameSite: "lax",
      secure: process.env.NODE_ENV === "production",
      maxAge: 24 * 60 * 60 * 1000,
    });
  }
}
