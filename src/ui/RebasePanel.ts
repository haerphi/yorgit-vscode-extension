import { API } from '@haerphi/vscode-git-api-types';
import { spawn } from 'child_process';
import { randomBytes } from 'crypto';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { getRebaseDefaultOrder, resolveWebviewLocale } from '../config';
import { offerConflictResolution } from '../git/conflict-helper';
import { withGitProgress } from '../git/git-progress';
import { RebaseEntry } from '../types/rebase';

/** Plan refusé avant tout lancement de git : rien à annuler, le dépôt n'a pas bougé. */
class RebasePlanError extends Error {}

export class RebasePanel {
    private static _panel: vscode.WebviewPanel | undefined;

    /**
     * Ouvre le panneau de rebase interactif.
     *
     * @param upstream  Ref git servant de base (nom de branche ou hash de commit).
     *                  Les commits entre upstream et HEAD sont proposés au rebase.
     * @param upstreamLabel  Libellé affiché dans l'UI (peut être identique à upstream).
     */
    static async show(
        context: vscode.ExtensionContext,
        gitApi: API,
        upstream: string,
        upstreamLabel: string,
    ): Promise<void> {
        const repo = gitApi.repositories[0];
        if (!repo) {
            vscode.window.showErrorMessage(vscode.l10n.t('No git repository detected.'));
            return;
        }

        if (RebasePanel._panel) {
            RebasePanel._panel.reveal(vscode.ViewColumn.One);
            return;
        }

        const panel = vscode.window.createWebviewPanel(
            'yorgit-rebase',
            vscode.l10n.t('Interactive Rebase → {0}', upstreamLabel),
            vscode.ViewColumn.One,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'out', 'webview')],
            },
        );

        RebasePanel._panel = panel;

        panel.onDidDispose(() => {
            RebasePanel._panel = undefined;
        });

        panel.webview.html = RebasePanel._buildHtml(panel.webview, context);

        panel.webview.onDidReceiveMessage(
            async (msg: { type: string; entries?: RebaseEntry[]; rebaseMerges?: boolean }) => {
                if (msg.type === 'ready') {
                    try {
                        const entries = await RebasePanel._loadEntries(gitApi.git.path, repo.rootUri.fsPath, upstream);
                        const hasMerges = await RebasePanel._hasMergeCommits(
                            gitApi.git.path,
                            repo.rootUri.fsPath,
                            upstream,
                        );
                        panel.webview.postMessage({ type: 'entries', entries, upstreamLabel, hasMerges });
                    } catch (err) {
                        panel.webview.postMessage({
                            type: 'error',
                            message: err instanceof Error ? err.message : String(err),
                        });
                    }
                } else if (msg.type === 'start' && msg.entries) {
                    panel.webview.postMessage({ type: 'running' });
                    try {
                        if (msg.rebaseMerges) {
                            await RebasePanel._executeRebaseMerges(
                                gitApi.git.path,
                                repo.rootUri.fsPath,
                                msg.entries,
                                upstream,
                            );
                        } else {
                            await RebasePanel._executeRebase(gitApi.git.path, repo.rootUri.fsPath, msg.entries, upstream);
                        }
                        await withGitProgress(() => repo.status());
                        panel.webview.postMessage({ type: 'done' });
                        vscode.window.showInformationMessage(
                            vscode.l10n.t('Interactive rebase onto "{0}" completed.', upstreamLabel),
                        );
                    } catch (err) {
                        const errMsg = err instanceof Error ? err.message : String(err);
                        if (err instanceof RebasePlanError) {
                            panel.webview.postMessage({ type: 'rebase-error', message: errMsg });
                            return;
                        }

                        await offerConflictResolution(repo, gitApi, context);

                        // Ne pas affirmer "conflits" quand git a rejeté le todo lui-même
                        // (todo invalide, commit introuvable…) : le message masquait la vraie cause.
                        const looksLikeConflict = /conflict|CONFLICT|could not apply/.test(errMsg);

                        // Proposer d'annuler le rebase si git est en état REBASE_MERGE
                        const abortLabel = vscode.l10n.t('Abort Rebase');
                        const action = await vscode.window.showErrorMessage(
                            looksLikeConflict
                                ? vscode.l10n.t('Interactive rebase failed (likely conflicts).')
                                : vscode.l10n.t('Interactive rebase failed.'),
                            { detail: errMsg },
                            abortLabel,
                        );

                        if (action === abortLabel) {
                            try {
                                await RebasePanel._spawnGit(gitApi.git.path, ['rebase', '--abort'], repo.rootUri.fsPath);
                                await withGitProgress(() => repo.status());
                                vscode.window.showInformationMessage(
                                    vscode.l10n.t('Rebase aborted. The branch is back to its initial state.'),
                                );
                                panel.webview.postMessage({
                                    type: 'rebase-error',
                                    message: errMsg + '\n\n→ ' + vscode.l10n.t('Rebase aborted.'),
                                });
                            } catch {
                                panel.webview.postMessage({ type: 'rebase-error', message: errMsg });
                            }
                        } else {
                            panel.webview.postMessage({ type: 'rebase-error', message: errMsg });
                        }
                    }
                } else if (msg.type === 'cancel') {
                    panel.dispose();
                }
            },
        );
    }

    private static async _hasMergeCommits(gitPath: string, cwd: string, upstream: string): Promise<boolean> {
        try {
            const out = await RebasePanel._spawnGit(
                gitPath,
                ['rev-list', '--merges', '--max-count=1', `${upstream}..HEAD`],
                cwd,
            );
            return out.trim().length > 0;
        } catch {
            return false;
        }
    }

    /**
     * Retourne les commits entre `upstream` et HEAD, du plus ancien au plus récent.
     * C'est l'ordre attendu par git rebase -i (top = appliqué en premier).
     *
     * --no-merges est obligatoire : `git rebase -i` (sans --rebase-merges) linéarise
     * l'historique et construit son todo sans les commits de merge. Les lister ici
     * produisait un todo que git refuse — "error: 'pick' does not accept merge commits",
     * dès qu'un merge restait en pick. Les commits apportés par le merge, eux, sont bien
     * présents dans la plage et restent donc rebasables individuellement.
     */
    private static _loadEntries(gitPath: string, cwd: string, upstream: string): Promise<RebaseEntry[]> {
        return new Promise((resolve, reject) => {
            const proc = spawn(
                gitPath,
                ['log', '--reverse', '--no-merges', `${upstream}..HEAD`, '--format=%H%x00%s%x00%ar%x00%ai'],
                { cwd },
            );
            const out: string[] = [];
            const err: string[] = [];
            proc.stdout.on('data', (d: Buffer) => out.push(d.toString()));
            proc.stderr.on('data', (d: Buffer) => err.push(d.toString()));
            proc.on('close', code => {
                if (code !== 0) {
                    reject(new Error(err.join('').trim() || `git log a échoué (code ${code})`));
                    return;
                }
                const lines = out
                    .join('')
                    .split('\n')
                    .filter(l => l.includes('\x00'));
                resolve(
                    lines.map(line => {
                        const [hash, message, date, isoDate] = line.split('\x00');
                        const h = hash.trim();
                        return {
                            action: 'pick' as const,
                            hash: h,
                            shortHash: h.slice(0, 7),
                            message: message?.trim() ?? '',
                            date: date?.trim() ?? '',
                            isoDate: isoDate?.trim() ?? '',
                        };
                    }),
                );
            });
        });
    }

    /**
     * Construit le fichier todo rebase, l'écrit dans un temp, et lance `git rebase -i`
     * avec GIT_SEQUENCE_EDITOR pointant vers une commande qui remplace le todo de git
     * par le nôtre.
     *
     * Pourquoi GIT_SEQUENCE_EDITOR = `cp "<our-todo>"` ?
     *   git exécute : sh -c "$GIT_SEQUENCE_EDITOR $REBASE_TODO_FILE"
     *   → sh -c `cp "/tmp/yorgit-todo" /path/to/.git/rebase-merge/git-rebase-todo`
     *   Le chemin destination est concaténé directement à notre commande.
     *   Sur git-for-windows, git utilise son sh MINGW, donc `cp` est disponible.
     *
     * Pourquoi GIT_EDITOR=true ?
     *   Pour les actions `squash`, git ouvre l'éditeur pour combiner les messages.
     *   `true` (ou `:` sur POSIX) sort sans modifier le fichier — git garde le message
     *   auto-généré (concaténation des messages). L'utilisateur peut amender ensuite.
     */
    private static async _executeRebase(
        gitPath: string,
        cwd: string,
        entries: RebaseEntry[],
        upstream: string,
    ): Promise<void> {
        const tmpFiles: string[] = [];
        try {
            const todoLines: string[] = [];
            for (const e of entries) {
                todoLines.push(...RebasePanel._todoLinesFor(e, e.hash, e.message, tmpFiles));
            }
            await RebasePanel._runRebaseWithTodo(gitPath, cwd, ['rebase', '-i', upstream], todoLines, tmpFiles);
        } finally {
            RebasePanel._cleanup(tmpFiles);
        }
    }

    /**
     * Variante `--rebase-merges` : la topologie (label/reset/merge) ne peut pas être
     * reconstruite à partir de la liste linéaire du webview, on laisse donc git la
     * générer puis on y reporte les actions choisies, commit par commit.
     *
     * Pourquoi deux lancements de `git rebase` ?
     *   Le premier sert uniquement à capturer le todo généré par git : l'éditeur copie
     *   le fichier puis le vide, et git abandonne alors proprement ("nothing to do")
     *   sans avoir touché HEAD ni laissé d'état .git/rebase-merge. Le second lance le
     *   vrai rebase avec le todo modifié, via le même mécanisme que `_executeRebase`.
     *
     * L'ordre des commits n'est pas modifiable dans ce mode (le webview le fige) :
     * déplacer un pick d'une branche à l'autre casserait la structure des merges.
     */
    private static async _executeRebaseMerges(
        gitPath: string,
        cwd: string,
        entries: RebaseEntry[],
        upstream: string,
    ): Promise<void> {
        const tmpFiles: string[] = [];
        try {
            const generated = await RebasePanel._captureGeneratedTodo(gitPath, cwd, upstream, tmpFiles);
            const todoLines = RebasePanel._applyActionsToTodo(generated, entries, tmpFiles);
            await RebasePanel._runRebaseWithTodo(
                gitPath,
                cwd,
                ['rebase', '-i', '--rebase-merges', upstream],
                todoLines,
                tmpFiles,
            );
        } finally {
            RebasePanel._cleanup(tmpFiles);
        }
    }

    private static async _captureGeneratedTodo(
        gitPath: string,
        cwd: string,
        upstream: string,
        tmpFiles: string[],
    ): Promise<string> {
        const snapshotPath = path.join(os.tmpdir(), `yorgit-rebase-generated-${randomBytes(4).toString('hex')}`);
        tmpFiles.push(snapshotPath);
        const snap = RebasePanel._toGitShellPath(snapshotPath);
        // git exécute `sh -c '<éditeur> "$@"' … <todo>` : la fonction reçoit donc le
        // chemin du todo en $1.
        const seqEditor = `f() { cp "$1" "${snap}" && : > "$1"; }; f`;
        try {
            await RebasePanel._spawnGit(gitPath, ['rebase', '-i', '--rebase-merges', upstream], cwd, {
                GIT_SEQUENCE_EDITOR: seqEditor,
                GIT_EDITOR: 'true',
            });
        } catch (err) {
            // L'échec "nothing to do" est attendu ; seule l'absence de capture est une vraie erreur
            // (worktree sale, upstream introuvable…).
            if (!fs.existsSync(snapshotPath)) {
                throw err;
            }
        }
        return fs.readFileSync(snapshotPath, 'utf8');
    }

    private static _applyActionsToTodo(generated: string, entries: RebaseEntry[], tmpFiles: string[]): string[] {
        const PICK = new Set(['pick', 'p']);
        // Commandes après lesquelles HEAD est un commit de la branche en cours de réécriture :
        // un squash/fixup s'y fond correctement. Après `reset`/`label`/en tête de todo, il
        // se fondrait dans un commit d'une autre branche (ou dans la base).
        const MELD_TARGET = new Set([
            'pick',
            'p',
            'reword',
            'r',
            'edit',
            'e',
            'squash',
            's',
            'fixup',
            'f',
            'merge',
            'm',
        ]);
        const out: string[] = [];
        let lastCommand: string | undefined;

        for (const raw of generated.split('\n')) {
            const line = raw.trim();
            if (!line || line.startsWith('#')) {
                continue;
            }
            const [cmd, abbrev, ...rest] = line.split(/\s+/);
            const entry = PICK.has(cmd) && abbrev ? entries.find(e => e.hash.startsWith(abbrev)) : undefined;
            if (!entry) {
                out.push(line);
                lastCommand = cmd;
                continue;
            }
            if ((entry.action === 'squash' || entry.action === 'fixup') && !MELD_TARGET.has(lastCommand ?? '')) {
                throw new RebasePlanError(
                    vscode.l10n.t(
                        'Cannot {0} commit {1} "{2}": while keeping merges, it must directly follow another commit of the same branch.',
                        entry.action,
                        entry.shortHash,
                        entry.message,
                    ),
                );
            }
            out.push(...RebasePanel._todoLinesFor(entry, abbrev, rest.join(' '), tmpFiles));
            if (entry.action !== 'drop') {
                lastCommand = entry.action;
            }
        }
        return out;
    }

    /**
     * `reword` est converti en `pick` + `exec git commit --amend -F <fichier>` : git
     * appellerait sinon GIT_EDITOR une fois par commit renommé, de façon séquentielle.
     * Écrire chaque message dans un fichier dédié garde le rebase non-interactif.
     */
    private static _todoLinesFor(entry: RebaseEntry, ref: string, comment: string, tmpFiles: string[]): string[] {
        if (entry.action !== 'reword') {
            return [`${entry.action} ${ref} ${comment}`];
        }
        const msgPath = path.join(os.tmpdir(), `yorgit-reword-${randomBytes(4).toString('hex')}.txt`);
        fs.writeFileSync(msgPath, (entry.newMessage ?? entry.message).trim() + '\n', 'utf8');
        tmpFiles.push(msgPath);
        return [`pick ${ref} ${comment}`, `exec git commit --amend -F "${RebasePanel._toGitShellPath(msgPath)}"`];
    }

    private static async _runRebaseWithTodo(
        gitPath: string,
        cwd: string,
        args: string[],
        todoLines: string[],
        tmpFiles: string[],
    ): Promise<void> {
        const todoPath = path.join(os.tmpdir(), `yorgit-rebase-todo-${randomBytes(4).toString('hex')}`);
        fs.writeFileSync(todoPath, todoLines.join('\n') + '\n', 'utf8');
        tmpFiles.push(todoPath);
        await RebasePanel._spawnGit(gitPath, args, cwd, {
            GIT_SEQUENCE_EDITOR: `cp "${RebasePanel._toGitShellPath(todoPath)}"`,
            GIT_EDITOR: 'true',
        });
    }

    private static _cleanup(files: string[]): void {
        for (const f of files) {
            try {
                fs.unlinkSync(f);
            } catch {
                /* ignore */
            }
        }
    }

    /**
     * Convertit un chemin OS en chemin compatible POSIX pour le sh embarqué de
     * git-for-windows. Sur Linux/WSL, retourne le chemin sans modification.
     *
     * Ex: C:\Users\foo\AppData\Local\Temp\todo → /c/Users/foo/AppData/Local/Temp/todo
     */
    private static _toGitShellPath(p: string): string {
        if (process.platform !== 'win32') {
            return p;
        }
        return p.replace(/^([A-Za-z]):/, (_, d) => '/' + d.toLowerCase()).replace(/\\/g, '/');
    }

    private static _spawnGit(
        gitPath: string,
        args: string[],
        cwd: string,
        extraEnv: Record<string, string> = {},
    ): Promise<string> {
        return withGitProgress(
            () =>
                new Promise<string>((resolve, reject) => {
                    const proc = spawn(gitPath, args, {
                        cwd,
                        env: { ...process.env, ...extraEnv },
                    });
                    const out: string[] = [];
                    const err: string[] = [];
                    proc.stdout.on('data', (d: Buffer) => out.push(d.toString()));
                    proc.stderr.on('data', (d: Buffer) => err.push(d.toString()));
                    proc.on('close', code => {
                        if (code !== 0) {
                            reject(new Error((err.join('') || out.join('')).trim()));
                            return;
                        }
                        resolve(out.join(''));
                    });
                }),
        );
    }

    private static _buildHtml(webview: vscode.Webview, context: vscode.ExtensionContext): string {
        const scriptUri = webview.asWebviewUri(
            vscode.Uri.joinPath(context.extensionUri, 'out', 'webview', 'rebase.js'),
        );
        const nonce = randomBytes(16).toString('hex');
        return `<!DOCTYPE html>
<html lang="fr">
<head>
    <meta charset="UTF-8" />
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
    <style>html,body{margin:0;padding:0;height:100%;overflow:hidden;}</style>
</head>
<body>
    <yorgit-rebase></yorgit-rebase>
    <script nonce="${nonce}">window.__YORGIT_LOCALE__ = ${JSON.stringify(resolveWebviewLocale())}; window.__YORGIT_REBASE_DEFAULT_ORDER__ = ${JSON.stringify(getRebaseDefaultOrder())};</script>
    <script nonce="${nonce}" src="${scriptUri}"></script>
</body>
</html>`;
    }
}
