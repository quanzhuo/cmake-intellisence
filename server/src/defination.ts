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
            const candidateFiles = this.symbolIndex.getReachableFiles(this.entryFile.toString());
            if (!candidateFiles.includes(this.curFile.toString())) {
                candidateFiles.push(this.curFile.toString());
            }

            // CMake functions & macros are broadly globally available once executed within the same entry tree.
            for (const uri of candidateFiles) {
                const cache = this.symbolIndex.getCache(uri);
                if (!cache) {
                    continue;
                }
                const symbols = cache.commands.get(searchName);
                if (symbols) {
                    results.push(...symbols.map(s => s.getLocation()));
                }
            }
        } else {
            // Variables use dynamic scoping paths
            const visibleFiles = this.symbolIndex.getVisibleFilesForVariable(this.entryFile.toString(), this.curFile.toString());
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
}

