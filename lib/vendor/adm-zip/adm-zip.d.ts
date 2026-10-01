declare class AdmZip {
    constructor(filename: string);
    getEntry(name: string): { getData(): Buffer } | null;
}

export = AdmZip;
