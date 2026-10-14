default: build

all: lint test

# Same gates as CI (.github/workflows/ci.yml).
lint:
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
