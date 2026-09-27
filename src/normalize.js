import { asArray } from "./ids.js";

/**
 * Normalize any input to the canonical payload shape:
 * { to, cc, bcc, from, subject, html, text, replyTo, tags, metadata }
 */
export function normalizeRest(input = {}) {
  return {
    to: asArray(input.to ?? input.To ?? []),
    cc: asArray(input.cc ?? input.Cc ?? []),
    bcc: asArray(input.bcc ?? input.Bcc ?? []),
    from: input.from ?? input.From ?? input.FromEmailAddress ?? "",
    subject: input.subject ?? input.Subject ?? "",
    html: input.html ?? input.Html ?? null,
    text: input.text ?? input.Text ?? null,
    replyTo: input.replyTo ?? input.ReplyTo ?? null,
    tags: input.tags ?? [],
    metadata: input.metadata ?? {},
  };
}

function sesSimpleContent(content = {}) {
  const simple = content.Simple ?? {};
  return {
    subject: simple.Subject?.Data ?? "",
    html: simple.Body?.Html?.Data ?? null,
    text: simple.Body?.Text?.Data ?? null,
  };
}

function badRequest(message) {
  const e = new Error(message);
  e.status = 400;
  throw e;
}

function emailTags(list, field) {
  if (list == null) return [];
  if (!Array.isArray(list)) badRequest(`${field} must be an array`);
  return list.map((t) => `${t.Name}=${t.Value}`);
}

/** SESv2 SendEmail (JSON) -> canonical payload. Throws 400 when destination is missing. */
export function parseSendEmail(body = {}) {
  const dest = body.Destination ?? {};
  const to = asArray(dest.ToAddresses ?? body.to ?? []);
  const cc = asArray(dest.CcAddresses ?? body.cc ?? []);
  const bcc = asArray(dest.BccAddresses ?? body.bcc ?? []);
  if (to.length + cc.length + bcc.length === 0) {
    badRequest("Missing destination (Destination.ToAddresses)");
  }
  const simple = sesSimpleContent(body.Content);
  return normalizeRest({
    to,
    cc,
    bcc,
    from: body.FromEmailAddress ?? body.from ?? "",
    subject: simple.subject || body.subject || "",
    html: simple.html ?? body.html ?? null,
    text: simple.text ?? body.text ?? null,
    replyTo: body.ReplyToAddresses?.[0] ?? body.replyTo ?? null,
    tags: emailTags(body.EmailTags, "EmailTags"),
    metadata: body.metadata ?? {},
  });
}

/** SESv2 SendBulkEmail (JSON) -> array of canonical payloads. */
export function parseSendBulkEmail(body = {}) {
  const entries = body.BulkEmailEntries ?? [];
  if (!Array.isArray(entries) || entries.length === 0) {
    badRequest("BulkEmailEntries is empty");
  }
  const defaultContent = sesSimpleContent(body.DefaultContent);
  const defaultTags = emailTags(body.DefaultEmailTags, "DefaultEmailTags");
  return entries.map((en, i) => {
    if (!en || typeof en !== "object") badRequest(`BulkEmailEntries[${i}] must be an object with Destination`);
    const dest = en.Destination ?? {};
    const to = asArray(dest.ToAddresses ?? []);
    const cc = asArray(dest.CcAddresses ?? []);
    const bcc = asArray(dest.BccAddresses ?? []);
    if (to.length + cc.length + bcc.length === 0) {
      badRequest(`BulkEmailEntries[${i}] has no destination`);
    }
    const replacement = sesSimpleContent(en.ReplacementEmailContent);
    return normalizeRest({
      to,
      cc,
      bcc,
      from: body.FromEmailAddress ?? "",
      subject: replacement.subject || defaultContent.subject,
      html: replacement.html ?? defaultContent.html,
      text: replacement.text ?? defaultContent.text,
      replyTo: body.ReplyToAddresses?.[0] ?? null,
      tags: defaultTags,
      metadata: {},
    });
  });
}
