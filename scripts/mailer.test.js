const assert = require('assert');
const { buildPayload, sendEmail, takeLastLoggedEmail, DEFAULT_FROM, DEFAULT_REPLY_TO } = require('../src/mailer');

async function main() {
  delete process.env.POSTMARK_SERVER_TOKEN;
  delete process.env.EMAIL_FROM;
  delete process.env.EMAIL_REPLY_TO;
  takeLastLoggedEmail();

  const payload = buildPayload({ to: 'person@example.co.uk', subject: 'Hello', text: 'Plain text.' });
  assert.strictEqual(payload.From, DEFAULT_FROM);
  assert.strictEqual(payload.ReplyTo, DEFAULT_REPLY_TO);
  assert.strictEqual(payload.TextBody, 'Plain text.');
  assert.strictEqual(payload.MessageStream, 'outbound');
  assert.strictEqual(payload.HtmlBody, undefined);

  process.env.EMAIL_FROM = 'news@pivitlab.com';
  process.env.EMAIL_REPLY_TO = 'hello@heclr.com';
  const custom = buildPayload({ to: 'person@example.co.uk', subject: 'Hello', text: 'Plain text.' });
  assert.strictEqual(custom.From, 'news@pivitlab.com');
  assert.strictEqual(custom.ReplyTo, 'hello@heclr.com');
  delete process.env.EMAIL_FROM;
  delete process.env.EMAIL_REPLY_TO;

  const sent = await sendEmail({ to: 'person@example.co.uk', subject: 'Your pivitlab sign-in link', text: 'Use this link.' });
  assert.strictEqual(sent.sent, false);
  assert.strictEqual(sent.logged, true);
  assert.strictEqual(sent.message.from, 'no-reply@pivitlab.com');
  assert.strictEqual(sent.message.replyTo, 'info@heclr.com');
  assert.strictEqual(sent.message.to, 'person@example.co.uk');
  const logged = takeLastLoggedEmail();
  assert.strictEqual(logged.replyTo, 'info@heclr.com');
  assert.strictEqual(takeLastLoggedEmail(), null);

  console.log('mailer tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
