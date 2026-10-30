//! Refusals, by layer (contract §5). The numbers start at 11_000 so they
//! never collide with `FrontierError` (1–61, 99), `CqError` (62–93) or the
//! workstream-03 courier (9001–9010).

/// Where a refusal comes from.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layer {
    /// Publication: the manifest itself is not acceptable.
    Static,
    /// Signature, grant, ownership.
    Auth,
    /// The registry: status, version, capacity.
    Registry,
    /// An effect refused while running (the whole call is undone).
    Exec,
}

macro_rules! errors {
    ($( $name:ident = $code:literal, $layer:ident; )*) => {
        #[derive(Clone, Copy, Debug, PartialEq, Eq)]
        pub enum ExtError { $( $name, )* }

        impl ExtError {
            pub const fn code(self) -> u32 {
                match self { $( ExtError::$name => $code, )* }
            }
            pub const fn layer(self) -> Layer {
                match self { $( ExtError::$name => Layer::$layer, )* }
            }
            pub const fn name(self) -> &'static str {
                match self { $( ExtError::$name => stringify!($name), )* }
            }
        }
    };
}

errors! {
    // Static (publication, `Manifest::decode` / `validate`).
    Malformed = 11_001, Static;
    TooLarge = 11_002, Static;
    UnknownSchema = 11_003, Static;
    UnknownEffectSet = 11_004, Static;
    UnknownOp = 11_005, Static;
    BadReference = 11_006, Static;
    BadBounds = 11_007, Static;
    TooManyOps = 11_008, Static;
    DuplicateEntry = 11_009, Static;
    // Auth.
    NotSigned = 11_101, Auth;
    NotOwner = 11_102, Auth;
    SessionExpired = 11_103, Auth;
    NoGrant = 11_104, Auth;
    GrantVersion = 11_105, Auth;
    GrantEntry = 11_106, Auth;
    GrantExpired = 11_107, Auth;
    GrantRevoked = 11_108, Auth;
    GrantCalls = 11_109, Auth;
    GrantCap = 11_110, Auth;
    // Registry.
    NotRegistered = 11_201, Registry;
    Paused = 11_202, Registry;
    Revoked = 11_203, Registry;
    CoreVersion = 11_204, Registry;
    InstanceCap = 11_205, Registry;
    SeqMismatch = 11_206, Registry;
    ExitNotOpen = 11_207, Registry;
    AlreadyRegistered = 11_208, Registry;
    NotAuthor = 11_209, Registry;
    InstanceClosed = 11_210, Registry;
    NothingToWithdraw = 11_211, Registry;
    // Chunked publication (buffer.rs).
    NoBuffer = 11_220, Registry;
    BufferExists = 11_221, Registry;
    OutOfBounds = 11_222, Registry;
    ChunkConflict = 11_223, Registry;
    Incomplete = 11_224, Registry;
    HashMismatch = 11_225, Registry;
    // Exec.
    NoEntry = 11_301, Exec;
    ArgCount = 11_302, Exec;
    ArgBounds = 11_303, Exec;
    RequireFailed = 11_304, Exec;
    FieldBounds = 11_305, Exec;
    Overflow = 11_306, Exec;
    Insufficient = 11_307, Exec;
    PayCap = 11_308, Exec;
    EscrowInsufficient = 11_309, Exec;
    TimeReversed = 11_310, Exec;
    NegativeAmount = 11_311, Exec;
}
