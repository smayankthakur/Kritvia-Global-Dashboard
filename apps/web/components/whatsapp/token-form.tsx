"use client";

import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Field, FormError, Input } from "@/components/ui/field";
import { api, errorMessage, unwrap, type Schemas } from "@/lib/api";

/** The developer's way to connect: paste a phone number id and a permanent token from Meta.
 * Shown folded away under "Advanced"; most businesses use the Connect WhatsApp button. */
export function WhatsAppTokenForm({ ventureId, onDone }: { ventureId: string; onDone: (out: Schemas["WhatsAppConnectOut"]) => void }) {
  const [phoneId, setPhoneId] = useState("");
  const [token, setToken] = useState("");
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/connectors/whatsapp", {
          params: { path: { venture_id: ventureId } },
          body: { phone_number_id: phoneId.trim(), access_token: token.trim() },
        }),
      ),
    onSuccess: (out) => {
      setToken("");
      onDone(out);
    },
  });
  const valid = /^\d{5,40}$/.test(phoneId.trim()) && token.trim().length >= 20;
  return (
    <form
      className="space-y-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) m.mutate();
      }}
      noValidate
    >
      <p className="text-sm text-muted">
        For developers who already run the number on the WhatsApp Cloud API in Kritvia&apos;s Meta app: paste the number&apos;s phone number id and a
        permanent system-user token with the <em>whatsapp_business_messaging</em> permission.
      </p>
      <FormError message={m.isError ? errorMessage(m.error) : null} />
      <Field label="Phone number id" hint="A long number from WhatsApp → API setup, not the phone number itself." required>
        <Input value={phoneId} inputMode="numeric" placeholder="123456789012345" onChange={(e) => setPhoneId(e.target.value)} />
      </Field>
      <Field label="Permanent access token" hint="Checked with Meta, stored encrypted, never shown again." required>
        <Input type="password" value={token} autoComplete="off" onChange={(e) => setToken(e.target.value)} />
      </Field>
      <Button type="submit" loading={m.isPending} disabled={!valid}>
        Connect with token
      </Button>
    </form>
  );
}
