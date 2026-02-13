import "reflect-metadata";
import { BadRequestException, INestApplication, ValidationError, ValidationPipe } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { config } from "dotenv";
import helmet from "helmet";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { AppModule } from "./app.module";
import { AllExceptionsFilter } from "./common/filters/all-exceptions.filter";
import { requestIdMiddleware } from "./common/middleware/request-id.middleware";
import { requestLoggingMiddleware } from "./common/middleware/request-logging.middleware";

const cookieParser = require("cookie-parser") as () => (req: any, res: any, next: () => void) => void;
const expressRuntime = require("express") as {
  json: (options: { limit: string }) => (req: any, res: any, next: () => void) => void;
  urlencoded: (options: { extended: boolean; limit: string }) => (req: any, res: any, next: () => void) => void;
};

function loadEnv(): void {
  const candidates = [
    resolve(process.cwd(), ".env"),
    resolve(process.cwd(), "../../.env"),
    resolve(__dirname, "../../../.env")
  ];
  const envPath = candidates.find((candidate) => existsSync(candidate));
  if (envPath) {
    config({ path: envPath });
    return;
  }
  config();
}

function normalizeOrigin(origin: string): string {
  return origin.trim().replace(/\/+$/, "");
}

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}

function collectValidationIssues(error: ValidationError): string[] {
  const currentIssues = error.constraints ? Object.values(error.constraints) : [];
  const childIssues = (error.children ?? []).flatMap((child) => collectValidationIssues(child));
  return [...currentIssues, ...childIssues];
}

function formatValidationDetails(errors: ValidationError[]): Array<{ field: string; issues: string[] }> {
  return errors
    .map((error) => ({
      field: error.property,
      issues: collectValidationIssues(error)
    }))
    .filter((detail) => detail.issues.length > 0);
}

export async function createConfiguredApp(): Promise<INestApplication> {
  loadEnv();
  requireEnv("DATABASE_URL");
  requireEnv("JWT_SECRET");

  const app = await NestFactory.create(AppModule);
  const expressApp = app.getHttpAdapter().getInstance();
  expressApp.disable("x-powered-by");
  if (process.env.TRUST_PROXY === "true") {
    expressApp.set("trust proxy", 1);
  }

  const corsOriginRaw =
    process.env.CORS_ORIGINS ??
    process.env.CORS_ORIGIN ??
    "http://localhost:3000,http://127.0.0.1:3000";

  const corsOrigins = Array.from(
    new Set(
      corsOriginRaw
        .split(",")
        .map((origin) => normalizeOrigin(origin))
        .filter(Boolean)
    )
  );

  app.enableCors({
    origin: (
      origin: string | undefined,
      callback: (err: Error | null, allow?: boolean) => void
    ) => {
      if (!origin) {
        callback(null, true);
        return;
      }
      if (corsOrigins.includes(normalizeOrigin(origin))) {
        callback(null, true);
        return;
      }
      callback(null, false);
    },
    credentials: true
  });

  app.use(helmet());
  app.use(cookieParser());
  app.use(requestIdMiddleware);
  app.use(requestLoggingMiddleware);
  app.use(expressRuntime.json({ limit: "1mb" }));
  app.use(expressRuntime.urlencoded({ extended: true, limit: "1mb" }));
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
      exceptionFactory: (errors: ValidationError[]) =>
        new BadRequestException({
          code: "VALIDATION_ERROR",
          message: "Invalid request.",
          details: formatValidationDetails(errors)
        })
    })
  );
  app.useGlobalFilters(new AllExceptionsFilter());

  return app;
}
