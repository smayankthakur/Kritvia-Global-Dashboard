import type { VercelRequest, VercelResponse } from "@vercel/node";
import { INestApplication } from "@nestjs/common";
import { createConfiguredApp } from "../src/bootstrap";

let cachedApp: INestApplication | null = null;
let cachedHandler:
  | ((req: VercelRequest, res: VercelResponse) => void | Promise<void>)
  | null = null;

async function getHandler(): Promise<(req: VercelRequest, res: VercelResponse) => void | Promise<void>> {
  if (cachedHandler) {
    return cachedHandler;
  }

  cachedApp = await createConfiguredApp();
  await cachedApp.init();

  const expressApp = cachedApp.getHttpAdapter().getInstance() as (
    req: VercelRequest,
    res: VercelResponse
  ) => void | Promise<void>;

  cachedHandler = expressApp;
  return cachedHandler;
}

export default async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
  const expressHandler = await getHandler();
  await Promise.resolve(expressHandler(req, res));
}
