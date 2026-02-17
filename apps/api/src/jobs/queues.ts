import { JobsOptions, Queue } from "bullmq";
import { getRedis } from "./redis";

export const QUEUE_NAMES = {
  ai: "ai",
  webhooks: "webhooks",
  maintenance: "maintenance",
  dlq: "dlq",
  alerts: "alerts"
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const queueMap = new Map<QueueName, Queue>();

function createQueue(name: QueueName): Queue {
  const existing = queueMap.get(name);
  if (existing) {
    return existing;
  }

  const queue = new Queue(name, {
    connection: getRedis() as never,
    defaultJobOptions: {
      attempts: 5,
      backoff: {
        type: "exponential",
        delay: 10_000
      },
      removeOnComplete: true,
      removeOnFail: false
    }
  });

  queueMap.set(name, queue);
  return queue;
}

export function getQueue(name: QueueName): Queue {
  return createQueue(name);
}

export function getAllQueues(): Record<QueueName, Queue> {
  return {
    ai: getQueue(QUEUE_NAMES.ai),
    webhooks: getQueue(QUEUE_NAMES.webhooks),
    maintenance: getQueue(QUEUE_NAMES.maintenance),
    dlq: getQueue(QUEUE_NAMES.dlq),
    alerts: getQueue(QUEUE_NAMES.alerts)
  };
}

export function withDefaultJobOptions(options?: JobsOptions): JobsOptions {
  return {
    attempts: 5,
    backoff: {
      type: "exponential",
      delay: 10_000
    },
    removeOnComplete: true,
    removeOnFail: false,
    ...options
  };
}
