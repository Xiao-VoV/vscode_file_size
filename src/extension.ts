import * as vscode from 'vscode';
import { formatBytes } from './format';
import { getEntrySize, SizeCancelledError, SizeFs } from './size';

function toSizeFs(): SizeFs<vscode.Uri> {
  return {
    async stat(uri) {
      const stat = await vscode.workspace.fs.stat(uri);
      return { size: stat.size, type: stat.type };
    },
    async readDirectory(uri) {
      const entries = await vscode.workspace.fs.readDirectory(uri);
      return entries.map(([name, type]) => ({
        path: vscode.Uri.joinPath(uri, name),
        type,
      }));
    },
  };
}

function basename(uri: vscode.Uri): string {
  const parts = uri.path.split('/').filter(Boolean);
  return parts[parts.length - 1] || uri.fsPath;
}

export function activate(context: vscode.ExtensionContext): void {
  const sizeFs = toSizeFs();

  const showSize = vscode.commands.registerCommand(
    'fileSizeExplorer.showSize',
    async (uri?: vscode.Uri) => {
      if (!uri) {
        void vscode.window.showWarningMessage(
          'File Size Explorer: 请通过资源管理器右键菜单使用此命令。',
        );
        return;
      }

      const name = basename(uri);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: `正在计算 ${name} 的大小…`,
          cancellable: true,
        },
        async (progress, token) => {
          try {
            const result = await getEntrySize(sizeFs, uri, token, {
              onProgress: (partial) => {
                progress.report({
                  message: `已扫描 ${partial.fileCount} 个文件（${formatBytes(partial.bytes)}）`,
                });
              },
            });

            const details =
              result.fileCount > 0 || result.dirCount > 0
                ? `（${result.fileCount} 个文件，${result.dirCount} 个目录）`
                : '';
            void vscode.window.showInformationMessage(
              `${name}: ${formatBytes(result.bytes)}${details}`,
            );
          } catch (err) {
            if (err instanceof SizeCancelledError || token.isCancellationRequested) {
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(
              `File Size Explorer: 计算大小失败（${message}）`,
            );
          }
        },
      );
    },
  );

  context.subscriptions.push(showSize);
}

export function deactivate(): void {}