# Size Peek

A VS Code extension to view the size of files and folders directly from the Explorer context menu. Works in Remote-SSH — sizes are computed on the **remote** filesystem.

## Features

- Right-click a file or folder → **Show Size** to display its total size (with file and directory counts) in a notification.
- Cancelable progress indicator while walking large directories.
- Built on VS Code's official `vscode.workspace.fs` API; runs on the remote extension host under Remote-SSH.
- Symbolic links are not followed, preventing cycles and double-counting.

## Installation & Development

```bash
npm install
npm run compile     # builds dist/extension.js
```

Debug locally: open this project in VS Code and press `F5`.

Package for publishing:

```bash
npm run package    # produces a .vsix
```

## Usage

1. Right-click a file or folder in the Explorer.
2. Choose **Show Size**.
3. The total size (e.g. `12.3 MB`) is shown in a notification; large directories show progress and file counts.

## Known Limitations

- Files/directories without read permission are skipped (does not affect the overall total).
- Symbolic links are not followed, to avoid cycles and double-counting.
- Scanning large directories (e.g. `node_modules`) can take time; use the progress bar to cancel.

## Remote (Remote-SSH)

The extension sets `"extensionKind": ["workspace"]` so it runs in the workspace execution environment. In a Remote-SSH session the extension host runs on the remote machine, so `vscode.workspace.fs` operates on the remote filesystem — no extra configuration required.