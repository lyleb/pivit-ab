// Transactional email via the Postmark HTTPS API. Railway Hobby blocks SMTP.
// With no POSTMARK_SERVER_TOKEN the message is logged and not sent, so local
// development and tests can read the sign-in link. Every message sets Reply-To
// because pivitlab.com has a null MX and cannot receive mail.

const DEFAULT_FROM = 'no-reply@pivitlab.com';
const DEFAULT_REPLY_TO = 'info@heclr.com';

let lastLogged = null;

function fromAddress() {
  const raw = String(process.env.EMAIL_FROM || '').trim();
  return raw || DEFAULT_FROM;
}

function replyToAddress() {
  const raw = String(process.env.EMAIL_REPLY_TO || '').trim();
  return raw || DEFAULT_REPLY_TO;
}

function buildPayload({ to, subject, text }) {
  return {
    From: fromAddress(),
    To: to,
    ReplyTo: replyToAddress(),
    Subject: subject,
    TextBody: text,
    MessageStream: 'outbound',
  };
}

function takeLastLoggedEmail() {
  const message = lastLogged;
  lastLogged = null;
  return message;
}

async function sendEmail({ to, subject, text }) {
  const payload = buildPayload({ to, subject, text });
  const token = String(process.env.POSTMARK_SERVER_TOKEN || '').trim();
  if (!token) {
    lastLogged = {
      to: payload.To,
      from: payload.From,
      replyTo: payload.ReplyTo,
      subject: payload.Subject,
      text: payload.TextBody,
    };
    console.log(
      `[email] not sent (POSTMARK_SERVER_TOKEN is not set)\nFrom: ${payload.From}\nReply-To: ${payload.ReplyTo}\nTo: ${payload.To}\nSubject: ${payload.Subject}\n\n${payload.TextBody}`
    );
    return { sent: false, logged: true, message: lastLogged };
  }

  const response = await fetch('https://api.postmarkapp.com/email', {
    method: 'POST',
    headers: {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      'X-Postmark-Server-Token': token,
    },
    body: JSON.stringify(payload),
  });
  const body = await response.json().catch(() => ({}));
  if (!response.ok) {
    console.error('[email] Postmark rejected the message', response.status, body.ErrorCode, body.Message);
    return { sent: false, logged: false, error: true };
  }
  return { sent: true, logged: false, id: body.MessageID || null };
}

module.exports = {
  DEFAULT_FROM,
  DEFAULT_REPLY_TO,
  fromAddress,
  replyToAddress,
  buildPayload,
  sendEmail,
  takeLastLoggedEmail,
};
