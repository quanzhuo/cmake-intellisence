import { Sym, Type } from './symbol';
export class Scope {
    private enclosingScope: Scope;
    private variables: Map<string, Sym>;
    private commands: Map<string, Sym>;

    constructor(enclosingScope: Scope) {
        this.enclosingScope = enclosingScope;
        this.variables = new Map<string, Sym>();
        this.commands = new Map<string, Sym>();
    }

    resolve(name: string, type: Type): Sym {
        const symbols = type === Type.Variable ? this.variables : this.commands;
        const s = symbols.get(name);
        if (s !== undefined) {
            return s;
        }

        if (this.enclosingScope) {
            return this.enclosingScope.resolve(name, type);
        }

        return null;
    }

    define(symbol: Sym): void {
        if (symbol.getType() === Type.Variable) {
            this.variables.set(symbol.getName(), symbol);
        } else {
            this.commands.set(symbol.getName(), symbol);
        }

        symbol.setScope(this);
    }

    getEnclosingScope(): Scope {
        return this.enclosingScope;
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
