// The program versions a local-play deployment may carry (one definition, read from the deployment, never a second
// literal in a module). `0x4804` is the conquest lane (S1 | wide 0x4000 | host-only dispatch 0x0800) and the
// default: a deployment that names it is served exactly as before. `0xC804` is the LOCAL TEST CANDIDATE
// `localnet-conquest-nft-sbf` (the conquest lane with NFT residents; candidate program id [0x4C; 32]; NOT an
// allocation, never deployable): only a launcher that selected the candidate writes it into the deployment, and the
// chain's Season must carry it too. The production version is undecided and is not here.
// (The same file is permutation-gateway/src/frontier/local-lane-versions.mjs and permutation-server/web/frontier/
// flocallanes.mjs; a test keeps the two equal.)
export const LOCAL_LANE_VERSIONS = Object.freeze({ conquest: 0x4804, conquestNftCandidate: 0xc804 });
export const CANDIDATE_FEATURE = 'localnet-conquest-nft-sbf';
const SERVED = new Set(Object.values(LOCAL_LANE_VERSIONS));
/** Whether `v` — a Season's version as the chain gives it, a NUMBER — is one local play serves (a string is not). */
export const servesLocalVersion = v => Number.isInteger(v) && SERVED.has(v);
/** Whether `s` — a deployment's `program_version`, the DECIMAL STRING the launcher records — is one local play serves. */
export const servesDeploymentVersion = s => typeof s === 'string' && /^[1-9]\d{0,4}$/.test(s) && SERVED.has(Number(s));
/** The programs local play runs: the conquest lane [0x45; 32] and the local test candidate [0x4C; 32] (base58). */
export const LOCAL_LANE_PROGRAMS = Object.freeze({ conquest: '5fQPsn8hoaVddFG26cWQ5QFdqxWtUPNaZ9zH2E6LYzFn', conquestNftCandidate: '68qTstPmwfaDbt1a9hnq7XeyZ4zJBqBKU1esRtQXnKWj' });
/** Whether `program` (base58) is one local play runs. */
export const servesLocalProgram = p => p === LOCAL_LANE_PROGRAMS.conquest || p === LOCAL_LANE_PROGRAMS.conquestNftCandidate;
/** Whether `program` and version `v` (a Season's NUMBER, or a deployment's decimal STRING) are one local lane, as an
 *  EXACT pair: the conquest lane [0x45; 32] with 0x4804 only (exactly as before), the local test candidate [0x4C; 32]
 *  with 0xC804 only. Any other mix — the candidate's version under the conquest id, or the conquest version under the
 *  candidate's id — is refused. */
export function servesLocalLane(program, v) {
  const n = typeof v === 'string' ? (servesDeploymentVersion(v) ? Number(v) : null) : (servesLocalVersion(v) ? v : null);
  return (program === LOCAL_LANE_PROGRAMS.conquest && n === LOCAL_LANE_VERSIONS.conquest)
    || (program === LOCAL_LANE_PROGRAMS.conquestNftCandidate && n === LOCAL_LANE_VERSIONS.conquestNftCandidate);
}
/** Whether `program` is the local test candidate's id. */
export const isCandidateProgram = p => p === LOCAL_LANE_PROGRAMS.conquestNftCandidate;
/** Whether a Season version (number) or a deployment version (string) is the local test candidate's (0xC804). */
export const isCandidateVersion = v => (typeof v === 'string' ? servesDeploymentVersion(v) : servesLocalVersion(v)) && Number(v) === LOCAL_LANE_VERSIONS.conquestNftCandidate;
