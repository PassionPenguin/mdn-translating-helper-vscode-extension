import * as path from 'path';
import * as vscode from 'vscode';
import { execFile } from 'child_process';
import { promisify } from 'util';

type BlockType = 'heading' | 'code' | 'list' | 'image' | 'paragraph';

interface BlockAnchor {
  startLine: number;
  endLine: number; // inclusive end
  type: BlockType;
}

interface SyncSession {
  left: vscode.TextEditor;
  right: vscode.TextEditor;
  leftBlocks: BlockAnchor[];
  rightBlocks: BlockAnchor[];
  disposables: vscode.Disposable[];
  ignoreEditor?: vscode.TextEditor;
  lastSyncAtMs: number;
}

let session: SyncSession | undefined;
let isResyncing = false;
const missingCounterparts = new Map<string, number>();
let lastRightUri: vscode.Uri | undefined;
let helperEnabled = false;
const execFileAsync = promisify(execFile);

export function activate(context: vscode.ExtensionContext) {
  context.subscriptions.push(
    vscode.commands.registerCommand('mdnHelper.activate', async () => {
      helperEnabled = true;
      vscode.window.setStatusBarMessage('MDN Translating Helper: active', 2000);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mdnHelper.deactivate', async () => {
      helperEnabled = false;
      stopSync();
      await closeLastRightTab();
      vscode.window.setStatusBarMessage('MDN Translating Helper: inactive', 2000);
    })
  );

  context.subscriptions.push(
    vscode.commands.registerCommand('mdnHelper.updateSourceHash', async () => {
      await updateSourceHash();
    })
  );

  context.subscriptions.push(
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      // Auto-resync when user switches tabs (only when helper is enabled), but ignore when focus moves to the counterpart pane.
      if (!helperEnabled || !editor) return;
      if (!isFileDocument(editor.document)) return;
      if (session?.right && sameDocument(editor.document, session.right.document)) return;
      if (isResyncing) return;

      isResyncing = true;
      openAndSync(editor, { invokedByAuto: true }).finally(() => {
        isResyncing = false;
      });
    })
  );
}

export function deactivate() {
  stopSync();
}

function stopSync() {
  if (!session) return;
  for (const d of session.disposables) d.dispose();
  session = undefined;
}

async function openAndSync(editor?: vscode.TextEditor, opts?: { invokedByAuto?: boolean }): Promise<void> {
  if (!helperEnabled) return;
  const active = editor ?? vscode.window.activeTextEditor;
  if (!active) {
    await showInfoPane('MDN Sync: No active editor', 'Open a translated-content or content file first.');
    return;
  }

  if (!isFileDocument(active.document) || !isFilesPath(active.document.uri.fsPath)) {
    return;
  }

  const activePath = active.document.uri.fsPath;
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(active.document.uri)?.uri.fsPath
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    await showInfoPane('MDN Sync: No workspace', 'No workspace folder found.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('mdnSync');
  const defaultLocale = String(cfg.get('defaultLocale', 'zh-cn'));

  const counterpartPath = mapToCounterpart({
    filePath: activePath,
    workspaceRoot,
    defaultLocale,
  });

  if (!counterpartPath) {
    await showInfoPane(
      'MDN Sync: Unmapped file',
      'This file is not under translated-content/files/<locale>/ or content/files/en-us/.\n' +
        `Active: ${activePath}`
    );
    return;
  }

  const counterpartUri = vscode.Uri.file(counterpartPath);

  if (!(await fileExists(counterpartUri))) {
    const misses = missingCounterparts.get(counterpartPath) ?? 0;
    if (misses === 0) {
      await showInfoPane(
        'MDN Sync: Missing counterpart',
        'Corresponding file not found in the target tree.\n' +
          `Looked for: ${counterpartPath}`
      );
    }
    missingCounterparts.set(counterpartPath, misses + 1);
    return;
  }

  missingCounterparts.delete(counterpartPath);

  await closeLastRightTab();

  const doc = await vscode.workspace.openTextDocument(counterpartUri);
  const opened = await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: true,
    preview: false,
  });
  lastRightUri = opened.document.uri;

  // Choose left/right consistently by column, falling back to active as left.
  const left = (active.viewColumn ?? vscode.ViewColumn.One) <= (opened.viewColumn ?? vscode.ViewColumn.Two) ? active : opened;
  const right = left === active ? opened : active;

  startSync(left, right);

  // Show commit info for the counterpart without stealing focus.
  const hash = await tryGetGitHash(counterpartPath);
  if (hash) {
    await showInfoPane(
      'MDN Translating Helper: Source commit',
      `File: ${counterpartPath}\nCommit: ${hash}`
    );
  }
}

