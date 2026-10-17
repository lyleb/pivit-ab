const assert = require('assert');
const { buildPayload, sendEmail, takeLastLoggedEmail, brandedHtml, DEFAULT_FROM, DEFAULT_REPLY_TO, LOGO_URL, LOGO_WIDTH, LOGO_HEIGHT } = require('../src/mailer');

async function main() {
  delete process.env.POSTMARK_SERVER_TOKEN;
  delete process.env.POSTMARK_STREAM;
  delete process.env.EMAIL_FROM;
  delete process.env.EMAIL_REPLY_TO;
  takeLastLoggedEmail();

  const text = [
    'Hello,',
    '',
    'Use this link to sign in to pivitlab. It works once and expires in 15 minutes.',
    '',
    'https://pivitlab.com/sign-in.html?token=abc',
    '',
    'Or type this code on the sign-in page: 123456',
    '',
    'Name: <script>alert("x")</script> & "quotes"',
    '',
    'If you did not ask for this, you can ignore this email.',
    '',
    'pivitlab',
  ].join('\n');
  const payload = buildPayload({
    to: 'person@example.co.uk',
    subject: 'Hello',
    text,
    tag: 'login-link',
    buttonLabel: 'Sign in',
    href: 'https://pivitlab.com/sign-in.html?token=abc',
  });
  assert.strictEqual(payload.From, DEFAULT_FROM);
  assert.strictEqual(payload.From, '"pivitlab" <no-reply@pivitlab.com>');
  assert.strictEqual(payload.ReplyTo, DEFAULT_REPLY_TO);
  assert.strictEqual(payload.TextBody, text);
  assert.strictEqual(payload.MessageStream, 'outbound');
  assert.strictEqual(payload.Tag, 'login-link');
  assert.ok(payload.HtmlBody.includes('pivitlab'));
  assert.ok(payload.HtmlBody.includes(`src="${LOGO_URL}"`));
  assert.strictEqual(LOGO_URL, 'https://pivitlab.com/assets/logo.png');
  assert.ok(payload.HtmlBody.includes('alt="pivitlab"'));
  assert.ok(payload.HtmlBody.includes(`width="${LOGO_WIDTH}"`));
  assert.ok(payload.HtmlBody.includes(`height="${LOGO_HEIGHT}"`));
  assert.ok(LOGO_WIDTH >= 120 && LOGO_WIDTH <= 160);
  assert.ok(!payload.HtmlBody.includes('letter-spacing:-0.02em'));
  assert.ok(payload.HtmlBody.includes('>Sign in<'));
  assert.ok(payload.HtmlBody.includes('lang="en-GB"'));
  assert.ok(payload.HtmlBody.includes('&lt;script&gt;'));
  assert.ok(payload.HtmlBody.includes('&amp;'));
  assert.ok(payload.HtmlBody.includes('&quot;quotes&quot;'));
  assert.ok(!payload.HtmlBody.includes('<script>'));
  assert.ok(!payload.HtmlBody.includes('Pivitlab'));
  assert.strictEqual(payload.Headers, undefined);
  assert.ok(!JSON.stringify(payload).toLowerCase().includes('list-unsubscribe'));

  process.env.POSTMARK_STREAM = '  broadcast  ';
  const streamed = buildPayload({
    to: 'person@example.co.uk',
    subject: 'Hello',
    text: 'Plain text.',
    tag: 'Agency-Invite',
  });
  assert.strictEqual(streamed.MessageStream, 'broadcast');
  assert.strictEqual(streamed.Tag, 'agency-invite');
  assert.ok(streamed.HtmlBody.includes('Plain text.'));
  assert.ok(streamed.HtmlBody.includes('pivitlab'));
  delete process.env.POSTMARK_STREAM;

  process.env.POSTMARK_STREAM = '   ';
  const blankStream = buildPayload({ to: 'person@example.co.uk', subject: 'Hello', text: 'Plain text.', tag: 'login-link' });
  assert.strictEqual(blankStream.MessageStream, 'outbound');
  delete process.env.POSTMARK_STREAM;

  const untagged = buildPayload({ to: 'person@example.co.uk', subject: 'Hello', text: 'Plain text.' });
  assert.strictEqual(untagged.Tag, undefined);
  assert.ok(untagged.HtmlBody.includes('Plain text.'));

  process.env.EMAIL_FROM = 'news@pivitlab.com';
  process.env.EMAIL_REPLY_TO = 'hello@heclr.com';
  const custom = buildPayload({ to: 'person@example.co.uk', subject: 'Hello', text: 'Plain text.' });
  assert.strictEqual(custom.From, '"pivitlab" <news@pivitlab.com>');
  assert.strictEqual(custom.ReplyTo, 'hello@heclr.com');
  process.env.EMAIL_FROM = '"News" <news@pivitlab.com>';
  const named = buildPayload({ to: 'person@example.co.uk', subject: 'Hello', text: 'Plain text.' });
  assert.strictEqual(named.From, '"News" <news@pivitlab.com>');
  delete process.env.EMAIL_FROM;
  delete process.env.EMAIL_REPLY_TO;

  const invite = buildPayload({
    to: 'person@example.co.uk',
    subject: 'Join <North & "Wind"> on pivitlab',
    text: 'You have been invited to join <North & "Wind"> on pivitlab as a Member.\n\nhttps://pivitlab.com/join.html?token=a&b=1',
    tag: 'agency-invite',
    buttonLabel: 'Join <b>now</b>',
    href: 'https://pivitlab.com/join.html?token=a&b=1',
  });
  assert.strictEqual(invite.Tag, 'agency-invite');
  assert.ok(invite.HtmlBody.includes('&lt;North &amp; &quot;Wind&quot;&gt;'));
  assert.ok(invite.HtmlBody.includes('Join &lt;b&gt;now&lt;/b&gt;'));
  assert.ok(invite.HtmlBody.includes('href="https://pivitlab.com/join.html?token=a&amp;b=1"'));
  assert.ok(!invite.HtmlBody.includes('<North'));
  assert.ok(!invite.HtmlBody.includes('Join <b>'));

  const blocked = brandedHtml({
    paragraphs: ['Hello'],
    buttonLabel: 'Sign in',
    href: 'javascript:alert(1)',
  });
  assert.ok(blocked.includes('pivitlab'));
  assert.ok(!blocked.includes('javascript:'));
  assert.ok(!blocked.includes('>Sign in<'));

  const sent = await sendEmail({
    to: 'person@example.co.uk',
    subject: 'Your pivitlab sign-in link',
    text: 'Use this link.',
    tag: 'login-link',
    buttonLabel: 'Sign in',
    href: 'https://pivitlab.com/sign-in.html?token=abc',
  });
  assert.strictEqual(sent.sent, false);
  assert.strictEqual(sent.logged, true);
  assert.strictEqual(sent.message.from, '"pivitlab" <no-reply@pivitlab.com>');
  assert.strictEqual(sent.message.replyTo, 'info@heclr.com');
  assert.strictEqual(sent.message.to, 'person@example.co.uk');
  assert.strictEqual(sent.message.tag, 'login-link');
  assert.ok(sent.message.html.includes('>Sign in<'));
  assert.ok(!sent.message.html.toLowerCase().includes('list-unsubscribe'));
  const logged = takeLastLoggedEmail();
  assert.strictEqual(logged.replyTo, 'info@heclr.com');
  assert.strictEqual(logged.tag, 'login-link');
  assert.strictEqual(takeLastLoggedEmail(), null);

  console.log('mailer tests passed');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
