import { API } from '@haerphi/vscode-git-api-types';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as vscode from 'vscode';
import { resolveWebviewLocale } from '../config';
import { CommitEntry, LogBranch, LogRef } from '../types/log';
import { CommitDetailPanel } from './CommitDetailPanel';
import { ConfirmModal } from './ConfirmModal';
import { RebasePanel } from './RebasePanel';
import { validateBranchName } from '../commands/utils';

const MAX_COMMITS = 500;
const BRANCH_FILTER_KEY = 'yorgit.log.branchFilter';

export class LogPanel {
    private static _panel: vscode.WebviewPanel | undefined;

    static show(context: vscode.ExtensionContext, gitApi: API): void {
        const repo = gitApi.repositories[0];
        if (!repo) {
            vscode.window.showErrorMessage(vscode.l10n.t('No git repository detected.'));
            return;
        }

        if (LogPanel._panel) {
            LogPanel._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel('yorgit-log', vscode.l10n.t('History'), vscode.ViewColumn.One, {
            enableScripts: true,
            retainContextWhenHidden: true,
            localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')],
        });

        LogPanel._panel = panel;

        // Refs complètes (refs/heads/…, refs/remotes/…) ; vide = toutes les branches.
        let branchFilter = context.workspaceState.get<string[]>(BRANCH_FILTER_KEY, []);

        const loadAndPost = async () => {
            const branches = await LogPanel._loadBranches(gitApi.git.path, repo.rootUri.fsPath);
            // Une branche supprimée ou renommée depuis la dernière session ne doit pas
            // faire échouer `git log` — on l'oublie silencieusement.
            const known = new Set(branches.map(b => b.refname));
            const validFilter = branchFilter.filter(r => known.has(r));
            if (validFilter.length !== branchFilter.length) {
                branchFilter = validFilter;
                await context.workspaceState.update(BRANCH_FILTER_KEY, branchFilter);
            }
            const commits = await LogPanel._loadCommits(gitApi.git.path, repo.rootUri.fsPath, branchFilter);
            panel.webview.postMessage({ type: 'branches', branches, selected: branchFilter });
            panel.webview.postMessage({ type: 'commits', commits });
        };

        const reloadCommits = async () => {
            try {
                await loadAndPost();
            } catch {
                // Silently ignore reload errors — user still sees last known state
            }
        };

        const stateListener = repo.state.onDidChange(() => reloadCommits());
        panel.onDidDispose(() => {
            LogPanel._panel = undefined;
            stateListener.dispose();
        });

        panel.webview.html = LogPanel._buildHtml(panel.webview, context);

        panel.webview.onDidReceiveMessage(
            async (msg: {
                type: string;
                hash?: string;
                parentHashes?: string[];
                shortHash?: string;
                tagName?: string;
                branches?: string[];
            }) => {
                if (msg.type === 'ready') {
                    try {
                        await loadAndPost();
                    } catch (err) {
                        panel.webview.postMessage({
                            type: 'error',
                            message: err instanceof Error ? err.message : String(err),
                        });
                    }
                } else if (msg.type === 'set-branch-filter' && msg.branches) {
                    branchFilter = msg.branches;
                    await context.workspaceState.update(BRANCH_FILTER_KEY, branchFilter);
                    try {
                        await loadAndPost();
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(vscode.l10n.t('Could not load history: {0}', errMsg));
                    }
                } else if (msg.type === 'open-commit' && msg.hash && msg.shortHash) {
                    await CommitDetailPanel.show(context, gitApi, msg.hash, msg.shortHash, msg.parentHashes ?? []);
                } else if (msg.type === 'copy-hash' && msg.hash && msg.shortHash) {
                    await vscode.env.clipboard.writeText(msg.hash);
                    vscode.window.showInformationMessage(
                        vscode.l10n.t('Hash of commit {0} copied to the clipboard.', msg.shortHash),
                    );
                } else if (msg.type === 'cherry-pick' && msg.hash) {
                    try {
                        await LogPanel._spawnGit(gitApi.git.path, ['cherry-pick', msg.hash], repo.rootUri.fsPath);
                        vscode.window.showInformationMessage(
                            vscode.l10n.t('Cherry-pick of {0} applied.', msg.hash.slice(0, 7)),
                        );
                        await repo.status();
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(vscode.l10n.t('Cherry-pick failed: {0}', errMsg));
                        panel.webview.postMessage({ type: 'cherry-pick-error', message: errMsg });
                    }
                } else if (msg.type === 'revert' && msg.hash) {
                    try {
                        await LogPanel._spawnGit(
                            gitApi.git.path,
                            ['revert', '--no-edit', msg.hash],
                            repo.rootUri.fsPath,
                        );
                        vscode.window.showInformationMessage(
                            vscode.l10n.t('Revert of {0} applied.', msg.hash.slice(0, 7)),
                        );
                        await repo.status();
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(vscode.l10n.t('Revert failed: {0}', errMsg));
                        panel.webview.postMessage({ type: 'cherry-pick-error', message: errMsg });
                    }
                } else if (msg.type === 'rebase-interactive' && msg.hash && msg.shortHash) {
                    // L'upstream est le parent du commit cliqué : on rebase depuis ce commit (inclus) jusqu'à HEAD.
                    const upstream = `${msg.hash}^`;
                    const label = msg.shortHash;
                    await RebasePanel.show(context, gitApi, upstream, label);
                } else if (msg.type === 'reset-to-commit' && msg.hash && msg.shortHash) {
                    const option = await vscode.window.showQuickPick(
                        [
                            {
                                label: '$(circle-filled) Soft',
                                description: vscode.l10n.t('Keep staged changes'),
                                detail: vscode.l10n.t('git reset --soft — moves HEAD, keeps the staging area intact.'),
                                mode: '--soft',
                            },
                            {
                                label: '$(circle-outline) Mixed',
                                description: vscode.l10n.t('Keep unstaged changes'),
                                detail: vscode.l10n.t(
                                    'git reset --mixed — moves HEAD and clears the staging area (default).',
                                ),
                                mode: '--mixed',
                            },
                            {
                                label: '$(error) Hard',
                                description: vscode.l10n.t('Discard all local changes'),
                                detail: vscode.l10n.t(
                                    'git reset --hard — moves HEAD, clears the staging area AND the files. Irreversible.',
                                ),
                                mode: '--hard',
                            },
                        ],
                        {
                            title: vscode.l10n.t('Reset to {0}', msg.shortHash),
                            placeHolder: vscode.l10n.t('Choose the reset type…'),
                            matchOnDescription: true,
                            matchOnDetail: true,
                        },
                    );
                    if (!option) {
                        return;
                    }
                    if (option.mode === '--hard') {
                        const hardLabel = vscode.l10n.t('Hard Reset');
                        const confirm = await vscode.window.showWarningMessage(
                            vscode.l10n.t('Hard reset to {0}?', msg.shortHash),
                            {
                                modal: true,
                                detail: vscode.l10n.t('All uncommitted local changes will be permanently discarded.'),
                            },
                            hardLabel,
                        );
                        if (confirm !== hardLabel) {
                            return;
                        }
                    }
                    try {
                        await LogPanel._spawnGit(
                            gitApi.git.path,
                            ['reset', option.mode, msg.hash],
                            repo.rootUri.fsPath,
                        );
                        await repo.status();
                        vscode.window.showInformationMessage(
                            vscode.l10n.t('Reset {0} to {1} done.', option.mode, msg.shortHash),
                        );
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(vscode.l10n.t('Reset failed: {0}', errMsg));
                    }
                } else if (msg.type === 'add-tag' && msg.hash && msg.shortHash) {
                    const result = await ConfirmModal.show(context, {
                        title: vscode.l10n.t('Add Tag'),
                        message: vscode.l10n.t('Create a tag on commit {0}?', msg.shortHash),
                        inputs: [
                            { id: 'name', label: vscode.l10n.t('Tag name'), placeholder: vscode.l10n.t('e.g. v1.2.0') },
                        ],
                        checkboxes: [
                            { id: 'push', label: vscode.l10n.t('Push the tag to the remote'), checked: false },
                        ],
                        buttons: [
                            { label: vscode.l10n.t('Cancel'), value: 'cancel', variant: 'secondary' },
                            { label: vscode.l10n.t('Create Tag'), value: 'confirm', variant: 'primary' },
                        ],
                    });
                    if (!result || result.button !== 'confirm') {
                        return;
                    }
                    const tagName = result.inputs['name']?.trim() ?? '';
                    if (!tagName) {
                        vscode.window.showErrorMessage(vscode.l10n.t('The tag name cannot be empty.'));
                        return;
                    }
                    if (/\s/.test(tagName)) {
                        vscode.window.showErrorMessage(vscode.l10n.t('The tag name must not contain spaces.'));
                        return;
                    }
                    try {
                        await LogPanel._spawnGit(gitApi.git.path, ['tag', tagName, msg.hash], repo.rootUri.fsPath);
                        if (result.checkboxes['push']) {
                            const remote = repo.state.remotes[0]?.name ?? 'origin';
                            await LogPanel._spawnGit(gitApi.git.path, ['push', remote, tagName], repo.rootUri.fsPath);
                            vscode.window.showInformationMessage(
                                vscode.l10n.t(
                                    'Tag {0} created on {1} and pushed to {2}.',
                                    tagName,
                                    msg.shortHash,
                                    remote,
                                ),
                            );
                        } else {
                            vscode.window.showInformationMessage(
                                vscode.l10n.t('Tag {0} created on {1}.', tagName, msg.shortHash),
                            );
                        }
                        // La création d'un tag hors API vscode.git ne déclenche pas
                        // repo.state.onDidChange — recharger l'historique manuellement.
                        await reloadCommits();
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(vscode.l10n.t('Tag creation failed: {0}', errMsg));
                    }
                } else if (msg.type === 'delete-tag' && msg.tagName) {
                    const remote = repo.state.remotes[0]?.name ?? 'origin';
                    const result = await ConfirmModal.show(context, {
                        title: vscode.l10n.t('Delete Tag'),
                        message: vscode.l10n.t('Delete the tag "{0}"?', msg.tagName),
                        warning: vscode.l10n.t(
                            'The tag will be deleted from the local repository. This action is irreversible.',
                        ),
                        checkboxes: [
                            {
                                id: 'remote',
                                label: vscode.l10n.t('Also delete the tag on the remote ({0})', remote),
                                checked: false,
                            },
                        ],
                        buttons: [
                            { label: vscode.l10n.t('Cancel'), value: 'cancel', variant: 'secondary' },
                            { label: vscode.l10n.t('Delete'), value: 'confirm', variant: 'danger' },
                        ],
                    });
                    if (!result || result.button !== 'confirm') {
                        return;
                    }
                    try {
                        await LogPanel._spawnGit(gitApi.git.path, ['tag', '-d', msg.tagName], repo.rootUri.fsPath);
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(vscode.l10n.t('Tag deletion failed: {0}', errMsg));
                        return;
                    }
                    if (result.checkboxes['remote']) {
                        try {
                            // refs/tags/ évite toute ambiguïté avec une branche du même nom
                            await LogPanel._spawnGit(
                                gitApi.git.path,
                                ['push', remote, '--delete', `refs/tags/${msg.tagName}`],
                                repo.rootUri.fsPath,
                            );
                            vscode.window.showInformationMessage(
                                vscode.l10n.t('Tag {0} deleted locally and on {1}.', msg.tagName, remote),
                            );
                        } catch (err) {
                            const errMsg = err instanceof Error ? err.message : String(err);
                            vscode.window.showWarningMessage(
                                vscode.l10n.t(
                                    'Tag {0} deleted locally, but deletion on {1} failed: {2}',
                                    msg.tagName,
                                    remote,
                                    errMsg,
                                ),
                            );
                        }
                    } else {
                        vscode.window.showInformationMessage(vscode.l10n.t('Tag {0} deleted locally.', msg.tagName));
                    }
                    // La suppression d'un tag hors API vscode.git ne déclenche pas
                    // repo.state.onDidChange — recharger l'historique manuellement.
                    await reloadCommits();
                } else if (msg.type === 'create-branch-here' && msg.hash && msg.shortHash) {
                    const result = await ConfirmModal.show(context, {
                        title: vscode.l10n.t('Create Branch'),
                        message: vscode.l10n.t('Create a branch at commit {0}?', msg.shortHash),
                        inputs: [
                            {
                                id: 'name',
                                label: vscode.l10n.t('Branch name'),
                                placeholder: vscode.l10n.t('e.g. feature/my-feature'),
                            },
                        ],
                        checkboxes: [
                            { id: 'switch', label: vscode.l10n.t('Switch to the new branch'), checked: false },
                            {
                                id: 'force',
                                label: vscode.l10n.t('Force (discard uncommitted local changes)'),
                                checked: false,
                                enabledWhen: 'switch',
                            },
                        ],
                        buttons: [
                            { label: vscode.l10n.t('Cancel'), value: 'cancel', variant: 'secondary' },
                            { label: vscode.l10n.t('Create Branch'), value: 'confirm', variant: 'primary' },
                        ],
                    });
                    if (!result || result.button !== 'confirm') {
                        return;
                    }
                    const branchName = result.inputs['name']?.trim() ?? '';
                    const nameError = validateBranchName(branchName);
                    if (nameError) {
                        vscode.window.showErrorMessage(nameError);
                        return;
                    }
                    const doSwitch = result.checkboxes['switch'] === true;
                    const force = doSwitch && result.checkboxes['force'] === true;
                    try {
                        const args = doSwitch
                            ? ['switch', ...(force ? ['-f'] : []), '-c', branchName, msg.hash]
                            : ['branch', branchName, msg.hash];
                        await LogPanel._spawnGit(gitApi.git.path, args, repo.rootUri.fsPath);
                        await repo.status();
                        vscode.window.showInformationMessage(
                            doSwitch
                                ? vscode.l10n.t('Branch {0} created at {1} and checked out.', branchName, msg.shortHash)
                                : vscode.l10n.t('Branch {0} created at {1}.', branchName, msg.shortHash),
                        );
                        // Une branche créée hors API vscode.git peut ne pas déclencher
                        // repo.state.onDidChange — recharger l'historique manuellement.
                        await reloadCommits();
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(vscode.l10n.t('Could not create branch: {0}', errMsg));
                    }
                } else if (msg.type === 'switch-to-commit' && msg.hash && msg.shortHash) {
                    const switchLabel = vscode.l10n.t('Switch Anyway');
                    const confirm = await vscode.window.showWarningMessage(
                        vscode.l10n.t('Switch to commit {0}?', msg.shortHash),
                        {
                            detail: vscode.l10n.t(
                                'HEAD will be detached. You will no longer be on a branch — any new commit will be orphaned until you create or switch to a branch.',
                            ),
                            modal: true,
                        },
                        switchLabel,
                    );
                    if (confirm !== switchLabel) {
                        return;
                    }
                    try {
                        await LogPanel._spawnGit(gitApi.git.path, ['checkout', msg.hash], repo.rootUri.fsPath);
                        await repo.status();
                        vscode.window.showInformationMessage(
                            vscode.l10n.t('HEAD detached at {0}. Create a branch to keep your commits.', msg.shortHash),
                        );
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        vscode.window.showErrorMessage(vscode.l10n.t('Switch failed: {0}', errMsg));
                    }
                }
            },
        );
    }

    private static _spawnGit(gitPath: string, args: string[], cwd: string): Promise<string> {
        return new Promise((resolve, reject) => {
            const proc = spawn(gitPath, args, { cwd });
            const out: string[] = [];
            const err: string[] = [];
            proc.stdout.on('data', (d: Buffer) => out.push(d.toString()));
            proc.stderr.on('data', (d: Buffer) => err.push(d.toString()));
            proc.on('close', code => {
                if (code !== 0) {
                    reject(new Error(err.join('').trim()));
                    return;
                }
                resolve(out.join(''));
            });
        });
    }

    private static async _loadBranches(gitPath: string, cwd: string): Promise<LogBranch[]> {
        const out = await LogPanel._spawnGit(
            gitPath,
            ['for-each-ref', '--format=%(refname)%00%(refname:short)%00%(HEAD)', 'refs/heads', 'refs/remotes'],
            cwd,
        );
        return (
            out
                .split('\n')
                .filter(l => l.includes('\x00'))
                .map(line => {
                    const [refname, name, head] = line.split('\x00');
                    return {
                        name,
                        refname,
                        type: refname.startsWith('refs/heads/') ? ('local' as const) : ('remote' as const),
                        isCurrent: head === '*',
                    };
                })
                // refs/remotes/<remote>/HEAD n'est qu'un alias symbolique de la branche par défaut
                .filter(b => !(b.type === 'remote' && b.refname.endsWith('/HEAD')))
        );
    }

    private static _loadCommits(gitPath: string, cwd: string, refs: string[]): Promise<CommitEntry[]> {
        return new Promise((resolve, reject) => {
            const proc = spawn(
                gitPath,
                [
                    'log',
                    // --exclude doit précéder --all pour que git l'applique avant l'expansion de toutes les refs
                    ...(refs.length > 0 ? refs : ['--exclude=refs/stash', '--all']),
                    `--max-count=${MAX_COMMITS}`,
                    '--format=%H%x00%P%x00%an%x00%ar%x00%s%x00%D%x00%ai',
                    '--',
                ],
                { cwd },
            );
            const out: string[] = [];
            const err: string[] = [];
            proc.stdout.on('data', (d: Buffer) => out.push(d.toString()));
            proc.stderr.on('data', (d: Buffer) => err.push(d.toString()));
            proc.on('close', code => {
                if (code !== 0) {
                    reject(new Error(err.join('').trim()));
                    return;
                }
                const lines = out
                    .join('')
                    .split('\n')
                    .filter(l => l.includes('\x00'));
                resolve(
                    lines.map(line => {
                        const [hash, parents, author, date, message, decoration, isoDate] = line.split('\x00');
                        return {
                            hash: hash.trim(),
                            shortHash: hash.trim().slice(0, 7),
                            parentHashes: parents.trim() ? parents.trim().split(' ') : [],
                            author: author.trim(),
                            date: date.trim(),
                            isoDate: isoDate?.trim() ?? '',
                            message: message.trim(),
                            refs: LogPanel._parseRefs(decoration?.trim() ?? ''),
                        };
                    }),
                );
            });
        });
    }

    private static _parseRefs(decoration: string): LogRef[] {
        if (!decoration) {
            return [];
        }
        return decoration
            .split(', ')
            .filter(r => r.trim())
            .map(r => {
                r = r.trim();
                if (r.startsWith('HEAD -> ')) {
                    return { type: 'head' as const, name: r.slice(8), isCurrent: true };
                }
                if (r === 'HEAD') {
                    return { type: 'head' as const, name: 'HEAD', isCurrent: true };
                }
                if (r.startsWith('tag: ')) {
                    return { type: 'tag' as const, name: r.slice(5), isCurrent: false };
                }
                if (r.includes('/')) {
                    return { type: 'remote' as const, name: r, isCurrent: false };
                }
                return { type: 'local' as const, name: r, isCurrent: false };
            });
    }

    private static _buildHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
        const scriptUri = webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri, 'out', 'webview', 'log.js'));
        const nonce = randomBytes(16).toString('hex');
        return `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <style>html,body{margin:0;padding:0;height:100%;overflow:hidden;}</style>
</head>
<body>
    <yorgit-log></yorgit-log>
    <script nonce="${nonce}">window.__YORGIT_LOCALE__ = ${JSON.stringify(resolveWebviewLocale())};</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
