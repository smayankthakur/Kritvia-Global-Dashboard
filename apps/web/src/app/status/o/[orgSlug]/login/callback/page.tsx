import { StatusCallbackClient } from "./callback-client";

export default async function StatusSsoCallbackPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  return <StatusCallbackClient orgSlug={orgSlug} />;
}
