import { Location } from 'vscode-languageserver-types';
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
    private uri: string;
    private line: number;
    private column: number;

    constructor(name: string, type: Type, uri: string, line: number, column: number) {
        this.name = name;
        this.type = type;
        this.uri = uri;
        this.line = line;
        this.column = column;
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
