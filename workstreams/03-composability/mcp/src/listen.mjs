// Starts the HTTP server and settles once it is listening or could not start (src/http.mjs re-exports it).
// Pure Node: imports node:http only, binds only when called.
//
// (2026-11-17) Before, the promise resolved on `listening` only: a start-up `error` (EADDRINUSE, EACCES, …) left it
// pending and went to the server as an 'error' event with no listener — thrown as an uncaught exception, so a caller
// awaiting listen() (bin/wylls-mcp.mjs, e2e/local-stack.mjs, test/fixture.mjs) never saw it and its own clean-up did not
// run. Now the start-up error rejects with the error itself; a synchronous throw from server.listen (a bad port)
// rejects the same way. Both one-shot listeners are removed on either outcome, so after a successful start an 'error'
// reaches whatever the caller attaches (or is uncaught, as before) — never swallowed here. No retry, no other port, no
// other host: the port and host are the caller's.
import http from 'node:http';

/**
 * @param {Function} handler  the request handler
 * @param {{port?: number, host?: string, createServer?: Function}} [o]  `createServer` (default http.createServer) only
 *   lets a test hand in a server-shaped object without binding a port
 * @returns {Promise<import('node:http').Server>}
 */
export function listen(handler, { port = 0, host = '127.0.0.1', createServer = http.createServer } = {}) {
  return new Promise((resolve, reject) => {
    const s = createServer(handler);
    const done = () => { s.off('error', onError); s.off('listening', onListening); };
    function onError(e) { done(); reject(e); }
    function onListening() { done(); resolve(s); }
    s.once('error', onError);
    s.once('listening', onListening);
    try { s.listen(port, host); } catch (e) { done(); reject(e); }
  });
}
