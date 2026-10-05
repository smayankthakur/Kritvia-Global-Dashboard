"use client";

import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Checkbox, FormError } from "@/components/ui/field";
import { meKey } from "@/lib/access";
import { api, errorMessage, unwrap } from "@/lib/api";
import { consumeTermsIntent, needsTerms } from "@/lib/terms";

/**
 * Makes sure the signed-in person has accepted the Terms of Service and Privacy Policy now in
 * force, and that the acceptance is on record. A tick on the sign-up page is recorded silently;
 * otherwise (older accounts, or after the terms change) a dialog asks once.
 */
export function TermsGate() {
  const qc = useQueryClient();
  const me = useQuery({ queryKey: meKey, queryFn: () => unwrap(api.GET("/auth/me")), staleTime: 5 * 60_000 });
  const [agreed, setAgreed] = useState(false);
  const [adult, setAdult] = useState(false);
  const [ask, setAsk] = useState(false);
  const tried = useRef(false);
  const accept = useMutation({
    mutationFn: (version: string) => unwrap(api.POST("/auth/me/terms", { body: { version, adult: true } })),
    onSuccess: () => {
      setAsk(false);
      void qc.invalidateQueries({ queryKey: meKey });
    },
    onError: () => setAsk(true),
  });

  const pending = needsTerms(me.data);
  useEffect(() => {
    if (!pending || !me.data || tried.current) return;
    tried.current = true;
    if (consumeTermsIntent()) accept.mutate(me.data.terms_current);
    else setAsk(true);
  }, [pending, me.data, accept]);

  if (!pending || !me.data) return null;
  const first = !me.data.terms_version;
  return (
    <Dialog
      open={ask}
      onClose={() => undefined}
      dismissible={false}
      size="sm"
      title={first ? "Before you start" : "We've updated our terms"}
      description={
        first
          ? "Please read and accept the terms that cover your use of Kritvia and your business's data."
          : "Please read the new versions and accept them to keep using Kritvia."
      }
      footer={
        <Button
          variant="primary"
          disabled={!agreed || !adult}
          loading={accept.isPending}
          onClick={() => accept.mutate(me.data!.terms_current)}
        >
          Accept and continue
        </Button>
      }
    >
      <div className="space-y-3">
        <FormError message={accept.isError ? errorMessage(accept.error) : null} />
        <Checkbox checked={adult} onChange={(e) => setAdult(e.target.checked)} label="I am 18 or older" hint="Kritvia is only for adults." />
        <Checkbox
          checked={agreed}
          onChange={(e) => setAgreed(e.target.checked)}
          label={
            <>
              I accept the{" "}
              <Link href="/terms" target="_blank" className="text-accent underline">
                Terms of Service
              </Link>{" "}
              and{" "}
              <Link href="/privacy" target="_blank" className="text-accent underline">
                Privacy Policy
              </Link>{" "}
              for my business.
            </>
          }
        />
      </div>
    </Dialog>
  );
}
