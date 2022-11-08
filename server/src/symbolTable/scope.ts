
class Scope {
    private enclosingScope: Scope;
    private symbols: Map<string, Sym>;

    constructor(enclosingScope: Scope) {
        this.enclosingScope = enclosingScope;
        this.symbols = new Map<string, Sym>();
    }

    resolve(name: string): Sym {
        const s = this.symbols.get(name);
        if (s !== undefined) {
            return s;
        }

        if (this.enclosingScope) {
            return this.enclosingScope.resolve(name);
        }

        return null;
    }

    define(symbol: Sym): void {
        this.symbols.set(symbol.getName(), symbol);
        symbol.setScope(this);
    }

    getEnclosingScope(): Scope {
        return this.enclosingScope;
    }

    // toString(): string {
    //     return getScope
    // }
}
 
class FileScope extends Scope {
    constructor(encolsingScope: Scope) {
        super(encolsingScope);
    }
}

class FunctionScope extends Scope {
    constructor(enclosingScope: Scope) {
        super(enclosingScope);
    }
}