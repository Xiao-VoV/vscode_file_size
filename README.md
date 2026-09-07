# File Size Explorer

一个 VS Code 扩展：右键点击资源管理器中的**文件或文件夹**，即可查看其总大小。支持 Remote-SSH 远程会话，统计的是**远端**文件系统。

## 功能

- 右键文件/文件夹 → 「Show Size」，通过通知弹窗展示总大小（含文件数与目录数）。
- 大目录遍历时显示可取消的进度条。
- 通过 VS Code 官方 `vscode.workspace.fs` API 实现，Remote-SSH 下自动在远端 extension host 运行。
- 符号链接不跟随，避免死循环与重复计数。

## 安装与调试

```bash
npm install
npm run compile     # 产出 dist/extension.js
```

本地调试：在 VS Code 中打开本项目，按 `F5`。

打包发布：

```bash
npm run package    # 产出 .vsix
```

## 使用

1. 在资源管理器中右键点击一个文件或文件夹。
2. 选择「Show Size」。
3. 通知中会显示总大小（如 `12.3 MB`），大目录会显示进度与文件数。

## 已知限制

- 没有权限读取的文件/目录会被跳过（不影响整体统计）。
- 不跟随符号链接，避免循环与重复计数。
- 首次打开会因统计大目录（如 `node_modules`）而耗时，可用进度条取消。

## 远程（Remote-SSH）说明

扩展通过 `"extensionKind": ["workspace"]` 强制在 workspace 侧运行。在 Remote-SSH 会话中，extension host 位于远端机器，`vscode.workspace.fs` 操作的即是远端文件系统，无需额外配置。