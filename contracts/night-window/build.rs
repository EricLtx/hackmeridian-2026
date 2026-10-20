//! Sizes the WASM stack, and locates the contract's own release WASM for the
//! upgrade test, the real-time profile and the WASM test mode.
//!
//! The upgrade test uploads the bytes that `stellar contract build` produced
//! and switches a live contract to them. When the file exists, this script
//! exposes its path to the tests (`NIGHT_WINDOW_WASM`) and sets the
//! `night_window_wasm` cfg; when it does not, the test module stops the
//! compilation with a message asking for `stellar contract build` first.
//!
//! WASM test mode: when the tests are built with `NIGHT_WINDOW_TEST_WASM=1`
//! and the release WASM exists, this script also sets the
//! `night_window_test_wasm` cfg, and every test registers that WASM in place
//! of the natively compiled contract. The whole suite then runs in the VM,
//! on the stack the WASM was linked with. The CI job `wasm-canary` does so
//! with a WASM linked with an 8 KiB stack, in a target directory of its own
//! so that `target/` keeps the shipped WASM:
//!
//! ```text
//! export CARGO_TARGET_DIR=$PWD/target-canary NIGHT_WINDOW_STACK_SIZE=8192
//! stellar contract build
//! NIGHT_WINDOW_TEST_WASM=1 cargo test -p night-window
//! ```

use std::path::PathBuf;

const WASM: &str = "wasm32v1-none/release/night_window.wasm";

/// Stack of the WASM, in bytes, unless `NIGHT_WINDOW_STACK_SIZE` sets
/// another. Every invocation allocates the whole linear memory. With the
/// linker's default stack of 1 MiB the module starts with 17 pages, which
/// cost 139,698 metered instructions and 1,114,128 bytes of memory per call
/// before any work is done. With 64 KiB it starts with 2: the 15 pages saved
/// are 122,880 instructions and 983,040 bytes per call. The whole test
/// suite, run against the WASM in the WASM test mode, passes with a 2 KiB
/// stack and fails with 1 KiB: 64 KiB keeps a margin above 30. The stack
/// sits first in linear memory, below the data: an overflow traps, it never
/// overwrites data, like a stack guard on an embedded target.
const STACK_BYTES: u32 = 64 * 1024;

fn main() {
    println!("cargo::rerun-if-changed=build.rs");
    println!("cargo::rerun-if-env-changed=CARGO_TARGET_DIR");
    println!("cargo::rerun-if-env-changed=NIGHT_WINDOW_STACK_SIZE");
    println!("cargo::rerun-if-env-changed=NIGHT_WINDOW_TEST_WASM");
    println!("cargo::rustc-check-cfg=cfg(night_window_wasm)");
    println!("cargo::rustc-check-cfg=cfg(night_window_test_wasm)");

    let stack = match stack_bytes() {
        Ok(stack) => stack,
        Err(message) => {
            println!("cargo::error={message}");
            return;
        }
    };
    // The stack the tests expect the release WASM to be linked with.
    println!("cargo::rustc-env=NIGHT_WINDOW_STACK_BYTES={stack}");
    // A linker argument, not a rustflag: `stellar contract build` passes its
    // own rustflags (path remapping), which a target rustflag would replace.
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo::rustc-link-arg-cdylib=-zstack-size={stack}");
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
        if std::env::var_os("NIGHT_WINDOW_TEST_WASM").is_some_and(|mode| mode == "1") {
            println!("cargo::rustc-cfg=night_window_test_wasm");
        }
    }
}

/// The stack size: `NIGHT_WINDOW_STACK_SIZE` in bytes when set, a positive
/// multiple of 16 as the linker requires; `STACK_BYTES` otherwise.
fn stack_bytes() -> Result<u32, String> {
    let Some(value) = std::env::var_os("NIGHT_WINDOW_STACK_SIZE").filter(|v| !v.is_empty()) else {
        return Ok(STACK_BYTES);
    };
    value
        .to_str()
        .and_then(|text| text.trim().parse::<u32>().ok())
        .filter(|bytes| *bytes > 0 && bytes.is_multiple_of(16))
        .ok_or_else(|| {
            format!(
                "NIGHT_WINDOW_STACK_SIZE must be a number of bytes, a positive multiple of 16; got {value:?}"
            )
        })
}

/// The workspace target directory, as `stellar contract build` resolves it
/// when run from the workspace root: `CARGO_TARGET_DIR` when set, a relative
/// path read from that root, otherwise `<workspace>/target`.
fn target_dir() -> Option<PathBuf> {
    let manifest = PathBuf::from(std::env::var_os("CARGO_MANIFEST_DIR")?);
    let workspace = manifest.parent()?.parent()?;
    match std::env::var_os("CARGO_TARGET_DIR").filter(|dir| !dir.is_empty()) {
        // An absolute directory replaces the workspace root in the join.
        Some(dir) => Some(workspace.join(dir)),
        None => Some(workspace.join("target")),
    }
}
