export interface CodeInput {
    code: string;
    lang: string;
    highlight?: string;
    monaco?: string;
    codeFile?: string;
}
export interface CodePart { text: string; kind: string }
export interface CodeRow {
    leftNumber: number | null;
    rightNumber: number | null;
    left: CodePart[];
    right: CodePart[];
}
export function buildCodeView(left: CodeInput, right: CodeInput): Promise<{ rows: CodeRow[] }>;
