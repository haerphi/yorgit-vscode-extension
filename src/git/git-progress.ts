import * as vscode from 'vscode';

const VIEW_CONTAINER_ID = 'workbench.view.extension.yorgit-side-panel';

/**
 * Délai avant d'afficher l'indicateur : les lectures git rapides (ls-files, show…)
 * se terminent bien avant, ce qui évite un clignotement de la barre à chaque refresh.
 */
const SHOW_DELAY_MS = 150;

let pending = 0;
let showTimer: ReturnType<typeof setTimeout> | undefined;
let endCurrent: (() => void) | undefined;

function startIndicator(): void {
    showTimer = undefined;
    if (pending === 0 || endCurrent) {
        return;
    }
    const done = new Promise<void>(resolve => (endCurrent = resolve));
    // Un seul indicateur partagé, compté par référence : des opérations qui se
    // chevauchent (action + repo.status() + refresh des vues) ne doivent pas empiler
    // plusieurs barres ni faire disparaître la barre tant qu'une autre tourne encore.
    void vscode.window.withProgress({ location: { viewId: VIEW_CONTAINER_ID } }, () => done);
    void vscode.window.withProgress(
        { location: vscode.ProgressLocation.Window, title: vscode.l10n.t('YorGit: git operation in progress…') },
        () => done,
    );
}

function begin(): void {
    pending++;
    if (pending === 1 && !endCurrent && !showTimer) {
        showTimer = setTimeout(startIndicator, SHOW_DELAY_MS);
    }
}

function end(): void {
    pending = Math.max(0, pending - 1);
    if (pending > 0) {
        return;
    }
    if (showTimer) {
        clearTimeout(showTimer);
        showTimer = undefined;
    }
    endCurrent?.();
    endCurrent = undefined;
}

/**
 * Affiche un indicateur de chargement (barre de progression du panneau YorGit, icône
 * animée dans la barre d'activité et message dans la barre d'état) pendant `task`.
 *
 * À utiliser autour des appels à l'API vscode.git (checkout, add, push…) qui ne
 * passent pas par runGit ; runGit, lui, est déjà suivi automatiquement.
 */
export async function withGitProgress<T>(task: () => Thenable<T>): Promise<T> {
    begin();
    try {
        return await task();
    } finally {
        end();
    }
}
