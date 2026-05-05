/**
 * Email-sending helper. Tries the configured provider in order and falls back
 * to console logging so the app stays usable in dev / when no provider is set.
 *
 * Configuration via environment variables:
 *
 *   RESEND_API_KEY      – api key for Resend (https://resend.com)
 *   EMAIL_FROM          – sender address (e.g. "JimmyQrg Chat <noreply@…>")
 *                         If omitted, falls back to "noreply@${EMAIL_DOMAIN}"
 *                         then "noreply@example.com".
 *   EMAIL_DOMAIN        – domain part used to build the default sender.
 *   PUBLIC_BASE_URL     – absolute URL the client uses (e.g. https://jchat.fly.dev)
 *                         used when building reset links inside emails.
 *
 *   Optional SMTP fallback (uses native net/tls — no extra dependency):
 *   SMTP_HOST, SMTP_PORT (default 587), SMTP_USER, SMTP_PASSWORD, SMTP_SECURE ('1' for implicit TLS)
 *
 * If neither is configured the email body is logged so jimmyqrg can copy/paste
 * the link to the user manually during the rollout window.
 */

import net from 'node:net';
import tls from 'node:tls';

function defaultFrom() {
  if (process.env.EMAIL_FROM) return process.env.EMAIL_FROM;
  if (process.env.EMAIL_DOMAIN) return `noreply@${process.env.EMAIL_DOMAIN}`;
  return 'noreply@example.com';
}

export function getPublicBaseUrl(req = null) {
  if (process.env.PUBLIC_BASE_URL) return process.env.PUBLIC_BASE_URL.replace(/\/$/, '');
  if (req) {
    const proto = req.headers['x-forwarded-proto'] || req.protocol || 'https';
    const host = req.headers['x-forwarded-host'] || req.headers.host;
    if (host) return `${proto}://${host}`.replace(/\/$/, '');
  }
  return '';
}

/** Send an email. Returns { ok: boolean, provider: string, error?: string }. */
export async function sendEmail({ to, subject, html, text, from }) {
  if (!to) return { ok: false, provider: 'none', error: 'no_recipient' };
  const sender = from || defaultFrom();
  const plain = text || stripHtml(html || '');

  if (process.env.RESEND_API_KEY) {
    try {
      const resp = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.RESEND_API_KEY}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: sender,
          to: [to],
          subject: subject || '(no subject)',
          html: html || `<pre>${escapeHtml(plain)}</pre>`,
          text: plain,
        }),
      });
      if (!resp.ok) {
        const body = await resp.text().catch(() => '');
        console.error('[email] Resend error', resp.status, body);
        return { ok: false, provider: 'resend', error: `resend_${resp.status}` };
      }
      return { ok: true, provider: 'resend' };
    } catch (err) {
      console.error('[email] Resend network error:', err?.message || err);
      return { ok: false, provider: 'resend', error: 'network_error' };
    }
  }

  if (process.env.SMTP_HOST) {
    try {
      await sendViaSmtp({ to, from: sender, subject, html, text: plain });
      return { ok: true, provider: 'smtp' };
    } catch (err) {
      console.error('[email] SMTP send failed:', err?.message || err);
      return { ok: false, provider: 'smtp', error: err?.message || 'smtp_error' };
    }
  }

  // No provider configured – log a structured warning so jimmyqrg can grab the
  // link from the Fly logs and forward it manually until DNS / Resend is set up.
  console.warn('[email] No provider configured – falling back to log.');
  console.warn(`[email] From: ${sender}`);
  console.warn(`[email] To: ${to}`);
  console.warn(`[email] Subject: ${subject}`);
  console.warn(`[email] Body:\n${plain}`);
  return { ok: false, provider: 'log', error: 'no_provider' };
}

/** Minimal SMTP client. Supports STARTTLS (port 587) and implicit TLS (port 465).
 *  Only the subset of SMTP we need; not a general purpose mailer. */