function startSync(left: vscode.TextEditor, right: vscode.TextEditor): void {
  stopSync();

  const leftBlocks = computeMarkdownBlocks(left.document);
  const rightBlocks = computeMarkdownBlocks(right.document);

  session = {
    left,
    right,
    leftBlocks,
    rightBlocks,
    disposables: [],
    ignoreEditor: undefined,
    lastSyncAtMs: 0,
  };

  const recompute = (editor: vscode.TextEditor) => {
    if (!session) return;
    if (sameDocument(editor.document, session.left.document)) {
      session.leftBlocks = computeMarkdownBlocks(session.left.document);
    } else if (sameDocument(editor.document, session.right.document)) {
      session.rightBlocks = computeMarkdownBlocks(session.right.document);
    }
  };

  session.disposables.push(
    vscode.workspace.onDidChangeTextDocument((e) => {
      if (!session) return;
      if (sameDocument(e.document, session.left.document)) recompute(session.left);
      if (sameDocument(e.document, session.right.document)) recompute(session.right);
    })
  );

  session.disposables.push(
    vscode.window.onDidChangeActiveTextEditor((e) => {
      if (!session || !e) return;
      // If either editor got replaced (e.g. reopened), stop rather than doing surprising sync.
      const isLeft = sameDocument(e.document, session.left.document);
      const isRight = sameDocument(e.document, session.right.document);
      if (!isLeft && !isRight) return;
    })
  );

  const onScroll = (editor: vscode.TextEditor) => {
    if (!session) return;

    const throttleMs = Math.max(0, Number(vscode.workspace.getConfiguration('mdnSync').get('throttleMs', 60)));
    const now = Date.now();
    if (now - session.lastSyncAtMs < throttleMs) return;

    if (session.ignoreEditor && editor === session.ignoreEditor) return;

    const other = editor === session.left ? session.right : session.left;
    const fromBlocks = editor === session.left ? session.leftBlocks : session.rightBlocks;
    const toBlocks = editor === session.left ? session.rightBlocks : session.leftBlocks;

    const visible = editor.visibleRanges[0];
    if (!visible) return;

    const topLine = visible.start.line;
    const targetLine = mapLineToOther(topLine, fromBlocks, toBlocks);
    if (targetLine === undefined) return;

    session.lastSyncAtMs = now;
    session.ignoreEditor = other;
    try {
      const pos = new vscode.Position(targetLine, 0);
      other.revealRange(new vscode.Range(pos, pos), vscode.TextEditorRevealType.AtTop);
    } finally {
      // Clear the guard soon; keep it simple and robust.
      setTimeout(() => {
        if (session) session.ignoreEditor = undefined;
      }, 0);
    }
  };

  session.disposables.push(
    vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      if (!session) return;
      if (e.textEditor === session.left || e.textEditor === session.right) {
        onScroll(e.textEditor);
      }
    })
  );
}

function sameDocument(a: vscode.TextDocument, b: vscode.TextDocument): boolean {
  return a.uri.toString() === b.uri.toString();
}

async function fileExists(uri: vscode.Uri): Promise<boolean> {
  try {
    await vscode.workspace.fs.stat(uri);
    return true;
  } catch {
    return false;
  }
}

function mapToCounterpart(params: {
  filePath: string;
  workspaceRoot: string;
  defaultLocale: string;
}): string | undefined {
  const rel = path.relative(params.workspaceRoot, params.filePath).replaceAll(path.sep, '/');

  // translated-content/files/<locale>/...  -> content/files/en-us/...
  const translatedPrefix = 'translated-content/files/';
  if (rel.startsWith(translatedPrefix)) {
    const rest = rel.slice(translatedPrefix.length);
    const parts = rest.split('/');
    if (parts.length < 2) return undefined;
    // parts[0] is locale; rest is the doc path
    const docPath = parts.slice(1).join('/');
    return path.join(params.workspaceRoot, 'content', 'files', 'en-us', ...docPath.split('/'));
  }

  // content/files/en-us/... -> translated-content/files/<defaultLocale>/...
  const contentPrefix = 'content/files/en-us/';
  if (rel.startsWith(contentPrefix)) {
    const docPath = rel.slice(contentPrefix.length);
    return path.join(params.workspaceRoot, 'translated-content', 'files', params.defaultLocale, ...docPath.split('/'));
  }

  return undefined;
}

