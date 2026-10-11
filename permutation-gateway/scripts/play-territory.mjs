// Isolated development world. No chain, payment or external wallet is used.
// State survives browser reloads while this process is running.
import { startServer } from '../screens/server.mjs';

const port = Number(process.env.WYLLS_TERRITORY_PORT ?? 42047);
const srv = await startServer({ port, bootstrap: true });
srv.stage('none');
srv.live(true, { opening: true, territory: true, turn: 20, delay: 12 });
console.log(`Wylls territory development world: ${srv.url}/start`);
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, async () => { await srv.close(); process.exit(0); });
