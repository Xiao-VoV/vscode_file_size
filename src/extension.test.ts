import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, it } from 'node:test';
import { Script } from 'node:vm';
import { buildSync } from 'esbuild';
import { FileType, type SizeEntry } from './size.js';

// Exercise the real bundled command and size traversal with only the VS Code
// boundary replaced. No extension host or new runtime dependency is needed.
const bundle = buildSync({
  entryPoints: [resolve('src/extension.ts')],
  bundle: true,
  external: ['vscode'],
  format: 'cjs',
  platform: 'node',
  write: false,
}).outputFiles[0].text;

interface TestUri {
  path: string;
  fsPath: string;
}

interface TestFs {
  stat(uri: TestUri): Promise<SizeEntry>;
  readDirectory(uri: TestUri): Promise<Array<[string, number]>>;
}

const uri = (path: string): TestUri => ({ path, fsPath: path });
const fileFs: TestFs = {
  async stat() {
    return { type: FileType.File, size: 1536 };
  },
  async readDirectory() {
    throw new Error('Not a directory');
  },
};

function harness(fs: TestFs = fileFs, language = 'en') {
  const translations: Record<string, string> = language === 'zh-cn'
    ? JSON.parse(readFileSync(resolve('l10n/bundle.l10n.zh-cn.json'), 'utf8'))
    : {};
  const token = { isCancellationRequested: false };
  const messages = { information: [] as string[], warning: [] as string[], error: [] as string[] };
  const progressMessages: string[] = [];
  const titles: string[] = [];
  const subscriptions: Array<{ dispose(): void }> = [];
  let command: ((target?: TestUri) => Promise<void>) | undefined;
  let disposed = false;
  const mockVscode = {
    workspace: { fs },
    Uri: { joinPath: (base: TestUri, name: string) => uri(`${base.path.replace(/\/$/, '')}/${name}`) },
    ProgressLocation: { Notification: 15 },
    commands: {
      registerCommand(id: string, handler: (target?: TestUri) => Promise<void>) {
        assert.equal(id, 'fileSizeExplorer.showSize');
        command = handler;
        return { dispose() { disposed = true; } };
      },
    },
    l10n: {
      t(message: string, ...args: Array<string | number | boolean>) {
        if (language === 'zh-cn') {
          assert.ok(Object.hasOwn(translations, message), `Missing translation: ${message}`);
        }
        return (translations[message] ?? message).replace(/\{(\d+)\}/g, (_, index: string) => String(args[Number(index)]));
      },
    },
    window: {
      showInformationMessage(message: string) { messages.information.push(message); },
      showWarningMessage(message: string) { messages.warning.push(message); },
      showErrorMessage(message: string) { messages.error.push(message); },
      async withProgress(
        options: { title: string; cancellable: boolean },
        task: (progress: { report(value: { message: string }): void }, token: { isCancellationRequested: boolean }) => Promise<void>,
      ) {
        assert.equal(options.cancellable, true);
        titles.push(options.title);
        await task({ report: ({ message }) => progressMessages.push(message) }, token);
      },
    },
  };

  const extensionModule: {
    exports: { activate?: (context: { subscriptions: Array<{ dispose(): void }> }) => void };
  } = { exports: {} };
  new Script(`(function(require, module, exports) { ${bundle}\n})`).runInThisContext()(
    (name: string) => {
      assert.equal(name, 'vscode');
      return mockVscode;
    },
    extensionModule,
    extensionModule.exports,
  );
  assert.ok(extensionModule.exports.activate);
  extensionModule.exports.activate({ subscriptions });
  assert.ok(command);
  return { command, messages, progressMessages, titles, token, subscriptions, isDisposed: () => disposed };
}

describe('showSize command', () => {
  it('renders English fallback text and registers a disposable command', async () => {
    const app = harness();
    await app.command(uri('/hello.txt'));
    assert.deepEqual(app.messages, {
      information: ['hello.txt: 1.5 KB (1 files, 0 directories)'], warning: [], error: [],
    });
    assert.deepEqual(app.titles, ['Calculating size of hello.txt…']);
    assert.equal(app.subscriptions.length, 1);
    app.subscriptions[0].dispose();
    assert.equal(app.isDisposed(), true);
  });

  it('interpolates Chinese progress and result templates', async () => {
    const app = harness({
      async stat(target) {
        return { type: target.path === '/folder' ? FileType.Directory : FileType.File, size: 1536 };
      },
      async readDirectory() { return [['hello.txt', FileType.File]]; },
    }, 'zh-cn');
    await app.command(uri('/folder'));
    assert.deepEqual(app.titles, ['正在计算 folder 的大小…']);
    assert.ok(app.progressMessages.includes('已扫描 1 个文件（1.5 KB）'));
    assert.deepEqual(app.messages, {
      information: ['folder: 1.5 KB（1 个文件，0 个目录）'], warning: [], error: [],
    });
  });

  for (const language of ['en', 'zh-cn']) {
    it(`warns about missing context in ${language}`, async () => {
      const app = harness(fileFs, language);
      await app.command();
      assert.deepEqual(app.messages.warning, [language === 'en'
        ? 'Please use this command from the Explorer context menu.'
        : '请通过资源管理器右键菜单使用此命令。']);
      assert.deepEqual(app.titles, []);
    });

    it(`shows root errors in ${language}`, async () => {
      const app = harness({ ...fileFs, async stat() { throw new Error('EACCES'); } }, language);
      await app.command(uri('/private'));
      assert.deepEqual(app.messages, {
        information: [], warning: [], error: [language === 'en'
          ? 'Size Peek: Failed to compute size (EACCES)'
          : 'Size Peek: 计算大小失败（EACCES）'],
      });
    });

    it(`warns about partial totals and skipped entries in ${language}`, async () => {
      const app = harness({
        async stat(target) {
          if (target.path === '/folder') { return { type: FileType.Directory, size: 0 }; }
          if (target.path.endsWith('/denied')) { throw new Error('EACCES'); }
          return { type: FileType.File, size: 42 };
        },
        async readDirectory() { return [['ok', FileType.File], ['denied', FileType.File]]; },
      }, language);
      await app.command(uri('/folder'));
      assert.deepEqual(app.messages, {
        information: [], error: [], warning: [language === 'en'
          ? 'folder: 42 B (1 files, 0 directories) — Partial size: 1 entries could not be read.'
          : 'folder: 42 B（1 个文件，0 个目录） — 大小统计不完整：有 1 个条目无法读取。'],
      });
    });
  }

  for (const fails of [false, true]) {
    it(`suppresses notifications after cancellation during a ${fails ? 'failed' : 'successful'} read`, async () => {
      const app = harness({
        async stat() { return { type: FileType.Directory, size: 0 }; },
        async readDirectory() {
          app.token.isCancellationRequested = true;
          if (fails) { throw new Error('EACCES'); }
          return [];
        },
      });
      await app.command(uri('/empty'));
      assert.deepEqual(app.messages, { information: [], warning: [], error: [] });
    });
  }
});