function computeMarkdownBlocks(doc: vscode.TextDocument): BlockAnchor[] {
  const blocks: BlockAnchor[] = [];

  const lineCount = doc.lineCount;
  let inFence = false;

  const push = (startLine: number, type: BlockType) => {
    if (startLine < 0 || startLine >= lineCount) return;
    const last = blocks[blocks.length - 1];
    if (last && last.startLine === startLine) return;
    blocks.push({ startLine, endLine: startLine, type });
  };

  const isEmpty = (s: string) => s.trim().length === 0;

  for (let i = 0; i < lineCount; i++) {
    const text = doc.lineAt(i).text;
    const trimmed = text.trim();

    if (trimmed.startsWith('```')) {
      // Treat each fence line as a block anchor.
      push(i, 'code');
      inFence = !inFence;
      continue;
    }

    if (inFence) continue;

    if (/^#{1,6}\s+/.test(trimmed)) {
      push(i, 'heading');
      continue;
    }

    if (/^([-*+]\s+|\d+\.\s+)/.test(trimmed)) {
      push(i, 'list');
      continue;
    }

    if (trimmed.includes('![') || /<img\b/i.test(trimmed)) {
      push(i, 'image');
      continue;
    }

    // Paragraph start heuristic: current line non-empty and previous line empty.
    if (!isEmpty(trimmed)) {
      const prev = i > 0 ? doc.lineAt(i - 1).text : '';
      if (i === 0 || isEmpty(prev)) {
        push(i, 'paragraph');
      }
    }
  }

  if (blocks.length === 0) {
    blocks.push({ startLine: 0, endLine: lineCount - 1, type: 'paragraph' });
  }

  // Fill endLine using next block start - 1
  for (let i = 0; i < blocks.length; i++) {
    const nextStart = blocks[i + 1]?.startLine ?? lineCount;
    blocks[i].endLine = Math.max(blocks[i].startLine, nextStart - 1);
  }

  return blocks;
}

function mapLineToOther(line: number, fromBlocks: BlockAnchor[], toBlocks: BlockAnchor[]): number | undefined {
  if (fromBlocks.length === 0 || toBlocks.length === 0) return undefined;

  const idx = findBlockIndex(fromBlocks, line);
  if (idx < 0) return undefined;

  const from = fromBlocks[idx];
  const to = toBlocks[Math.min(idx, toBlocks.length - 1)];
  if (!to) return undefined;

  const offset = clamp(line - from.startLine, 0, from.endLine - from.startLine);
  const target = clamp(to.startLine + offset, to.startLine, to.endLine);
  return target;
}

