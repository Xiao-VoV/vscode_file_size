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
          vscode.l10n.t('warn.useFromContextMenu'),
        );
        return;
      }

      const name = basename(uri);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('progress.title', name),
          cancellable: true,
        },
        async (progress, token) => {
          try {
            const result = await getEntrySize(sizeFs, uri, token, {
              onProgress: (partial) => {
                progress.report({
                  message: vscode.l10n.t(
                    'progress.message',
                    partial.fileCount.toString(),
                    formatBytes(partial.bytes),
                  ),
                });
              },
            });

            const details =
              result.fileCount > 0 || result.dirCount > 0
                ? vscode.l10n.t(
                    'result.details',
                    result.fileCount.toString(),
                    result.dirCount.toString(),
                  )
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
              vscode.l10n.t('error.failed', message),
            );
          }
        },
      );
    },
  );

  context.subscriptions.push(showSize);
}

export function deactivate(): void {}