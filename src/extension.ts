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
          vscode.l10n.t('Please use this command from the Explorer context menu.'),
        );
        return;
      }

      const name = basename(uri);

      await vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Notification,
          title: vscode.l10n.t('Calculating size of {0}…', name),
          cancellable: true,
        },
        async (progress, token) => {
          try {
            const result = await getEntrySize(sizeFs, uri, token, {
              onProgress: (partial) => {
                progress.report({
                  message: vscode.l10n.t(
                    'Scanned {0} files ({1})',
                    partial.fileCount.toString(),
                    formatBytes(partial.bytes),
                  ),
                });
              },
            });

            if (token.isCancellationRequested) {
              return;
            }

            const details =
              result.fileCount > 0 || result.dirCount > 0
                ? vscode.l10n.t(
                    ' ({0} files, {1} directories)',
                    result.fileCount.toString(),
                    result.dirCount.toString(),
                  )
                : '';
            const summary = `${name}: ${formatBytes(result.bytes)}${details}`;
            if (result.skippedCount > 0) {
              void vscode.window.showWarningMessage(
                vscode.l10n.t(
                  '{0} — Partial size: {1} entries could not be read.',
                  summary,
                  result.skippedCount.toString(),
                ),
              );
            } else {
              void vscode.window.showInformationMessage(summary);
            }
          } catch (err) {
            if (err instanceof SizeCancelledError || token.isCancellationRequested) {
              return;
            }
            const message = err instanceof Error ? err.message : String(err);
            void vscode.window.showErrorMessage(
              vscode.l10n.t('Size Peek: Failed to compute size ({0})', message),
            );
          }
        },
      );
    },
  );

  context.subscriptions.push(showSize);
}

export function deactivate(): void {}
