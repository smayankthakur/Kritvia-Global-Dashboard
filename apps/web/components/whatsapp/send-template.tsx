"use client";

import { useQuery } from "@tanstack/react-query";
import { Field, Input, Select } from "@/components/ui/field";
import { api, unwrap, type Schemas } from "@/lib/api";
import { fillTemplate, languageLabel, sendableTemplates, templateTitle } from "./templates";

export type Template = Schemas["TemplateOut"];
export interface TemplateChoice {
  templateId: string;
  params: string[];
}

/** The business's templates, shared by the chat, the New chat dialog and the Templates tab. */
export function useTemplates(ventureId: string) {
  return useQuery({
    queryKey: ["whatsapp-templates", ventureId],
    queryFn: () => unwrap(api.GET("/ventures/{venture_id}/whatsapp/templates", { params: { path: { venture_id: ventureId } } })),
    staleTime: 30_000,
  });
}

/** Pick an approved template and fill in its blanks, with a preview of what the customer gets. */
export function TemplateFields({
  templates,
  value,
  onChange,
  idPrefix,
}: {
  templates: Template[];
  value: TemplateChoice;
  onChange: (v: TemplateChoice) => void;
  idPrefix: string;
}) {
  const ready = sendableTemplates(templates);
  const t = ready.find((x) => x.id === value.templateId);
  return (
    <div className="space-y-3">
      <Field label="Template" required>
        <Select
          value={value.templateId}
          onChange={(e) => {
            const next = ready.find((x) => x.id === e.target.value);
            onChange({ templateId: e.target.value, params: Array.from({ length: next?.params ?? 0 }, () => "") });
          }}
        >
          <option value="">Choose a template…</option>
          {ready.map((x) => (
            <option key={x.id} value={x.id}>
              {templateTitle(x.name)} · {languageLabel(x.language)}
            </option>
          ))}
        </Select>
      </Field>
      {t
        ? Array.from({ length: t.params }, (_, i) => (
            <Field key={`${idPrefix}-${t.id}-${i}`} label={`Blank ${i + 1}`} hint={t.examples[i] ? `For example: ${t.examples[i]}` : undefined} required>
              <Input
                value={value.params[i] ?? ""}
                maxLength={300}
                onChange={(e) => {
                  const params = [...value.params];
                  params[i] = e.target.value;
                  onChange({ ...value, params });
                }}
              />
            </Field>
          ))
        : null}
      {t ? (
        <div>
          <p className="mb-1 text-xs font-medium text-subtle">The customer gets</p>
          <p className="rounded-lg bg-accent-soft px-3 py-2 text-sm whitespace-pre-wrap break-words text-accent-soft-fg">
            {fillTemplate(t.body, value.params)}
          </p>
        </div>
      ) : null}
    </div>
  );
}
