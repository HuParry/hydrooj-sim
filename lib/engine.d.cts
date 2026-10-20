export function getLanguageProfile(lang: string, languages?: Record<string, any>): {
    language: string; family: string; extension: string;
};
export function runJPlag(rootDir: string, language: string, threshold: number, timeoutSeconds: number): Promise<{
    pairs: { left: string; right: string; similarity: number }[];
    insufficient: boolean;
}>;
export const USE_BUNDLED_JAVA: boolean;
