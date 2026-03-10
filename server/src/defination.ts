import { DefinitionParams, Location, LocationLink } from "vscode-languageserver";
import { DestinationType, SymbolResolverBase } from "./symbolResolverBase";

export { DestinationType };

export class DefinitionResolver extends SymbolResolverBase {

    public resolve(params: DefinitionParams): Promise<Location | Location[] | LocationLink[] | null> {
        const document = this.documents.get(params.textDocument.uri);
        if (!document) {
            return Promise.resolve(null);
        }

        const targetWord = this.getTargetWord(document, params.position);
        if (!targetWord) {
            return Promise.resolve(null);
        }

        this.determineContextAndRoot();

        const isCommand = this.isQueryingCommand(this.command, targetWord, params.position);
        const searchName = isCommand ? targetWord.toLowerCase() : targetWord;

        if (isCommand) {
            if (this.isBuiltinCommand(searchName)) {
                return Promise.resolve(null);
            }
        }

        const results: Location[] = [];

        if (isCommand) {
            // CMake functions & macros are broadly globally available once executed.
            for (const cache of this.symbolIndex.getAllCaches()) {
                const symbols = cache.commands.get(searchName);
                if (symbols) {
                    results.push(...symbols.map(s => s.getLocation()));
                }
            }
        } else {
            // Variables use dynamic scoping paths
            const visibleFiles = this.getVisibleFilesForVariable(this.entryFile.toString(), this.curFile.toString());
            // If current file wasn't reachable from root, at least check current file itself
            if (!visibleFiles.includes(this.curFile.toString())) {
                visibleFiles.push(this.curFile.toString());
            }

            for (const uri of visibleFiles) {
                const cache = this.symbolIndex.getCache(uri);
                if (cache) {
                    const symbols = cache.variables.get(searchName);
                    if (symbols) {
                        // Do not jump to variable assignments that appear after current line in same file!
                        const validSymbols = uri === this.curFile.toString()
                            ? symbols.filter(s => s.line <= params.position.line)
                            : symbols;
                        this.logger.info(`Found valid symbols for ${searchName} in ${uri}: ${validSymbols.length}`);
                        results.push(...validSymbols.map(s => s.getLocation()));
                    }
                }
            }

            // To be accurate and helpful, reverse the array so the "closest" lexical definitions show up first
            results.reverse();
        }

        this.logger.info(`Returning ${results.length} results for ${searchName}`);
        return Promise.resolve(results.length > 0 ? results : null);
    }

    /**
     * Returns the array of file URIs whose variables are visible from the targetUri
     * precisely simulating CMake's dynamic scoping (include vs add_subdirectory).
     */
    private getVisibleFilesForVariable(startUri: string, targetUri: string): string[] {
        let resultPath: string[] | null = null;
        const visited = new Set<string>();

        const simulateExecution = (currentUri: string, visibleFiles: string[]): boolean => {
            if (visited.has(currentUri)) {
                // If we've seen it, don't execute full depth again, but
                // in true CMake we might execute includes multiple times.
                // For Symbol indexing, it's safer to avoid infinite loops.
                return false;
            }
            visited.add(currentUri);

            visibleFiles.push(currentUri);

            if (currentUri === targetUri) {
                // Target found. Also include files that the target itself includes
                // since they are logically part of the same scope.
                const targetCache = this.symbolIndex.getCache(currentUri);
                if (targetCache) {
                    const gatherIncludes = (u: string) => {
                        const c = this.symbolIndex.getCache(u);
                        if (!c) { return; }
                        for (const dep of c.dependencies) {
                            if (dep.type === "include" && !visited.has(dep.uri)) {
                                visited.add(dep.uri);
                                visibleFiles.push(dep.uri);
                                gatherIncludes(dep.uri);
                            }
                        }
                    };
                    gatherIncludes(currentUri);
                }

                resultPath = [...visibleFiles];
                return true;
            }

            const cache = this.symbolIndex.getCache(currentUri);
            if (!cache) { return false; }

            for (const dep of cache.dependencies) {
                if (dep.type === "include") {
                    // include: mutates the current scope exactly like in-place replacement
                    if (simulateExecution(dep.uri, visibleFiles)) {
                        return true;
                    }
                } else {
                    // add_subdirectory: duplicates the scope downwards, variables block at return
                    const childScope = [...visibleFiles];
                    if (simulateExecution(dep.uri, childScope)) {
                        return true;
                    }
                }
            }

            return false;
        };

        simulateExecution(startUri, []);
        this.logger.info(`Visible files for ${targetUri} starting from ${startUri}:\n${JSON.stringify(resultPath, null, 2)}`);
        return resultPath || [];
    }
}

