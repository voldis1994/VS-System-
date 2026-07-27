import { config as loadDotenv } from "dotenv";
import { existsSync } from "fs";
import { resolve } from "path";
import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { ValidationPipe } from "@nestjs/common";
import { WsAdapter } from "@nestjs/platform-ws";
import cookieParser from "cookie-parser";
import helmet from "helmet";
import { AppModule } from "./app.module";
import { loadEnv } from "@nexus/config";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { CorrelationInterceptor } from "./common/interceptors/correlation.interceptor";

function loadEnvFiles() {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "apps/api/.env"),
    resolve(__dirname, "../.env"),
    resolve(__dirname, "../../../.env"),
  ];
  for (const file of candidates) {
    if (existsSync(file)) {
      loadDotenv({ path: file, override: false });
    }
  }
}

async function bootstrap() {
  loadEnvFiles();
  const env = loadEnv(process.env);
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn", "log"],
  });

  app.useWebSocketAdapter(new WsAdapter(app));
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  app.enableCors({
    origin: (origin, callback) => {
      const allowed = env.CORS_ORIGIN.split(",").map((s) => s.trim()).filter(Boolean);
      if (!origin || allowed.includes(origin) || allowed.includes("*")) {
        callback(null, true);
        return;
      }
      // Phone client on LAN (PC as server)
      if (
        /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/i.test(origin) ||
        /^https?:\/\/(192\.168\.\d{1,3}\.\d{1,3}|10\.\d{1,3}\.\d{1,3}\.\d{1,3}|172\.(1[6-9]|2\d|3[0-1])\.\d{1,3}\.\d{1,3})(:\d+)?$/i.test(
          origin,
        )
      ) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true,
  });
  app.setGlobalPrefix("api");
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: true,
    }),
  );
  app.useGlobalFilters(new AllExceptionsFilter());
  app.useGlobalInterceptors(new CorrelationInterceptor());

  await app.listen(env.API_PORT, env.API_HOST);
  // eslint-disable-next-line no-console
  console.log(`VS System API listening on http://${env.API_HOST}:${env.API_PORT}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to bootstrap API", err);
  process.exit(1);
});
