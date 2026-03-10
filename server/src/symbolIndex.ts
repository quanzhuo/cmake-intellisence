import { Location } from 'vscode-languageserver';

export enum SymbolKind {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Function,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Variable,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Macro
}

export class Symbol {
    constructor(
        public name: string,
        public kind: SymbolKind,
        public uri: string,
        public line: number,
        public column: number
    ) { }

    getLocation(): Location {
        return {
            uri: this.uri,
            range: {
                start: {
                    line: this.line,
                    character: this.column,
                },
                end: {
                    line: this.line,
                    character: this.column + this.name.length
                }
            }
        };
    }
}

export type DependencyType = 'include' | 'subdirectory';

export interface Dependency {
    uri: string;
    type: DependencyType;
}

/**
 * Cached symbols and dependencies for a single CMake file.
 */
export class FileSymbolCache {
    // CMake commands (functions and macros) are case-insensitive.
    // Keys MUST be lowercase for proper lookup.
    public readonly commands: Map<string, Symbol[]> = new Map();

    // CMake variables are case-sensitive.
    public readonly variables: Map<string, Symbol[]> = new Map();

    // Dependencies in exact order of declaration
    public readonly dependencies: Dependency[] = [];

    constructor(public uri: string) { }

    addCommand(symbol: Symbol) {
        const key = symbol.name.toLowerCase();
        if (!this.commands.has(key)) {
            this.commands.set(key, []);
        }
        this.commands.get(key)!.push(symbol);
    }

    addVariable(symbol: Symbol) {
        if (!this.variables.has(symbol.name)) {
            this.variables.set(symbol.name, []);
        }
        this.variables.get(symbol.name)!.push(symbol);
    }

    addDependency(uri: string, type: DependencyType) {
        this.dependencies.push({ uri, type });
    }
}

/**
 * Global index holding the symbol caches of all parsed files in the workspace.
 */
export class SymbolIndex {
    private fileCaches: Map<string, FileSymbolCache> = new Map();

    setCache(uri: string, cache: FileSymbolCache): void {
        this.fileCaches.set(uri, cache);
    }

    getCache(uri: string): FileSymbolCache | undefined {
        return this.fileCaches.get(uri);
    }

    deleteCache(uri: string): void {
        this.fileCaches.delete(uri);
    }

    getAllCaches(): FileSymbolCache[] {
        return Array.from(this.fileCaches.values());
    }

    clear(): void {
        this.fileCaches.clear();
    }
}
