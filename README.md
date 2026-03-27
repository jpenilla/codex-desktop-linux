# Codex Desktop on Linux

This repo bootstraps the macOS Codex desktop bundle into a Linux Electron runtime.

Requirements:

- `bun`
- `curl`
- `7z`
- `codex` on `PATH`
- `rg` on `PATH`

Usage:

```sh
bun run install-codex-linux
./launch-codex-linux.sh
```

Linux launcher defaults:

- it checks for a newer Codex DMG on every launch and reuses the cached download unless the upstream URL or freshness metadata changed
- on Wayland, it prefers `--ozone-platform=x11` when XWayland is available
- it uses hardware GL by default
- `CODEX_LINUX_SOFTWARE_GL=1` switches back to the slower SwiftShader software fallback
- `CODEX_LINUX_WAYLAND_HINT=1` exports Electron's Wayland auto-detect hint when a Wayland socket is present
- it reapplies the repo's Linux patch level automatically and closes any old shim instance before relaunching
- override with `CODEX_LINUX_SOFTWARE_GL=1`, `CODEX_LINUX_WAYLAND_HINT=1`, and/or `CODEX_LINUX_OZONE_PLATFORM=wayland`

What the installer does:

- fetches the current Codex macOS DMG
- extracts `app.asar` and `app.asar.unpacked`
- installs Electron plus the matching `better-sqlite3` and `node-pty` versions with Bun
- rebuilds the native modules against the bundled Electron version
- injects `codex` and `rg` wrapper scripts into Electron's `resources/` directory
- patches the copied `app.asar` so Linux uses opaque window styling instead of the desktop app's translucent defaults

The launcher starts Electron as a packaged app by relying on `resources/app.asar`.
It does not pass `app.asar` as a positional CLI argument, because that makes Electron treat the app as unpackaged and Codex falls back to its dev server boot path.

All generated artifacts live under `.codex-linux/`.
