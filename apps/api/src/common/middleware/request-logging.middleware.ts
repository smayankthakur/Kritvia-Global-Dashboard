import { Logger } from "@nestjs/common";
import { getActiveOrgId } from "../auth-org";

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
    let orgId: string | null = null;
    if (req.user) {
      try {
        orgId = getActiveOrgId({ user: req.user });
      } catch {
        orgId = null;
      }
    }

    const payload = {
      requestId: req.requestId ?? null,
      method: req.method,
      path: req.originalUrl ?? req.url,
      statusCode: res.statusCode,
      duration_ms: durationMs,
      userId,
      orgId,
      ip: req.ip ?? null
    };

    logger.log(JSON.stringify(payload));
    if (durationMs > 500) {
      logger.warn(JSON.stringify({ ...payload, slow: true }));
    }
  });

  next();
}
