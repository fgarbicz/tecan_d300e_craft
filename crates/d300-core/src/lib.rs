//! Protocol engine of d300_designer: a Rust port of `src/xmltree.js`, `src/tdd.js`, `src/dispense.js`
//! and `src/ops.js` (clean-room re-implementation of the protocol designer of Tecan D300e Control 4.0.1).
//!
//! The JS engine is verified against files and a run report produced by the real software; this port
//! reproduces it exactly: byte-identical .tdd round-trips, and f64 arithmetic in the JS order of
//! operations, with JS number semantics (formatting ties, `Math.round`, `Number(text)`) in [`jsnum`].
//! Tests: `cargo test` (round-trips, the ported JS tests, the D3 run report, differential tests vs node).

pub mod dispense;
pub mod error;
pub mod jsnum;
pub mod ops;
pub mod tdd;
pub mod xmltree;

pub use error::{Error, Result};
