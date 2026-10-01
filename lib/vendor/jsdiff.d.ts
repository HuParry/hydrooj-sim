export interface Change {
    value: string;
    added: boolean;
    removed: boolean;
}

export function diffLines(oldText: string, newText: string, options?: { timeout: number }): Change[] | undefined;
export function diffWordsWithSpace(oldText: string, newText: string, options?: { timeout: number }): Change[] | undefined;
