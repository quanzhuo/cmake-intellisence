import * as fs from 'fs';
import * as path from 'path';
import { URI } from 'vscode-uri';
import { FlatCommand } from './flatCommands';
import { SymbolIndex } from './symbolIndex';

export interface PathExpressionResolverOptions {
    symbolIndex: SymbolIndex;
    getFlatCommands: (uri: string) => Promise<FlatCommand[]>;
    entryFile: URI;
}

export class PathExpressionResolver {
    constructor(private readonly options: PathExpressionResolverOptions) {
    }

    private getKnownPathVariableValue(name: string, sourceUri: URI): string | null {
        const sourceDir = path.dirname(sourceUri.fsPath);
        const rootDir = path.dirname(this.options.entryFile.fsPath);

        switch (name) {
            case 'CMAKE_CURRENT_LIST_DIR':
            case 'CMAKE_CURRENT_SOURCE_DIR':
                return sourceDir;
            case 'CMAKE_SOURCE_DIR':
            case 'PROJECT_SOURCE_DIR':
                return rootDir;
            default:
                return null;
        }
    }

    private normalizeSetValue(argText: string): string {
        if ((argText.startsWith('"') && argText.endsWith('"')) ||
            (argText.startsWith("'") && argText.endsWith("'"))) {
            return argText.slice(1, -1);
        }

        return argText;
    }

    private getSimpleSetValue(command: FlatCommand): string | null {
        if (command.commandName.toLowerCase() !== 'set') {
            return null;
        }

        const args = command.argument_list();
        if (args.length !== 2) {
            return null;
        }

        const value = args[1]?.getText();
        return value ? this.normalizeSetValue(value) : null;
    }

    private async resolveVariableValue(
        variableName: string,
        sourceUri: URI,
        maxLine: number,
        seen: Set<string>,
        depth: number,
    ): Promise<string | null> {
        const recursionKey = `${sourceUri.toString()}::${variableName}`;
        if (seen.has(recursionKey)) {
            return null;
        }

        seen.add(recursionKey);
        try {
            const visibleFiles = this.options.symbolIndex.getVisibleFilesForVariable(this.options.entryFile.toString(), sourceUri.toString());
            if (!visibleFiles.includes(sourceUri.toString())) {
                visibleFiles.push(sourceUri.toString());
            }

            for (let fileIndex = visibleFiles.length - 1; fileIndex >= 0; fileIndex--) {
                const candidateUri = visibleFiles[fileIndex];
                const commands = await this.options.getFlatCommands(candidateUri);
                for (let commandIndex = commands.length - 1; commandIndex >= 0; commandIndex--) {
                    const candidate = commands[commandIndex];
                    if (candidate.commandName.toLowerCase() !== 'set') {
                        continue;
                    }

                    if (candidateUri === sourceUri.toString() && candidate.start.line - 1 > maxLine) {
                        continue;
                    }

                    const args = candidate.argument_list();
                    if (args[0]?.getText() !== variableName) {
                        continue;
                    }

                    const value = this.getSimpleSetValue(candidate);
                    if (!value) {
                        continue;
                    }

                    return this.expandPathVariables(
                        value,
                        URI.parse(candidateUri),
                        candidate.start.line - 1,
                        seen,
                        depth + 1,
                    );
                }
            }

            return null;
        } finally {
            seen.delete(recursionKey);
        }
    }

    public async expandPathVariables(
        argText: string,
        sourceUri: URI,
        maxLine: number,
        seen: Set<string> = new Set(),
        depth = 0,
    ): Promise<string | null> {
        if (depth > 8) {
            return null;
        }

        const matches = Array.from(argText.matchAll(/\$\{([^}]+)\}/g));
        if (matches.length === 0) {
            return path.normalize(argText);
        }

        let expanded = argText;
        for (const match of matches) {
            const placeholder = match[0];
            const variableName = match[1];
            const replacement = this.getKnownPathVariableValue(variableName, sourceUri)
                ?? await this.resolveVariableValue(variableName, sourceUri, maxLine, seen, depth + 1);

            if (!replacement) {
                return null;
            }

            expanded = expanded.replace(placeholder, replacement);
        }

        if (expanded.includes('${')) {
            return this.expandPathVariables(expanded, sourceUri, maxLine, seen, depth + 1);
        }

        return path.normalize(expanded);
    }

    public resolveExpandedFile(argText: string, sourceUri: URI): URI | null {
        const target = path.isAbsolute(argText)
            ? URI.file(path.normalize(argText))
            : URI.file(path.resolve(path.dirname(sourceUri.fsPath), argText));

        if (!fs.existsSync(target.fsPath) || fs.statSync(target.fsPath).isDirectory()) {
            return null;
        }

        return target;
    }

    public async resolveFileExpression(argText: string, sourceUri: URI, maxLine: number): Promise<URI | null> {
        const expanded = await this.expandPathVariables(argText, sourceUri, maxLine);
        if (!expanded) {
            return null;
        }

        return this.resolveExpandedFile(expanded, sourceUri);
    }
}