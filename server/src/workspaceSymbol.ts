import { SymbolKind as LSPSymbolKind, SymbolInformation, WorkspaceSymbolParams } from "vscode-languageserver";
import { SymbolIndex, SymbolKind } from "./symbolIndex";

export class WorkspaceSymbolResolver {
    constructor(private symbolIndex: SymbolIndex) { }

    public resolve(params: WorkspaceSymbolParams): SymbolInformation[] {
        const query = params.query.toLowerCase();
        const results: SymbolInformation[] = [];

        for (const cache of this.symbolIndex.getAllCaches()) {
            // Search commands (functions/macros)
            for (const [name, symbols] of cache.commands.entries()) {
                if (!query || name.includes(query)) {
                    for (const sym of symbols) {
                        results.push({
                            name: sym.name,
                            kind: sym.kind === SymbolKind.Macro ? LSPSymbolKind.Function : LSPSymbolKind.Function,
                            location: sym.getLocation()
                        });
                    }
                }
            }

            // Search variables
            for (const [name, symbols] of cache.variables.entries()) {
                if (!query || name.toLowerCase().includes(query)) {
                    for (const sym of symbols) {
                        results.push({
                            name: sym.name,
                            kind: LSPSymbolKind.Variable,
                            location: sym.getLocation()
                        });
                    }
                }
            }
        }

        return results;
    }
}

