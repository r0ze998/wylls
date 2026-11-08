// A child process for acts-runexec.test.mjs: ④'s REAL act registry through ④'s own client (runexec act …).
// argv: <clientPath> <bin> <db> <mode> <agentId> <count> [gatewayPort]. One JSON line. No key, nothing sent.
import { loadFourActsPort } from '../../src/acts-port.mjs';

const [clientPath, bin, db, mode, agentId, count, port] = process.argv.slice(2);
const acts = await loadFourActsPort({ clientPath, bin, db, gatewayPort: port ? Number(port) : null });
const ids = [], errors = [];
for (let i = 0; i < Number(count); i++) {
  try {
    const r = mode === 'register'
      ? await acts.register({ agentId, key: `ai:p05.mp${i}`, source: 'ai', runId: `p05-autopilot:${agentId}` })
      : await acts.status({ agentId, key: `ai:p05.mp${i}` });
    ids.push(r.run4Id);
  } catch (e) { errors.push(e.code ?? String(e)); }
}
process.stdout.write(JSON.stringify({ pid: process.pid, ids, errors }) + '\n');
