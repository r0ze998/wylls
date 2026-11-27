//! keeper-test-seam: the engine's monotonic clock.
//!
//! Every send-pass timer reads [`now`], which is tokio's clock. Outside a
//! paused runtime tokio's `Instant::now()` is `std::time::Instant::now()`
//! (production: no change); a test under `#[tokio::test(start_paused =
//! true)]` (the `test-util` feature, a dev-dependency only) moves it with
//! `tokio::time::advance` / auto-advance instead of waiting in real time.
//! `care.rs` and `clusterfeed.rs` already use tokio's clock the same way.

pub use tokio::time::Instant;

/// Now on the keeper's monotonic clock.
pub fn now() -> Instant {
    Instant::now()
}
