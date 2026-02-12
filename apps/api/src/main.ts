import { createConfiguredApp } from "./bootstrap";

async function bootstrap(): Promise<void> {
  const app = await createConfiguredApp();
  const port = Number(process.env.API_PORT ?? 4000);
  await app.listen(port);
}

bootstrap();
