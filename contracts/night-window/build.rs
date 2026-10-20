//! Sizes the WASM stack, and locates the contract's own release WASM for the
//! upgrade test and the real-time profile.
//!
//! The upgrade test uploads the bytes that `stellar contract build` produced
//! and switches a live contract to them. When the file exists, this script
//! exposes its path to the tests (`NIGHT_WINDOW_WASM`) and sets the
//! `night_window_wasm` cfg; when it does not, the test module stops the
//! compilation with a message asking for `stellar contract build` first.

use std::path::PathBuf;

const WASM: &str = "wasm32v1-none/release/night_window.wasm";

/// Stack of the WASM, in bytes. The linker default is 1 MiB, and every
/// invocation allocates the whole linear memory: 17 pages, about 123,000
/// metered instructions and 1 MB of memory per call before any work is
/// done. The whole test suite, run against the WASM, passes with a 2 KiB
/// stack and fails with 1 KiB (src/test_perf.rs explains the measure):
/// 64 KiB keeps a margin above 30 and needs 2 pages. The stack sits first in
/// linear memory, below the data: an overflow traps, it never overwrites
/// data, like a stack guard on an embedded target.
const STACK_BYTES: u32 = 64 * 1024;

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-env-changed=CARGO_TARGET_DIR");
    println!("cargo::rustc-check-cfg=cfg(night_window_wasm)");

    // A linker argument, not a rustflag: `stellar contract build` passes its
    // own rustflags (path remapping), which a target rustflag would replace.
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo::rustc-link-arg-cdylib=-zstack-size={STACK_BYTES}");
    }

    let Some(target_dir) = target_dir() else {
        return;
    };
    let wasm = target_dir.join(WASM);
    // A missing path makes Cargo rerun the script on every build, so the
    // cfg appears as soon as the WASM is built.
    println!("cargo::rerun-if-changed={}", wasm.display());
    if wasm.is_file() {
        println!("cargo::rustc-cfg=night_window_wasm");
        println!("cargo::rustc-env=NIGHT_WINDOW_WASM={}", wasm.display());
    }
}

/// The workspace target directory, as `stellar contract build` resolves it:
/// `CARGO_TARGET_DIR` when set, otherwise `<workspace>/target`.
fn target_dir() -> Option<PathBuf> {
    if let Some(dir) = std::env::var_os("CARGO_TARGET_DIR") {
        let dir = PathBuf::from(dir);
        if dir.is_absolute() {
            return Some(dir);
        }
    }
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR")?);
    Some(manifest.parent()?.parent()?.join("target"))
}
