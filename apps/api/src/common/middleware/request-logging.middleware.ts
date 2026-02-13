import { Logger } from "@nestjs/common";

const logger = new Logger("RequestLogger");

export function requestLoggingMiddleware(
  req: any,
  res: any,
  next: () => void
): void {
  const start = Date.now();

  res.on("finish", () => {
    const durationMs = Date.now() - start;
    const userId = req.user?.userId ?? null;
    const orgId = req.user?.orgId ?? null;

    logger.log(
      JSON.stringify({
        requestId: req.requestId ?? null,
        method: req.method,
        path: req.originalUrl ?? req.url,
        statusCode: res.statusCode,
        duration_ms: durationMs,
        userId,
        orgId,
        ip: req.ip ?? null
      })
    );
  });

  next();
}
