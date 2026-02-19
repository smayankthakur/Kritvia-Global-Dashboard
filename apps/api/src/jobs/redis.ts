import { Logger } from "@nestjs/common";
import { Redis } from "ioredis";

let redis: Redis | null = null;
let missingRedisWarned = false;
const logger = new Logger("JobsRedis");

export function parseBool(value: string | undefined, fallback = false): boolean {
  if (value === undefined) {
    return fallback;
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "1" || normalized === "yes" || normalized === "on") {
    return true;
  }
  if (normalized === "false" || normalized === "0" || normalized === "no" || normalized === "off") {
    return false;
  }
  return fallback;
}

export function safeGetRedis(): Redis | null {
  if (redis) {
    return redis;
  }

  const jobsEnabled = parseBool(process.env.JOBS_ENABLED, false);
  if (!jobsEnabled) {
    return null;
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    if (!missingRedisWarned) {
      missingRedisWarned = true;
      logger.warn("JOBS_ENABLED=true but REDIS_URL missing; workers disabled");
    }
    return null;
  }

  let parsedUrl: URL;
  try {
    parsedUrl = new URL(redisUrl);
  } catch {
    if (!missingRedisWarned) {
      missingRedisWarned = true;
      logger.warn("Invalid REDIS_URL format; workers disabled");
    }
    return null;
  }

  if (parsedUrl.protocol !== "redis:" && parsedUrl.protocol !== "rediss:") {
    if (!missingRedisWarned) {
      missingRedisWarned = true;
      logger.warn("REDIS_URL must start with redis:// or rediss://; workers disabled");
    }
    return null;
  }

  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true,
    ...(parsedUrl.protocol === "rediss:" ? { tls: {} } : {})
  });
  redis.on("error", (error) => {
    logger.warn(`Redis connection warning: ${error?.message ?? "unknown error"}`);
  });

  return redis;
}

export function getRedis(): Redis {
  const client = safeGetRedis();
  if (!client) {
    if (parseBool(process.env.STRICT_JOBS, false)) {
      throw new Error("REDIS_URL is required when JOBS_ENABLED=true and STRICT_JOBS=true");
    }
    throw new Error("REDIS_URL is required when JOBS_ENABLED=true");
  }
  return client;
}

export async function closeRedis(): Promise<void> {
  if (!redis) {
    return;
  }
  await redis.quit();
  redis = null;
}
