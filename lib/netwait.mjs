// netwait.mjs — wait until the API host is reachable before launching claude. Fixes the
// "machine just woke up, DNS not ready" morning failures. exit 0 = reachable, 1 = gave up.
import { connect } from 'node:net';
import { findRoot, loadConfig } from './paths.mjs';

export function probe(host, port, timeoutMs) {
  return new Promise(resolve => {
    const s = connect({ host, port });
    const done = ok => { try { s.destroy(); } catch { } resolve(ok); };
    s.setTimeout(timeoutMs, () => done(false));
    s.once('connect', () => done(true));
    s.once('error', () => done(false));
  });
}

export async function wait(root = findRoot(), override = {}) {
  const n = { ...loadConfig(root).net, ...override };
  for (let i = 0; i < n.tries; i++) {
    if (await probe(n.host, n.port, n.connectMs)) return { ok: true, tries: i + 1 };
    if (i < n.tries - 1) await new Promise(r => setTimeout(r, n.waitMs));
  }
  return { ok: false, tries: n.tries };
}

export async function main() {
  const r = await wait();
  console.log(r.ok ? `network OK after ${r.tries} probe(s)` : `network unreachable after ${r.tries} probes`);
  return r.ok ? 0 : 1;
}
