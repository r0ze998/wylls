// ⑳ The NFT pass mint page a local NFT world links to from the game's join screen (`--mint-url`).
// Local test worlds only: the link exists on localnet and points at a loopback http page (the mint
// page frontier-stack `up --nft-pass` starts on the same chain). A public mint page, its host and its
// terms are undecided and are not configured here.
const LOOPBACK_HOSTS = new Set(['127.0.0.1', 'localhost', '[::1]']);

/** The problem with `url` as this relay's mint page link, or null (also null when unset). */
export function mintUrlProblem(url, cluster) {
  if (url === null || url === undefined || url === '') return null;
  let u;
  try { u = new URL(url); } catch { return `--mint-url ${url}: not a URL`; }
  if (cluster !== 'localnet') return '--mint-url: the mint page link exists on localnet test worlds only (a public mint page is undecided)';
  if (u.protocol !== 'http:' || !LOOPBACK_HOSTS.has(u.hostname)) return `--mint-url ${url}: a loopback http page only (127.0.0.1, localhost, [::1])`;
  if (u.username || u.password) return '--mint-url: no credentials in the link';
  return null;
}
