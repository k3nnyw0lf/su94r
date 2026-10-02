// The Windows pin helper (pin-helper/pin-helper.ps1) keeps a window above all others when
// its title ends in "(on top)" plus the helper's private code, written as invisible
// characters. Only the extension can read the code, so a web page cannot pin itself.

const HELPER_URL = 'http://127.0.0.1:47923/ping';

/** { up, suffix }: suffix is what to append to the title to be kept on top ('' when the helper is not running). */
export async function askHelper() {
  try {
    const r = await fetch(HELPER_URL, { cache: 'no-store', signal: AbortSignal.timeout(1500) });
    const j = r.ok ? await r.json() : {};
    if (j.app !== 'libre-mini-pin') return { up: false, suffix: '' };
    const code = typeof j.code === 'string' ? [...j.code].map((b) => (b === '1' ? '‌' : '​')).join('') : '';
    return { up: true, suffix: ` (on top)${code}` };
  } catch {
    return { up: false, suffix: '' };
  }
}
