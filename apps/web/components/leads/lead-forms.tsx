"use client";

import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ArrowRight } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, type FormEvent } from "react";
import { Button, ButtonLink } from "@/components/ui/button";
import { Dialog } from "@/components/ui/dialog";
import { Field, FormError, Input, Textarea } from "@/components/ui/field";
import { Notice } from "@/components/ui/page";
import { useToast } from "@/components/ui/toast";
import { ApiError, api, errorMessage, unwrap, type Schemas } from "@/lib/api";
import { EMAIL_RE } from "@/lib/auth-client";

type Lead = Schemas["LeadOut"];

/** A phone number as people type it: digits with an optional +, spaces, dashes or brackets. */
export const PHONE_RE = /^\+?[\d\s().-]{6,30}$/;

export function phoneProblem(phone: string): string | null {
  const p = phone.trim();
  if (!p) return null;
  if (!PHONE_RE.test(p) || p.replace(/\D/g, "").length < 6) return "Enter a phone number, e.g. +91 98100 12345";
  return null;
}

/**
 * Add a lead by hand (a call, a walk-in, a card), or edit one: name, phone, email and notes (round 3, A7).
 * The AI isn't involved; use New inquiry to have an enquiry scored and priced.
 */
export function LeadFormDialog({ open, onClose, ventureId, lead }: { open: boolean; onClose: () => void; ventureId: string; lead?: Lead | null }) {
  const toast = useToast();
  const qc = useQueryClient();
  const editing = Boolean(lead);
  const fromLead = () => ({ name: lead?.name ?? "", phone: lead?.phone ?? "", email: lead?.email ?? "", company: lead?.company ?? "", notes: lead?.notes ?? "" });
  const [f, setF] = useState(fromLead);
  const [errors, setErrors] = useState<Record<string, string>>({});
  useEffect(() => {
    if (open) {
      setF(fromLead());
      setErrors({});
    }
    // Reset only when the dialog opens (or opens on another lead).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, lead?.id]);
  const m = useMutation({
    mutationFn: () => {
      const clean = { name: f.name.trim(), phone: f.phone.trim() || null, email: f.email.trim() || null, notes: f.notes.trim() || null };
      return lead
        ? unwrap(api.PATCH("/ventures/{venture_id}/leads/{lead_id}", { params: { path: { venture_id: ventureId, lead_id: lead.id } }, body: clean }))
        : unwrap(api.POST("/ventures/{venture_id}/leads", { params: { path: { venture_id: ventureId } }, body: { ...clean, company: f.company.trim() || null, source: "manual" } }));
    },
    onSuccess: () => {
      toast.success(editing ? "Lead saved" : "Lead added");
      void qc.invalidateQueries({ queryKey: ["leads", ventureId] });
      onClose();
    },
    onError: (e) => {
      if (e instanceof ApiError && Object.keys(e.fieldErrors).length) setErrors(e.fieldErrors);
    },
  });
  const submit = (e: FormEvent) => {
    e.preventDefault();
    const errs: Record<string, string> = {};
    if (!f.name.trim()) errs.name = "Add their name";
    if (f.email.trim() && !EMAIL_RE.test(f.email.trim())) errs.email = "Enter a valid email";
    const p = phoneProblem(f.phone);
    if (p) errs.phone = p;
    setErrors(errs);
    if (!Object.keys(errs).length) m.mutate();
  };
  const set = (k: keyof typeof f) => (e: React.ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => setF((x) => ({ ...x, [k]: e.target.value }));
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={editing ? "Edit lead" : "Add a lead"}
      description={editing ? undefined : "Someone who called, walked in or was referred. Saved as it is, without AI scoring."}
      size="md"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" type="submit" form="lead-form" loading={m.isPending}>
            {editing ? "Save lead" : "Add lead"}
          </Button>
        </>
      }
    >
      <form id="lead-form" onSubmit={submit} noValidate className="space-y-4">
        <FormError message={m.isError && !Object.keys(errors).length ? errorMessage(m.error) : null} />
        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="Name" error={errors.name} required>
            <Input value={f.name} onChange={set("name")} maxLength={200} autoComplete="off" />
          </Field>
          <Field label="Phone" error={errors.phone}>
            <Input type="tel" inputMode="tel" value={f.phone} onChange={set("phone")} maxLength={30} placeholder="+91 98100 12345" />
          </Field>
          <Field label="Email" error={errors.email}>
            <Input type="email" value={f.email} onChange={set("email")} />
          </Field>
          {editing ? null : (
            <Field label="Company" error={errors.company}>
              <Input value={f.company} onChange={set("company")} maxLength={200} />
            </Field>
          )}
        </div>
        <Field label="Notes" error={errors.notes}>
          <Textarea rows={4} value={f.notes} onChange={set("notes")} maxLength={20000} />
        </Field>
      </form>
    </Dialog>
  );
}

/** Start a proposal for a lead by hand: say what they need, and the lead agent prices it from the rate card (round 3, A15). */
export function NewProposalDialog({ open, onClose, ventureId, lead }: { open: boolean; onClose: () => void; ventureId: string; lead: Lead }) {
  const toast = useToast();
  const qc = useQueryClient();
  const [need, setNeed] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [started, setStarted] = useState<string | null>(null);
  useEffect(() => {
    if (open) {
      setNeed("");
      setError(null);
      setStarted(null);
    }
  }, [open]);
  const name = lead.name || lead.company || lead.email || "this lead";
  const m = useMutation({
    mutationFn: () =>
      unwrap(
        api.POST("/ventures/{venture_id}/runs", {
          params: { path: { venture_id: ventureId } },
          body: {
            workflow: "lead_triage",
            title: `Proposal for ${name}`.slice(0, 200),
            input: { lead_id: lead.id, from_name: lead.name || null, from_email: lead.email || null, subject: `Proposal for ${name}`.slice(0, 300), body: need.trim() },
          },
        }),
      ),
    onSuccess: (r) => {
      setStarted(r.id);
      toast.success("Proposal started", "It's priced from your rate card and waits in your inbox for your yes.");
      void qc.invalidateQueries({ queryKey: ["runs", ventureId] });
    },
  });
  return (
    <Dialog
      open={open}
      onClose={onClose}
      title={`New proposal for ${name}`}
      description="The lead agent prices it from your rate card and drafts the proposal. Nothing is sent until you approve it."
      size="md"
      footer={
        started ? (
          <>
            <Button onClick={onClose}>Close</Button>
            <ButtonLink href={`/v/${ventureId}/runs/${started}`} variant="primary" icon={<ArrowRight className="h-4 w-4" />}>
              View run
            </ButtonLink>
          </>
        ) : (
          <>
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" type="submit" form="proposal-form" loading={m.isPending}>
              Start proposal
            </Button>
          </>
        )
      }
    >
      {started ? (
        <Notice tone="success" title="Proposal started">
          The draft lands in your inbox when it&apos;s ready.{" "}
          <Link className="font-medium underline" href={`/v/${ventureId}/runs/${started}`}>
            Follow the run
          </Link>
        </Notice>
      ) : (
        <form
          id="proposal-form"
          noValidate
          className="space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            if (need.trim().length < 3) setError("Say in a few words what they need");
            else {
              setError(null);
              m.mutate();
            }
          }}
        >
          <FormError message={m.isError ? errorMessage(m.error) : null} />
          <Field label="What do they need?" error={error} required hint="Pages, features, quantities, timeline, budget: whatever they told you.">
            <Textarea rows={6} value={need} maxLength={20000} onChange={(e) => setNeed(e.target.value)} placeholder="An 8-page website with online booking and a WhatsApp button, ready in 4 weeks." />
          </Field>
        </form>
      )}
    </Dialog>
  );
}
