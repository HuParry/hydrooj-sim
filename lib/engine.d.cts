export interface DiffPart { text: string; changed: boolean }
export interface DiffRow {
    leftNumber: number | null;
    rightNumber: number | null;
    left: DiffPart[];
    right: DiffPart[];
    leftChanged: boolean;
    rightChanged: boolean;
}
export function getLanguageProfile(lang: string, languages?: Record<string, any>): {
    language: string; family: string; extension: string;
};
export function buildDiffRows(left: string, right: string): DiffRow[];
export function runJPlag(rootDir: string, language: string, threshold: number, timeoutSeconds: number): Promise<{
    pairs: { left: string; right: string; similarity: number }[];
    insufficient: boolean;
}>;
export const USE_BUNDLED_JAVA: boolean;
