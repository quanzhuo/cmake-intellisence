import { Location } from "vscode-languageserver";
import { URI } from "vscode-uri";

export class Scope {
    private enclosingScope: Scope;
    private variables: Map<string, Symbol>;
    private commands: Map<string, Symbol>;

    constructor(enclosingScope: Scope) {
        this.enclosingScope = enclosingScope;
        this.variables = new Map<string, Symbol>();
        this.commands = new Map<string, Symbol>();
    }

    resolve(name: string, type: SymbolKind): Symbol | null {
        const symbols = type === SymbolKind.Variable ? this.variables : this.commands;
        const s = symbols.get(name);
        if (s !== undefined) {
            return s;
        }

        if (this.enclosingScope) {
            return this.enclosingScope.resolve(name, type);
        }

        return null;
    }

    define(symbol: Symbol): void {
        if (symbol.getType() === SymbolKind.Variable) {
            this.variables.set(symbol.getName(), symbol);
        } else {
            // Functions and Macros all saved into 'commands'
            this.commands.set(symbol.getName(), symbol);
        }

        symbol.setScope(this);
    }

    getEnclosingScope(): Scope {
        return this.enclosingScope;
    }

    clear(): void {
        this.variables.clear();
        this.commands.clear();
    }
}

export class FileScope extends Scope {
    constructor(encolsingScope: Scope) {
        super(encolsingScope);
    }
}

export class FunctionScope extends Scope {
    constructor(enclosingScope: Scope) {
        super(enclosingScope);
    }
}

export class MacroScope extends Scope {
    constructor(enclosingScope: Scope) {
        super(enclosingScope);
    }
}



export enum SymbolKind {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Function,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Variable,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Macro
}

export class Symbol {
    private type: SymbolKind;
    private scope: Scope; // all symbols know what scope contains them
    private name: string;
    private uri: URI;
    private line: number;
    private column: number;
    private _funcMacroParsed: boolean = false;

    constructor(name: string, type: SymbolKind, uri: URI, line: number, column: number) {
        this.name = name;
        this.type = type;
        this.uri = uri;
        this.line = line;
        this.column = column;
    }

    public get funcMacroParsed(): boolean {
        return this._funcMacroParsed;
    }
    public set funcMacroParsed(value: boolean) {
        this._funcMacroParsed = value;
    }

    getName() {
        return this.name;
    }

    getType() {
        return this.type;
    }

    setScope(scope: Scope) {
        this.scope = scope;
    }

    getLocation(): Location {
        return {
            uri: this.uri.toString(),
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

    getUri(): URI {
        return this.uri;
    }

    getLine(): number {
        return this.line;
    }

    getColumn(): number {
        return this.column;
    }
}
