import { Location } from 'vscode-languageserver-types';
import { URI } from 'vscode-uri';
import { Scope } from './scope';

export enum Type {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Function,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Variable,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Macro
}

export class Sym {
    private type: Type;
    private scope: Scope; // all symbols know what scope contains them
    private name: string;
    private uri: URI;
    private line: number;
    private column: number;
    private _funcMacroParsed: boolean = false;

    constructor(name: string, type: Type, uri: URI, line: number, column: number) {
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
