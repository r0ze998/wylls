//! MarchState (MC contract §5.2.6; new in ABI v2): `mc‖m i32, n i32`, 256 B,
//! chained (entity kind 8, magic `PSF1MRCH`). Offsets:
//! `frontier_abi::v2::layout::world::march_state`; the seed:
//! `frontier_abi::v2::addr` (re-exported by [`crate::addr::v2`]).

pub use frontier_abi::v2::layout::world::march_state;
