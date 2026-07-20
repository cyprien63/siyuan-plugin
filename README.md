<<<<<<< HEAD
# siyuan-plugin
=======
# GitHub Sync Plugin for SiYuan

Sync your SiYuan notes with a private GitHub repository using only the GitHub REST API — fully cross-platform: **Windows, Linux, macOS, Android**.

## Features

- 🔒 **Secure** — PAT stored locally via SiYuan's native `saveData()`
- 📤 **Push** — Upload sync metadata to GitHub (creates or updates the file)
- 📥 **Pull** — Fetch the latest sync state from GitHub
- ✅ **Connection test** — Verify credentials before saving
- 🤖 **Auto-check on startup** — Silent background connectivity check
- 📱 **Android-safe** — Zero Node.js APIs, all `fetch()` + SiYuan SDK

## Installation (Development / Self-hosted)

See [Build Instructions](#build--install) below.

## Build & Install

### Prerequisites

- Node.js ≥ 18 (or Bun / pnpm)
- npm or pnpm

### Steps

```bash
# 1. Enter the project directory
cd "sync plug SIYUAN"

# 2. Install dependencies
npm install
# or: pnpm install

# 3a. Development build (watch mode)
npm run dev

# 3b. Production build (creates dist/ + zip)
npm run build
```

After `npm run build`:

1. A `dist/` folder is created containing `index.js`, `index.css`, and `plugin.json`.
2. A `siyuan-github-sync.zip` is created in `dist/`.

### Load into SiYuan

**Method A — Symlink (for active development):**
```
{siyuan-workspace}/data/plugins/siyuan-github-sync/  →  your project root
```

**Method B — Manual copy:**
Copy the contents of `dist/` into:
```
{siyuan-workspace}/data/plugins/siyuan-github-sync/
```

Then restart SiYuan and enable the plugin in **Settings → Marketplace → Installed**.

## Configuration

1. Open **Settings** in SiYuan → Click ⚙️ next to "GitHub Sync"
2. Enter your **GitHub Username**, **Repository Name**, and **Personal Access Token** (needs `repo` scope)
3. Click **Connect & Test** — on success credentials are saved automatically

## License

MIT
>>>>>>> 9cdf981 (Initial commit - SiYuan GitHub Sync plugin)
