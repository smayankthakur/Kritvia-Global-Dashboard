import { StatusLoginClient } from "./login-client";

export default async function StatusSsoLoginPage({ params }: { params: Promise<{ orgSlug: string }> }) {
  const { orgSlug } = await params;
  return <StatusLoginClient orgSlug={orgSlug} />;
}