function sendViaSmtp({ to, from, subject, html, text }) {
  return new Promise((resolve, reject) => {
    const host = process.env.SMTP_HOST;
    const port = parseInt(process.env.SMTP_PORT || '587', 10);
    const user = process.env.SMTP_USER;
    const pass = process.env.SMTP_PASSWORD;
    const useImplicitTls = process.env.SMTP_SECURE === '1' || port === 465;

    const fromAddr = parseAddr(from);
    const toAddr = parseAddr(to);
    if (!fromAddr || !toAddr) return reject(new Error('Bad from/to address'));

    const messageId = `<${Date.now()}.${Math.random().toString(36).slice(2)}@${(fromAddr.split('@')[1] || 'localhost')}>`;
    const boundary = `=_${Math.random().toString(36).slice(2)}`;
    const body = buildMimeBody({ from, to, subject, html, text, messageId, boundary });

    let socket = useImplicitTls
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port });

    let buffer = '';
    let upgradedToTls = useImplicitTls;
    const queue = [];
    let phase = 0;
    let done = false;

    const fail = (err) => { if (!done) { done = true; try { socket.destroy(); } catch (_) {} reject(err); } };
    const finish = () => { if (!done) { done = true; try { socket.end(); } catch (_) {} resolve(); } };

    const expect = (codePrefix, then) => queue.push({ codePrefix, then });

    const send = (line) => socket.write(line + '\r\n');

    socket.setTimeout(15000, () => fail(new Error('SMTP timeout')));
    socket.on('error', fail);

    const onLine = (line) => {
      const codeMatch = line.match(/^(\d{3})([- ])/);
      if (!codeMatch) return;
      const code = codeMatch[1];
      const isFinal = codeMatch[2] === ' ';
      if (!isFinal) return;
      if (queue.length === 0) return;
      const step = queue.shift();
      if (!step.codePrefix.test(code)) return fail(new Error(`SMTP error: ${line}`));
      try { step.then(); } catch (err) { fail(err); }
    };

    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      let idx;
      while ((idx = buffer.indexOf('\r\n')) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        onLine(line);
      }
    });

    expect(/^2/, () => {
      send(`EHLO ${process.env.EMAIL_DOMAIN || 'localhost'}`);
      expect(/^2/, () => {
        if (!upgradedToTls) {
          send('STARTTLS');
          expect(/^2/, () => {
            const upgraded = tls.connect({ socket, host, servername: host }, () => {
              upgradedToTls = true;
              socket = upgraded;
              socket.on('data', (chunk) => {
                buffer += chunk.toString('utf8');
                let idx2;
                while ((idx2 = buffer.indexOf('\r\n')) !== -1) {
                  const line = buffer.slice(0, idx2);
                  buffer = buffer.slice(idx2 + 2);
                  onLine(line);
                }
              });
              socket.on('error', fail);
              const sendU = (line) => socket.write(line + '\r\n');
              sendU(`EHLO ${process.env.EMAIL_DOMAIN || 'localhost'}`);
              expect(/^2/, () => doAuthAndSend(sendU));
            });
          });
        } else {
          doAuthAndSend(send);
        }
      });
    });

    function doAuthAndSend(write) {
      if (user && pass) {
        write('AUTH LOGIN');
        expect(/^3/, () => {
          write(Buffer.from(user).toString('base64'));
          expect(/^3/, () => {
            write(Buffer.from(pass).toString('base64'));
            expect(/^2/, () => sendMail(write));
          });
        });
      } else {
        sendMail(write);
      }
    }

    function sendMail(write) {
      write(`MAIL FROM:<${fromAddr}>`);
      expect(/^2/, () => {
        write(`RCPT TO:<${toAddr}>`);
        expect(/^2/, () => {
          write('DATA');
          expect(/^3/, () => {
            write(body);
            write('.');
            expect(/^2/, () => {
              write('QUIT');
              expect(/^2/, () => finish());
            });
          });
        });
      });
    }
  });
}

function buildMimeBody({ from, to, subject, html, text, messageId, boundary }) {
  const headers = [
    `From: ${from}`,
    `To: ${to}`,
    `Subject: ${subject}`,
    `Message-ID: ${messageId}`,
    `Date: ${new Date().toUTCString()}`,
    `MIME-Version: 1.0`,
  ];
  if (html && text) {
    headers.push(`Content-Type: multipart/alternative; boundary="${boundary}"`);
    return [
      headers.join('\r\n'),
      '',
      `--${boundary}`,
      'Content-Type: text/plain; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      text,
      `--${boundary}`,
      'Content-Type: text/html; charset=utf-8',
      'Content-Transfer-Encoding: 7bit',
      '',
      html,
      `--${boundary}--`,
    ].join('\r\n');
  }
  if (html) {
    headers.push('Content-Type: text/html; charset=utf-8');
    return headers.join('\r\n') + '\r\n\r\n' + html;
  }
  headers.push('Content-Type: text/plain; charset=utf-8');
  return headers.join('\r\n') + '\r\n\r\n' + (text || '');
}

function parseAddr(str) {
  if (!str) return null;
  const m = String(str).match(/<([^>]+)>/);
  if (m) return m[1].trim();
  return String(str).trim();
}

function stripHtml(html) {
  return String(html || '').replace(/<style[\s\S]*?<\/style>/gi, '').replace(/<[^>]+>/g, '').replace(/\s+\n/g, '\n').trim();
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

export function buildResetEmail({ displayName, resetUrl, expiresMinutes }) {
  const greeting = displayName ? `Hi ${displayName},` : 'Hi,';
  const linkLine = `${resetUrl}`;
  const text = [
    greeting,
    '',
    'A password reset was requested for your JimmyQrg Chat account.',
    `If this was you, open the link below to choose a new password (it expires in ${expiresMinutes} minutes):`,
    '',
    linkLine,
    '',
    'If you did not request this, you can safely ignore this email — your account stays unchanged.',
    '',
    '— JimmyQrg Chat',
  ].join('\n');
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;max-width:480px;margin:0 auto;padding:24px;color:#1f2937;">
      <h2 style="margin:0 0 16px;font-size:20px;">Reset your JimmyQrg Chat password</h2>
      <p>${escapeHtml(greeting)}</p>
      <p>A password reset was requested for your account. If this was you, click the button below to set a new password. The link expires in <strong>${expiresMinutes} minutes</strong>.</p>
      <p style="margin:24px 0;text-align:center;">
        <a href="${escapeHtml(resetUrl)}" style="display:inline-block;padding:12px 20px;background:#7c3aed;color:#fff;text-decoration:none;border-radius:8px;font-weight:600;">Reset password</a>
      </p>
      <p style="font-size:13px;color:#4b5563;">Or paste this link into your browser:</p>
      <p style="font-size:13px;word-break:break-all;color:#4b5563;"><a href="${escapeHtml(resetUrl)}" style="color:#7c3aed;">${escapeHtml(resetUrl)}</a></p>
      <hr style="border:none;border-top:1px solid #e5e7eb;margin:24px 0;" />
      <p style="font-size:12px;color:#6b7280;">If you did not request this reset you can ignore this email — your account stays unchanged.</p>
      <p style="font-size:12px;color:#6b7280;">— JimmyQrg Chat</p>
    </div>`;
  return { html, text };
}
