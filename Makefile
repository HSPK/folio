.PHONY: app windows core web test install clean

app:
	zsh ./apps/macos/Scripts/build.sh

windows:
	pwsh -NoProfile -File ./apps/windows/Scripts/build.ps1

core:
	cargo build --locked --release -p folio-cli --target-dir build/rust

web:
	npm --prefix web ci
	npm --prefix web run build

test:
	cargo test --locked --workspace --target-dir build/rust
	npm --prefix web run check:lines
	npm --prefix web test

install: app
	mkdir -p "$(HOME)/Applications"
	rm -rf "$(HOME)/Applications/Folio.app"
	cp -R build/Folio.app "$(HOME)/Applications/Folio.app"

clean:
	rm -rf build
