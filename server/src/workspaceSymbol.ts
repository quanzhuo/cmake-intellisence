import { SymbolKind as LSPSymbolKind, SymbolInformation, WorkspaceSymbolParams } from "vscode-languageserver";
import { URI } from "vscode-uri";
import { isPathEqualOrInside } from "./pathUtils";
import { SymbolIndex } from "./symbolIndex";

export class WorkspaceSymbolResolver {
    private readonly workspaceFolder: URI;

    constructor(private symbolIndex: SymbolIndex, workspaceFolderUri: string) {
        this.workspaceFolder = URI.parse(workspaceFolderUri);
    }

    private isWorkspaceCache(uri: string): boolean {
        const cacheUri = URI.parse(uri);
        if (this.workspaceFolder.scheme !== 'file' || cacheUri.scheme !== 'file') {
            return false;
        }

        return isPathEqualOrInside(this.workspaceFolder.fsPath, cacheUri.fsPath);
    }

    public resolve(params: WorkspaceSymbolParams): SymbolInformation[] {
        const query = params.query.toLowerCase();
        const results: SymbolInformation[] = [];

        for (const cache of this.symbolIndex.getAllCaches()) {
            if (!this.isWorkspaceCache(cache.uri)) {
                continue;
            }

            // Search commands (functions/macros)
            for (const [name, symbols] of cache.commands.entries()) {
                if (!query || name.includes(query)) {
                    for (const sym of symbols) {
                        results.push({
                            name: sym.name,
                            kind: LSPSymbolKind.Function,
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

