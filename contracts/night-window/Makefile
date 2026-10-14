default: build

all: lint test

# Same gates as CI (.github/workflows/ci.yml). The WASM is built first: the
# upgrade test uploads it, and `clippy --all-targets` compiles that test.
lint: build
	cargo fmt --all --check
	cargo clippy --all-targets -- -D warnings

test: build
	cargo test

build:
	stellar contract build
	@ls -l target/wasm32v1-none/release/*.wasm

# Dependency advisories (RustSec). Install once: cargo install cargo-audit --locked
audit:
	cargo audit

# Static analysis for Soroban contracts. Install once: cargo install cargo-scout-audit
scout:
	cargo scout-audit

fmt:
	cargo fmt --all

clean:
	cargo clean
