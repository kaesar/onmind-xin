import { SMTPServer } from "smtp-server";
import { simpleParser } from "mailparser";
import { newMessageId, asArray } from "./ids.js";

/**
 * Inbound SMTP server (compatible with what XID sends to Mailpit).
 * Parses the MIME message and converts it to the canonical payload + save().
 */
export function startSmtp({ port = 1025, host = "0.0.0.0", store, onError = console.error }) {
  const server = new SMTPServer({
    disabledCommands: ["AUTH"],
    onData(stream, session, callback) {
      simpleParser(stream)
        .then(async (mail) => {
          try {
            const envelopeTo = asArray(session.envelope?.rcptTo?.map((r) => r.address));
            await store.save(
              {
                to: envelopeTo.length ? envelopeTo : asArray(mail.to?.value?.map((a) => a.address)),
                cc: asArray(mail.cc?.value?.flatMap((a) => a.address ?? [])),
                bcc: asArray(mail.bcc?.value?.flatMap((a) => a.address ?? [])),
                from: mail.from?.value?.[0]?.address || mail.from?.text || "",
                subject: mail.subject || "",
                html: typeof mail.html === "string" ? mail.html : mail.html || null,
                text: mail.text || null,
                replyTo: null,
                tags: [],
                metadata: { envelopeFrom: session.envelope?.mailFrom?.address || null },
                _source: "smtp",
              },
              newMessageId()
            );
            callback(null);
          } catch (e) {
            onError(e);
            callback(new Error("storage failed"));
          }
        })
        .catch((e) => {
          onError(e);
          callback(new Error("parse failed"));
        });
    },
  });
  server.on("error", onError);
  server.listen(port, host);
  return server;
}
