// Runs in the page: numbers the things a person could use (links, buttons, fields) and returns a
// compact description of the page for the agent. Values of sensitive fields are never returned.
(maxElements) => {
  const SENSITIVE_NAME = /(pass(word|code)?|pwd|card|cc-?(num|number|csc|exp)|cvv|cvc|otp|one.?time|\bpin\b|aadha?ar|\bpan\b|ifsc|account.?(no|number)|ssn|secret|token)/i;
  const SENSITIVE_AC = /^(current-password|new-password|one-time-code|cc-|transaction-)/;
  const visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width < 2 || r.height < 2) return false;
    const s = getComputedStyle(el);
    return s.visibility !== "hidden" && s.display !== "none" && Number(s.opacity) > 0.05;
  };
  const clean = (t, n = 80) => (t || "").replace(/\s+/g, " ").trim().slice(0, n);
  const labelOf = (el) => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) {
      const t = by.split(/\s+/).map((id) => document.getElementById(id)?.innerText || "").join(" ");
      if (clean(t)) return clean(t);
    }
    if (el.labels && el.labels.length) return clean(Array.from(el.labels).map((l) => l.innerText).join(" "));
    if (el.tagName === "INPUT" && ["submit", "button", "reset"].includes(el.type)) return clean(el.value);
    return clean(el.placeholder || el.innerText || el.title || el.alt || el.getAttribute("name") || "");
  };
  const cssPath = (el) => {
    if (el.id && document.querySelectorAll(`#${CSS.escape(el.id)}`).length === 1) return `#${CSS.escape(el.id)}`;
    const name = el.getAttribute("name");
    if (name) {
      const sel = `${el.tagName.toLowerCase()}[name="${CSS.escape(name)}"]`;
      if (document.querySelectorAll(sel).length === 1) return sel;
    }
    const parts = [];
    let n = el;
    while (n && n.nodeType === 1 && n !== document.body && parts.length < 12) {
      let i = 1;
      let s = n.previousElementSibling;
      while (s) {
        if (s.tagName === n.tagName) i += 1;
        s = s.previousElementSibling;
      }
      parts.unshift(`${n.tagName.toLowerCase()}:nth-of-type(${i})`);
      n = n.parentElement;
    }
    return `body > ${parts.join(" > ")}`;
  };
  const isSearchForm = (f) => {
    if (!f) return false;
    if (f.getAttribute("role") === "search" || f.closest("[role=search]")) return true;
    if ((f.getAttribute("action") || "").match(/search|find|query|\/s\b/i)) return true;
    const fields = Array.from(f.elements).filter((e) => e.tagName === "INPUT" && !["hidden", "submit", "button", "image"].includes(e.type));
    return fields.length === 1 && (fields[0].type === "search" || /^(q|query|search|s|k|keyword|term)$/i.test(fields[0].name || ""));
  };
  const forms = Array.from(document.forms);
  document.querySelectorAll("[data-kv-ref]").forEach((e) => e.removeAttribute("data-kv-ref"));
  const candidates = Array.from(document.querySelectorAll(
    "a[href], button, input:not([type=hidden]), textarea, select, summary, [role=button], [role=link], [role=tab], [role=menuitem], [role=checkbox], [contenteditable=true]"));
  const inView = (el) => {
    const r = el.getBoundingClientRect();
    return r.bottom > 0 && r.top < innerHeight * 2.5;
  };
  const ordered = candidates.filter(visible).sort((a, b) => Number(inView(b)) - Number(inView(a)));
  const elements = [];
  for (const el of ordered) {
    if (elements.length >= maxElements) break;
    const tag = el.tagName.toLowerCase();
    const type = (el.getAttribute("type") || "").toLowerCase();
    const ac = (el.getAttribute("autocomplete") || "").toLowerCase();
    const form = el.form || el.closest("form");
    const isField = ["input", "textarea", "select"].includes(tag) && !["submit", "button", "image", "reset"].includes(type);
    const sensitive = isField && (type === "password" || SENSITIVE_AC.test(ac) || SENSITIVE_NAME.test(`${el.getAttribute("name") || ""} ${el.id || ""} ${labelOf(el)}`));
    const submits = Boolean(form) && ((tag === "button" && (type === "" || type === "submit")) || (tag === "input" && ["submit", "image"].includes(type)));
    const ref = elements.length + 1;
    el.setAttribute("data-kv-ref", String(ref));
    const item = { ref, tag, type, role: el.getAttribute("role") || "", name: labelOf(el), selector: cssPath(el) };
    if (tag === "a") item.href = clean(el.href, 300);
    if (isField) {
      item.field = true;
      item.sensitive = sensitive;
      item.required = Boolean(el.required);
      if (!sensitive && type !== "file") item.value = clean(tag === "select" ? el.options[el.selectedIndex]?.text : el.value, 120);
      if (tag === "select") item.options = Array.from(el.options).slice(0, 20).map((o) => clean(o.text, 40));
      if (type === "checkbox" || type === "radio") item.checked = el.checked;
    }
    if (form) {
      item.form = forms.indexOf(form);
      item.search_form = isSearchForm(form);
    }
    if (submits) {
      item.submits = true;
      // what the form sends to, so an approved submit can be checked against it later (never values)
      const action = el.getAttribute("formaction") ? el.formAction : (form.action || location.href);
      const method = ((el.getAttribute("formmethod") ? el.formMethod : form.method) || "get").toLowerCase();
      const hidden = Array.from(form.querySelectorAll("input[type=hidden]")).map((i) => i.name).filter(Boolean).sort();
      item.form_pin = { action, method, hidden };
    }
    elements.push(item);
  }
  const hasPassword = Boolean(document.querySelector("input[type=password]"));
  const captcha = Boolean(document.querySelector("iframe[src*='recaptcha'], iframe[src*='hcaptcha'], iframe[src*='turnstile'], .g-recaptcha, .h-captcha, .cf-turnstile"));
  return {
    url: location.href,
    title: clean(document.title, 200),
    text: (document.body ? document.body.innerText : "").replace(/\n{3,}/g, "\n\n").slice(0, 8000),
    elements,
    login_wall: hasPassword,
    captcha,
  };
}
