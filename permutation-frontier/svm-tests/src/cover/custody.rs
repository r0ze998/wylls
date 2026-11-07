//! Coverage of the custody instructions (workstream 10, 0xC2–0xCC): none
//! yet. They run only in the `custody-preview` build (the S1 build refuses
//! the tags), which has not been built for SBF; their LiteSVM tests are
//! workstream 10's next step (`workstreams/10-custody/05-integration-review.ja.md`).
//! `Pending` keeps `RELEASE_CHECK=1` failing until they exist.

use super::Cover;

pub const PENDING: &[(&str, &str)] = &[];

pub const CUSTODY: &[Cover] = &[Cover::Pending(
    "workstream 10 (custody): LiteSVM tests of the custody-preview build",
)];
