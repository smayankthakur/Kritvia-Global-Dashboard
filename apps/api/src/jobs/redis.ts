import { Redis } from "ioredis";

let redis: Redis | null = null;

export function getRedis(): Redis {
  if (redis) {
    return redis;
  }

  const redisUrl = process.env.REDIS_URL;
  if (!redisUrl) {
    throw new Error("REDIS_URL is required when JOBS_ENABLED=true");
  }

  redis = new Redis(redisUrl, {
    maxRetriesPerRequest: null,
    enableReadyCheck: true
  });

  return redis;
}

export async function closeRedis(): Promise<void> {
  if (!redis) {
    return;
  }
  await redis.quit();
  redis = null;
}

