// su94r-webhook: GitHub events on su94r → a Telegram message.
//
// PAUSED: Telegram senders are off (the owner's order, 2026-09-04), and no GitHub repo points
// here any more (checked 2026-10-02). The bot token used to be written into this code; it now
// lives only in Worker secrets, and nothing is sent unless all three are set:
//   TELEGRAM_BOT_TOKEN      a NEW token from @BotFather (the old one was in the code: revoke it)
//   TELEGRAM_CHAT_ID        the chat to post to
//   GITHUB_WEBHOOK_SECRET   the secret set on the GitHub webhook; every request must carry
//                           GitHub's X-Hub-Signature-256 for it, so nobody else can post.

async function validSignature(raw, header, secret) {
  if (!header || !header.startsWith('sha256=')) return false;
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw)));
  const want = [...mac].map((b) => b.toString(16).padStart(2, '0')).join('');
  const got = header.slice(7);
  if (got.length !== want.length) return false;
  let diff = 0;
  for (let i = 0; i < want.length; i++) diff |= want.charCodeAt(i) ^ got.charCodeAt(i);
  return diff === 0;
}

function messageFor(event, body) {
  if (event === 'pull_request' && (body.action === 'opened' || body.action === 'reopened')) {
    const pr = body.pull_request;
    return `New PR on su94r #${pr.number}\nTitle: ${pr.title}\nBy: ${pr.user.login}\n${pr.html_url}\n\nReview and approve on GitHub.`;
  }
  if (event === 'push' && body.ref === 'refs/heads/main') {
    const commit = body.head_commit;
    return `su94r push to main\nBy: ${body.pusher.name}\nCommit: ${commit ? commit.message.split('\n')[0] : 'unknown'}`;
  }
  if (event === 'issues' && body.action === 'opened') {
    return `New issue on su94r #${body.issue.number}\nTitle: ${body.issue.title}\nBy: ${body.issue.user.login}\n${body.issue.html_url}`;
  }
  if (event === 'star' && body.action === 'created') {
    return `su94r got a star from ${body.sender.login}! Total: ${body.repository.stargazers_count}`;
  }
  return '';
}

export default {
  async fetch(request, env) {
    if (request.method !== 'POST') return new Response('su94r webhook (paused)', { status: 200 });
    if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID || !env.GITHUB_WEBHOOK_SECRET) return new Response('paused', { status: 202 });
    const raw = await request.text();
    if (!(await validSignature(raw, request.headers.get('X-Hub-Signature-256'), env.GITHUB_WEBHOOK_SECRET))) return new Response('bad signature', { status: 401 });
    let body;
    try { body = JSON.parse(raw); } catch { return new Response('bad request', { status: 400 }); }
    const message = messageFor(request.headers.get('X-GitHub-Event'), body);
    if (message) {
      await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/sendMessage`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message }),
      });
    }
    return new Response('ok', { status: 200 });
  },
};