function findBlockIndex(blocks: BlockAnchor[], line: number): number {
  if (blocks.length === 0) return -1;

  // Find last block whose startLine <= line
  let lo = 0;
  let hi = blocks.length - 1;
  let best = 0;

  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    const start = blocks[mid].startLine;
    if (start <= line) {
      best = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  return best;
}

function clamp(v: number, lo: number, hi: number): number {
  if (v < lo) return lo;
  if (v > hi) return hi;
  return v;
}

function isFileDocument(doc: vscode.TextDocument): boolean {
  return doc.uri.scheme === 'file';
}

async function showInfoPane(title: string, body: string): Promise<void> {
  const doc = await vscode.workspace.openTextDocument({
    content: `${title}\n\n${body}`,
    language: 'markdown',
  });

  await vscode.window.showTextDocument(doc, {
    viewColumn: vscode.ViewColumn.Beside,
    preserveFocus: true,
    preview: true,
  });
}

function isFilesPath(fsPath: string): boolean {
  // Only react to files under .../files/... specifically translated-content/files/ or content/files.
  const segments = fsPath.split(path.sep);
  const idx = segments.indexOf('files');
  if (idx === -1) return false;
  if (idx === 0) return false;
  const prev = segments[idx - 1];
  return prev === 'translated-content' || prev === 'content';
}

async function closeLastRightTab(): Promise<void> {
  if (!lastRightUri) return;
  const tabs = vscode.window.tabGroups.all.flatMap((g) => g.tabs);
  const target = tabs.find((t) => {
    const input = (t as any).input as vscode.TabInputText | undefined;
    return input && 'uri' in input && input.uri.toString() === lastRightUri!.toString();
  });
  if (target) {
    try {
      await vscode.window.tabGroups.close(target, true);
    } catch {
      // ignore close errors
    }
  }
  lastRightUri = undefined;
}

async function tryGetGitHash(filePath: string): Promise<string | undefined> {
  const cwd = path.dirname(filePath);
  let repoRoot: string | undefined;

  try {
    const { stdout } = await execFileAsync('git', ['-C', cwd, 'rev-parse', '--show-toplevel'], {
      timeout: 4000,
      maxBuffer: 1024 * 1024,
    });
    repoRoot = stdout.trim();
  } catch {
    return undefined;
  }

  if (!repoRoot) return undefined;

  const rel = path.relative(repoRoot, filePath);

  try {
    const { stdout } = await execFileAsync('git', ['-C', repoRoot, 'log', '-1', '--format=%H', '--', rel], {
      timeout: 5000,
      maxBuffer: 1024 * 1024,
    });
    const hash = stdout.trim();
    return hash.length ? hash : undefined;
  } catch {
    return undefined;
  }
}

async function updateSourceHash(): Promise<void> {
  const active = vscode.window.activeTextEditor;
  if (!active) {
    await showInfoPane('MDN Translating Helper', 'No active editor to update.');
    return;
  }
  if (!isFileDocument(active.document) || !isFilesPath(active.document.uri.fsPath)) {
    await showInfoPane('MDN Translating Helper', 'Active file is not under translated-content/files/...');
    return;
  }

  const activePath = active.document.uri.fsPath;
  const workspaceRoot = vscode.workspace.getWorkspaceFolder(active.document.uri)?.uri.fsPath
    ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
  if (!workspaceRoot) {
    await showInfoPane('MDN Translating Helper', 'No workspace folder found.');
    return;
  }

  const cfg = vscode.workspace.getConfiguration('mdnSync');
  const defaultLocale = String(cfg.get('defaultLocale', 'zh-cn'));

  const counterpartPath = mapToCounterpart({
    filePath: activePath,
    workspaceRoot,
    defaultLocale,
  });

  if (!counterpartPath) {
    await showInfoPane('MDN Translating Helper', 'Cannot map this file to content/files/en-us/.');
    return;
  }

  const hash = await tryGetGitHash(counterpartPath);
  if (!hash) {
    await showInfoPane('MDN Translating Helper', 'Could not retrieve git hash for the content file.');
    return;
  }

  const updated = await writeSourceCommit(active.document, hash);
  if (!updated) {
    await showInfoPane('MDN Translating Helper', 'Failed to update sourceCommit in front matter.');
    return;
  }

  await vscode.window.showTextDocument(active.document, { preserveFocus: false });
  vscode.window.setStatusBarMessage(`Updated sourceCommit to ${hash}`, 3000);
}

async function writeSourceCommit(doc: vscode.TextDocument, hash: string): Promise<boolean> {
  const fullText = doc.getText();
  const lines = fullText.split(/\r?\n/);

  let start = -1;
  let end = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === '---') {
      if (start === -1) {
        start = i;
      } else {
        end = i;
        break;
      }
    }
  }

  const newLine = (idx: number) => (doc.eol === vscode.EndOfLine.CRLF ? '\r\n' : '\n');
  const nl = newLine(0);

  if (start === -1 || end === -1 || end <= start) {
    const fm = ['---', `sourceCommit: ${hash}`, '---', ''];
    const edit = new vscode.WorkspaceEdit();
    edit.insert(doc.uri, new vscode.Position(0, 0), fm.join(nl));
    const applied = await vscode.workspace.applyEdit(edit);
    return applied;
  }

  // front matter exists
  let found = false;
  const fmLines = lines.slice(start + 1, end);
  for (let i = 0; i < fmLines.length; i++) {
    const trimmed = fmLines[i].trimStart();
    if (trimmed.startsWith('sourceCommit:')) {
      const indent = fmLines[i].slice(0, fmLines[i].length - trimmed.length);
      fmLines[i] = `${indent}sourceCommit: ${hash}`;
      found = true;
      break;
    }
  }

  if (!found) {
    fmLines.push(`sourceCommit: ${hash}`);
  }

  const newFm = ['---', ...fmLines, '---'].join(nl);
  const edit = new vscode.WorkspaceEdit();
  const fmRange = new vscode.Range(new vscode.Position(start, 0), new vscode.Position(end, lines[end].length));
  edit.replace(doc.uri, fmRange, newFm);
  const applied = await vscode.workspace.applyEdit(edit);
  return applied;
}
