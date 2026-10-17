// Transactional email via the Postmark HTTPS API. Railway Hobby blocks SMTP.
// With no POSTMARK_SERVER_TOKEN the message is logged and not sent, so local
// development and tests can read the sign-in link. Reply-To defaults to
// info@heclr.com. pivitlab.com can receive mail. These messages are
// transactional, so the payload never sets List-Unsubscribe.

const DEFAULT_FROM_ADDRESS = 'no-reply@pivitlab.com';
const DEFAULT_FROM_NAME = 'pivitlab';
const DEFAULT_FROM = `"${DEFAULT_FROM_NAME}" <${DEFAULT_FROM_ADDRESS}>`;
const DEFAULT_REPLY_TO = 'info@heclr.com';
const DEFAULT_STREAM = 'outbound';

let lastLogged = null;

function fromAddress() {
  const raw = String(process.env.EMAIL_FROM || '').replace(/[\r\n]+/g, '').trim();
  if (!raw) return DEFAULT_FROM;
  if (raw.includes('<')) return raw;
  return `"${DEFAULT_FROM_NAME}" <${raw}>`;
}

function replyToAddress() {
  const raw = String(process.env.EMAIL_REPLY_TO || '').trim();
  return raw || DEFAULT_REPLY_TO;
}

function messageStream() {
  const raw = String(process.env.POSTMARK_STREAM || '').trim();
  return raw || DEFAULT_STREAM;
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function safeHref(href) {
  const value = String(href || '').trim();
  if (!/^https?:\/\//i.test(value)) return '';
  if (/[\u0000-\u001f\s]/.test(value)) return '';
  return value;
}

function cleanTag(tag) {
  const value = String(tag || '').trim().toLowerCase();
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(value)) return '';
  return value.slice(0, 50);
}

function paragraphsFromText(text, href) {
  return String(text || '')
    .split(/\n{2,}/)
    .map((part) => part.trim())
    .filter((part) => part && part !== 'pivitlab' && part !== href);
}

// Shared HTML for sign-in and invite mail, and for the other transactional
// messages. Every interpolated value is escaped. The button is only an
// http or https link.
function brandedHtml({ paragraphs, buttonLabel, href }) {
  const link = safeHref(href);
  const label = String(buttonLabel || '').trim() || (link ? 'Open this link' : '');
  const blocks = (paragraphs || [])
    .map((part) => String(part || '').trim())
    .filter((part) => part && part !== 'pivitlab' && (!link || part !== link))
    .map((part) => (
      `<p style="margin:0 0 16px;font-size:16px;line-height:1.5;color:#1a1d27;">${escapeHtml(part).replace(/\n/g, '<br>')}</p>`
    ))
    .join('');
  const button = link
    ? `<p style="margin:24px 0;"><a href="${escapeHtml(link)}" style="display:inline-block;background:#5635FB;color:#ffffff;text-decoration:none;padding:12px 20px;border-radius:8px;font-size:16px;font-weight:700;">${escapeHtml(label)}</a></p>`
      + `<p style="margin:0 0 16px;font-size:14px;line-height:1.5;color:#5c6170;">Or copy this link:<br><a href="${escapeHtml(link)}" style="color:#4527d6;word-break:break-all;">${escapeHtml(link)}</a></p>`
    : '';
  return `<!DOCTYPE html>
<html lang="en-GB">
<body style="margin:0;padding:0;background:#f4f5f8;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f4f5f8;padding:32px 16px;">
    <tr><td align="center">
      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;background:#ffffff;border:1px solid #e4e6ee;border-radius:12px;padding:32px;">
        <tr><td style="font-family:-apple-system,'Segoe UI',Roboto,sans-serif;">
          <p style="margin:0 0 24px;font-size:20px;font-weight:700;letter-spacing:-0.02em;color:#5635FB;">pivitlab</p>
          ${blocks}
          ${button}
          <p style="margin:24px 0 0;font-size:14px;color:#5c6170;">pivitlab</p>
        </td></tr>
      </table>
    </td></tr>
  </table>
</body>
</html>`;
}

function buildPayload({ to, subject, text, html, tag, buttonLabel, href }) {
  const link = safeHref(href);
  const payload = {
    From: fromAddress(),
    To: to,
    ReplyTo: replyToAddress(),
    Subject: subject,
    TextBody: text,
    HtmlBody: html || brandedHtml({
      paragraphs: paragraphsFromText(text, link),
      buttonLabel,
      href: link,
    }),
    MessageStream: messageStream(),
  };
  const cleaned = cleanTag(tag);
  if (cleaned) payload.Tag = cleaned;
  return payload;
}

function takeLastLoggedEmail() {
  const message = lastLogged;
  lastLogged = null;
  return message;
}

async function sendEmail({ to, subject, text, html, tag, buttonLabel, href }) {
  const payload = buildPayload({ to, subject, text, html, tag, buttonLabel, href });
  const token = String(process.env.POSTMARK_SERVER_TOKEN || '').trim();
  if (!token) {
    lastLogged = {
      to: payload.To,
      from: payload.From,
      replyTo: payload.ReplyTo,
      subject: payload.Subject,
      text: payload.TextBody,
      html: payload.HtmlBody,
      tag: payload.Tag || '',
    };
    console.log(
      `[email] not sent (POSTMARK_SERVER_TOKEN is not set)\nFrom: ${payload.From}\nReply-To: ${payload.ReplyTo}\nTo: ${payload.To}\nSubject: ${payload.Subject}\nTag: ${payload.Tag || ''}\n\n${payload.TextBody}`
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
  DEFAULT_FROM_ADDRESS,
  DEFAULT_REPLY_TO,
  DEFAULT_STREAM,
  fromAddress,
  replyToAddress,
  messageStream,
  escapeHtml,
  brandedHtml,
  buildPayload,
  sendEmail,
  takeLastLoggedEmail,
};
