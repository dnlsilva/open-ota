import type { AppConfig } from "../config.js";

export interface EmailMessage {
  to: string;
  subject: string;
  text: string;
}

export interface EmailSender {
  send(message: EmailMessage): Promise<void>;
}

export function createEmailSender(config: AppConfig): EmailSender {
  if (config.EMAIL_DRIVER === "resend" && config.RESEND_API_KEY) {
    return {
      async send(message) {
        const res = await fetch("https://api.resend.com/emails", {
          method: "POST",
          headers: {
            authorization: `Bearer ${config.RESEND_API_KEY}`,
            "content-type": "application/json",
          },
          body: JSON.stringify({
            from: config.EMAIL_FROM,
            to: message.to,
            subject: message.subject,
            text: message.text,
          }),
        });
        if (!res.ok) throw new Error(`Resend rejected the message: ${res.status}`);
      },
    };
  }

  // Self-hosted default: print it. A single-admin install verifies its own
  // address from the server log rather than requiring an SMTP setup on day one.
  return {
    async send(message) {
      console.info(`[email] to=${message.to} subject=${message.subject}\n${message.text}`);
    },
  };
}
