// Stable refusal codes (callers, tests and the contract match on them).
export const ERR = Object.freeze({
  // assets and holders
  NO_ACCOUNT: 'NoAccount', WRONG_PROGRAM: 'WrongProgram', NOT_AN_ASSET: 'NotAnAsset', MALFORMED: 'Malformed', NOT_IN_COLLECTION: 'NotInCollection', FROZEN: 'Frozen',
  NOT_HOLDER: 'NotHolder', OWNER_CHANGED: 'OwnerChanged', STALE_READ: 'StaleRead', CHAIN_UNAVAILABLE: 'ChainUnavailable', UNCONFIRMED: 'Unconfirmed',
  RESIDENT_ID_COLLISION: 'ResidentIdCollision', UNKNOWN_RESIDENT: 'UnknownResident',
  // auth
  BAD_SIGNATURE: 'BadSignature', BAD_MESSAGE: 'BadMessage', WRONG_DOMAIN: 'WrongDomain', NONCE_UNKNOWN: 'NonceUnknown', NONCE_USED: 'NonceUsed', EXPIRED: 'Expired', NOT_YET_VALID: 'NotYetValid',
  NOT_PUBLISHED: 'NotPublished', BAD_CREDENTIAL: 'BadCredential', CREDENTIAL_REVOKED: 'CredentialRevoked', SESSION_NOT_SET: 'SessionNotSet',
  // chain / program
  NOT_OWNER: 'NotOwner', ALREADY_PROCESSED: 'AlreadyProcessed', BLOCKHASH_EXPIRED: 'BlockhashExpired', AUTH: 'Auth', BAD_DATA: 'BadData',
  // entry desk
  PAYMENT_UNKNOWN: 'PaymentUnknown', PAYMENT_FAILED: 'PaymentFailed', IDEMPOTENCY_CONFLICT: 'IdempotencyConflict', MINT_UNKNOWN: 'MintUnknown', ALREADY_MINTED: 'AlreadyMinted',
  // world
  WRONG_RESIDENT: 'WrongResident', APPROVAL_VOID: 'ApprovalVoid', INSUFFICIENT: 'Insufficient',
  BAD_REQUEST: 'BadRequest',
});

export class Refusal extends Error {
  constructor(code, message, extra = {}) {
    super(message ?? code);
    this.code = code;
    this.extra = extra;
  }
  toJSON() { return { ok: false, code: this.code, message: this.message, ...this.extra }; }
}
export const refuse = (code, message, extra) => { throw new Refusal(code, message, extra); };
