# SiYuan GitHub Sync Plugin

Sync your SiYuan notes with a private GitHub repository via the GitHub REST API. Compatible with **Windows, Linux, macOS, and Android**.

## Features

### Data Synchronization
- **Incremental Push** — Sends only modified files
- **Incremental Pull** — Retrieves modified remote files
- **Automatic Merge** — 3-way merge before push (local / remote / last known state)
- **Conflict Management** — Local priority in case of conflict
- **Diff before push** — Displays files added/modified/deleted before pushing

### Plugin and Widget Synchronization
- **Plugin Sync** — A manifest (`plugin-manifest.json`) is pushed with data containing a list of all installed plugins (name + version)
- **Widget Sync** — A manifest (`widget-manifest.json`) is pushed with data containing all installed widgets
- **Automatic Installation** — On pull, missing plugins/widgets are automatically installed from the official SiYuan marketplace
- **Plugin Sync Exclusion** — `siyuan-github-sync` Never included in manifests nor installed/removed

### Other
- **Secure** — Stores tokens locally via `saveData()`
- **Groq AI** — Automatically generates commit messages (optional)
- **Export/Import** — Saves and restores the configuration

## Installation

### From the compile folder

Copy the `dist/` folder or the compiled folder to:
```
{siyuan-workspace}/data/plugins/siyuan-github-sync/
```

Then restart SiYuan and activate the plugin in **Settings → Marketplace → Install**.

### Build from source

```bash
npm install
npm run build
```

The `dist/` folder will be created. Copy it to the `data/plugins/` folder of SiYuan.

### On Android mobile

Use a file manager to copy the `siyuan-github-sync` folder to `Android/data/com.example.siyuan/files/data/plugins/` (or the equivalent path depending on your version).

## Configuration

1. Open **Settings** → click on ⚙️ next to "GitHub Sync"
2. Enter **GitHub Username**, **Repository Name**, **PAT (Personal Access Token) Token** (scope `repo`)
3. Click on **Test GitHub** to verify the connection
4. Click on **Save**

## How Plugin/Widget Sync Works

### Push
The plugin scans the `data/plugins/` and `data/widgets/` folders, reads each `plugin.json`/`widget.json` file, and generates two manifest files:

- `data/plugin-manifest.json` — List of installed plugins (name + version)
- `data/widget-manifest.json` — List of installed widgets (name + version)

These Manifests are pushed alongside the other data files.

### Pull
After the data pull, the plugin:
1. Downloads the two manifests from the remote repository
2. Compares the list of remote plugins/widgets with those installed locally
3. Automatically installs any missing plugins/widgets from the SiYuan marketplace
4. Displays the result in the pull completion message

> **Note**: Only plugins/widgets available on the official marketplace are installed automatically. Custom plugins are not supported.

## Development

```bash
npm run dev # Watch mode

./compile.sh # Build + automatic deployment to SiYuan (Linux)
```

## License

MIT
