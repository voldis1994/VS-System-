import "dotenv/config";
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

async function bootstrap() {
  const env = loadEnv(process.env);
  const app = await NestFactory.create(AppModule, {
    logger: ["error", "warn", "log"],
  });

  app.useWebSocketAdapter(new WsAdapter(app));
  app.use(helmet({ contentSecurityPolicy: false }));
  app.use(cookieParser());
  app.enableCors({
    origin: env.CORS_ORIGIN.split(","),
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
  console.log(`NEXUS PRO API listening on http://${env.API_HOST}:${env.API_PORT}`);
}

bootstrap().catch((err) => {
  // eslint-disable-next-line no-console
  console.error("Failed to bootstrap API", err);
  process.exit(1);
});
