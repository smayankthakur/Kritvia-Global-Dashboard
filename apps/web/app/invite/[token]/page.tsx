"use client";

import { useMutation } from "@tanstack/react-query";
import { CheckCircle2, UserPlus } from "lucide-react";
import { useParams } from "next/navigation";
import { AuthCard } from "@/components/shell/auth-card";
import { Button } from "@/components/ui/button";
import { FormError } from "@/components/ui/field";
import { ApiError, api, errorMessage, unwrap } from "@/lib/api";
import { titleCase } from "@/lib/format";

export default function AcceptInvitationPage() {
  const { token } = useParams<{ token: string }>();
  const accept = useMutation({
    mutationFn: () =>
      unwrap(api.POST("/invitations/accept", { body: { token } })),
    onSuccess: (out) => {
      window.setTimeout(
        () =>
          window.location.assign(
            out.venture_id ? `/v/${out.venture_id}/runs` : "/",
          ),
        900,
      );
    },
  });
  const message = accept.error
    ? accept.error instanceof ApiError && accept.error.status === 409
      ? "This invitation was sent to a different email address. Sign in with the invited email, or ask for a new link."
      : accept.error instanceof ApiError && accept.error.status === 404
        ? "This invitation link is invalid, expired, revoked or already used."
        : errorMessage(accept.error)
    : null;
  return (
    <AuthCard
      title="You've been invited"
      subtitle="Join your team's Kritvia workspace."
    >
      {accept.isSuccess ? (
        <p className="flex items-center gap-2 text-sm">
          <CheckCircle2 className="h-5 w-5 text-success-fg" aria-hidden />
          Joined as {titleCase(accept.data.role)}. Taking you there…
        </p>
      ) : (
        <div className="space-y-4">
          <FormError message={message} />
          <p className="text-sm text-muted">
            Accepting adds the invited role to the account you are signed in
            with. The invitation only works for the email address it was sent
            to.
          </p>
          <Button
            variant="primary"
            className="w-full"
            loading={accept.isPending}
            icon={<UserPlus className="h-4 w-4" />}
            onClick={() => accept.mutate()}
          >
            Accept invitation
          </Button>
        </div>
      )}
    </AuthCard>
  );
}
