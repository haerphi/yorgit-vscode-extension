/**
 * Analyse des messages au format Conventional Commits (`type(scope)!: description`).
 *
 * Utilisé par le rebase interactif pour badger chaque ligne et regrouper les commits
 * par scope. Purement côté webview : rien n'est renvoyé au host, le message de commit
 * réel n'est jamais modifié par cette analyse.
 */

export interface ConventionalCommit {
    /** `feat`, `fix`, `chore`… toujours en minuscules. */
    type: string;
    /** `frontend`, `backend`… chaîne vide quand l'en-tête n'a pas de parenthèses. */
    scope: string;
    /** `true` pour `type(scope)!: …` — changement cassant signalé par Conventional Commits. */
    breaking: boolean;
    /** L'en-tête sans le préfixe `type(scope):`. */
    description: string;
}

// Seul le sujet (première ligne) porte l'en-tête conventionnel ; le corps est ignoré.
// Commitlint impose l'espace après les deux-points, on l'exige donc aussi pour éviter
// de prendre un « WIP: » de texte libre ou un « http://… » pour un en-tête valide.
const HEADER_RE = /^([a-zA-Z]+)(?:\(([^)]+)\))?(!)?: +(.+)$/;

export function parseConventional(message: string): ConventionalCommit | null {
    const subject = message.split('\n', 1)[0].trim();
    const m = HEADER_RE.exec(subject);
    if (!m) {
        return null;
    }
    return {
        type: m[1].toLowerCase(),
        scope: (m[2] ?? '').trim(),
        breaking: m[3] === '!',
        description: m[4].trim(),
    };
}

/**
 * Clé de regroupement d'un commit : son scope normalisé, ou '' quand il n'en a pas
 * (message non conventionnel ou en-tête sans parenthèses).
 */
export function scopeOf(message: string): string {
    return parseConventional(message)?.scope.toLowerCase() ?? '';
}

/**
 * Palette fixe plutôt qu'une teinte calculée : ces couleurs sont vérifiées lisibles
 * sur fond clair comme sur fond sombre, ce qu'un hue arbitraire ne garantit pas.
 */
const SCOPE_COLORS = [
    '#4e9de0', // bleu
    '#4ec98a', // vert
    '#e0a94e', // ambre
    '#b06ee0', // violet
    '#e06e8a', // rose
    '#3fb8b8', // cyan
    '#8ac94e', // olive
    '#e0794e', // orange
];

/**
 * Couleur stable pour un scope donné — un même scope garde le même badge d'une
 * session à l'autre, ce qui rend le plan de rebase scannable d'un coup d'œil.
 */
export function scopeColor(scope: string): string | null {
    if (!scope) {
        return null;
    }
    let hash = 0;
    for (let i = 0; i < scope.length; i++) {
        hash = (hash * 31 + scope.charCodeAt(i)) >>> 0;
    }
    return SCOPE_COLORS[hash % SCOPE_COLORS.length];
}
