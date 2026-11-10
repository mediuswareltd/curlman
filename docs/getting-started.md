# Getting started

Run **Curlman** on your machine.

## 1. Install

Download the installer from the [Releases](../../releases) page, or build it yourself
(see [Development](#development)).

Curlman uses the `curl` that's already on your system: `%SystemRoot%\System32\curl.exe`
on Windows 10 and later, or `curl` on your `PATH` on macOS and Linux. To use a different
binary, set the `CURLMAN_CURL` environment variable.

## 2. Usage

Paste a command and press **Enter**:

```bash
curl 'https://api.example.com/users' \
  -H 'Authorization: Bearer TOKEN' \
  -H 'Content-Type: application/json' \
  -d '{"name":"John"}'
```

Enter works like a shell. It sends the request, unless the text before the cursor ends
in a line continuation (`\` or `^`) or an open quote. In that case it adds a new line.

### Keyboard shortcuts

| Key | Action |
| --- | --- |
| `Enter` | Send (or add a new line inside a quote or after `\`) |
| `Ctrl/Cmd + Enter` | Send from anywhere |
| `Shift + Enter` | New line |
| `Esc` | Cancel the running request |
| `Ctrl + Space` | Show suggestions |
| `Tab` / `Enter` / `Up` / `Down` | Accept or move through suggestions |
| `Ctrl/Cmd + L` | Focus and select the command |
| `Ctrl/Cmd + Shift + F` | Format: toggle multi-line and one-line |
| `Ctrl/Cmd + B` | Toggle history |
| `Ctrl/Cmd + K` | Search history |
| `Ctrl/Cmd + N` | New request |
| `Ctrl/Cmd + 1` / `2` / `3` | Body / Headers / Timing |
| `Ctrl/Cmd + Shift + C` | Copy the response |

### What Curlman changes in your command

Curlman captures output itself, so it removes flags that would redirect or reshape it:
`-o`, `-O`, `-i`, `-v`, `-s`, `-S`, `-w`, `-D`, `-f`, `--trace` and similar. Every
other flag is passed to curl unchanged.

## 3. Development

Requirements: Node.js 22+, Rust, and the
[Tauri prerequisites](https://tauri.app/start/prerequisites/) for your platform.

```bash
npm install
npm run tauri dev     # desktop app with hot reload
npm run dev           # the same UI in a browser at http://localhost:1420
npm run tauri build   # release app and installer
```

In browser mode the Vite dev server runs curl for the page, so requests work the same
as in the desktop app. Opening `dist/index.html` on its own has no backend, and the app
says so.

Release output:

- App: `src-tauri/target/release/curlman.exe`
- Installer: `src-tauri/target/release/bundle/nsis/Curlman_<version>_x64-setup.exe`

## Next

- Full detail: [Guide](/guide)
- Source: [github.com/mediuswareltd/curlman](https://github.com/mediuswareltd/curlman)
