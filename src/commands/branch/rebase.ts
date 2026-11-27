import { API } from '@haerphi/vscode-git-api-types';
import * as vscode from 'vscode';
import { BranchLeaf } from '../../git/branches-provider';
import { offerConflictResolution } from '../../git/conflict-helper';
import { runGit } from '../../git/git-exec';
import { getRepo } from '../utils';
import { withGitProgress } from '../../git/git-progress';

async function gitRebase(gitPath: string, onto: string, cwd: string, rebaseMerges: boolean): Promise<string> {
    const args = rebaseMerges ? ['rebase', '--rebase-merges', onto] : ['rebase', onto];
    return (await runGit(gitPath, args, cwd)).trim();
}

async function hasMergeCommits(gitPath: string, onto: string, cwd: string): Promise<boolean> {
    try {
        const out = await runGit(gitPath, ['rev-list', '--merges', '--max-count=1', `${onto}..HEAD`], cwd);
        return out.trim().length > 0;
    } catch {
        // En cas de doute, on propose l'option plutôt que de la masquer.
        return true;
    }
}

async function gitRebaseAbort(gitPath: string, cwd: string): Promise<void> {
    // Best-effort : appelé en récupération d'un rebase déjà en échec, on ignore une
    // éventuelle erreur d'abort pour ne pas masquer la cause initiale.
    await runGit(gitPath, ['rebase', '--abort'], cwd).catch(() => undefined);
}

export function registerRebase(gitApi: API, context: vscode.ExtensionContext): vscode.Disposable[] {
    const rebaseOnto = vscode.commands.registerCommand('haerphi-yorgit.rebase-onto', async (node: BranchLeaf) => {
        const repo = getRepo(gitApi);
        if (!repo) {
            return;
        }

        const currentBranch = repo.state.HEAD?.name;
        if (!currentBranch) {
            vscode.window.showErrorMessage(vscode.l10n.t('Could not determine the current branch (detached HEAD?)'));
            return;
        }

        const targetBranch = node.branch.name;
        if (!targetBranch) {
            return;
        }

        if (targetBranch === currentBranch) {
            vscode.window.showWarningMessage(vscode.l10n.t('Cannot rebase a branch onto itself.'));
            return;
        }

        // Sans commit de merge dans la plage, --rebase-merges produit le même résultat :
        // inutile d'encombrer la modale avec un second bouton.
        const withMerges = await hasMergeCommits(gitApi.git.path, targetBranch, repo.rootUri.fsPath);

        const rebaseLabel = vscode.l10n.t('Rebase');
        const rebaseMergesLabel = vscode.l10n.t('Rebase (keep merges)');
        let detail = vscode.l10n.t(
            'The commits of the current branch will be replayed on top of the target. ' +
                'If conflicts occur, the rebase will stop and you will have to resolve them manually.',
        );
        if (withMerges) {
            detail +=
                '\n\n' +
                vscode.l10n.t(
                    'The current branch contains merge commits. "{0}" uses git rebase --rebase-merges to preserve them; ' +
                        '"{1}" flattens the history and drops them.',
                    rebaseMergesLabel,
                    rebaseLabel,
                );
        }
        const buttons = withMerges ? [rebaseMergesLabel, rebaseLabel] : [rebaseLabel];
        const confirm = await vscode.window.showWarningMessage(
            vscode.l10n.t('Rebase "{0}" onto "{1}"?', currentBranch, targetBranch),
            { modal: true, detail },
            ...buttons,
        );
        if (confirm !== rebaseLabel && confirm !== rebaseMergesLabel) {
            return;
        }

        try {
            await gitRebase(gitApi.git.path, targetBranch, repo.rootUri.fsPath, confirm === rebaseMergesLabel);
            await withGitProgress(() => repo.status());
            vscode.window.showInformationMessage(
                vscode.l10n.t('Rebase of "{0}" onto "{1}" completed.', currentBranch, targetBranch),
            );
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);

            // git rebase laisse le dépôt en état REBASE_HEAD en cas de conflit.
            // On propose d'abandonner pour remettre le dépôt dans un état propre.
            await offerConflictResolution(repo, gitApi, context);

            const abortLabel = vscode.l10n.t('Abort Rebase');
            const action = await vscode.window.showErrorMessage(
                vscode.l10n.t('Rebase failed (likely conflicts). Do you want to abort the rebase?'),
                { detail: message },
                abortLabel,
            );

            if (action === abortLabel) {
                try {
                    await gitRebaseAbort(gitApi.git.path, repo.rootUri.fsPath);
                    await withGitProgress(() => repo.status());
                    vscode.window.showInformationMessage(
                        vscode.l10n.t('Rebase aborted. The branch is back to its initial state.'),
                    );
                } catch (abortErr) {
                    vscode.window.showErrorMessage(
                        vscode.l10n.t(
                            'git rebase --abort failed: {0}',
                            abortErr instanceof Error ? abortErr.message : String(abortErr),
                        ),
                    );
                }
            }
        }
    });

    return [rebaseOnto];
}
