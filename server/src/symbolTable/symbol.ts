enum Type {
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Function,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Variable,
    // eslint-disable-next-line @typescript-eslint/naming-convention
    Macro
}

class Sym {
    private type: Type;
    private scope: Scope; // all symbols know what scope contains them
    private name: string;

    constructor(name: string, type: Type) {
        this.name = name;
        this.type = type;
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
}