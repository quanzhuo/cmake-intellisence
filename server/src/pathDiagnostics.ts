import * as fs from 'fs';
import * as path from 'path';
import { Diagnostic, DiagnosticSeverity, Range } from 'vscode-languageserver';
import { URI } from 'vscode-uri';
import { DefinitionSubject, resolveArgumentTarget } from './argumentSemantics';
import { FlatCommand } from './flatCommands';
import { ArgumentContext } from './generated/CMakeParser';
import localize from './localize';
import { PathExpressionResolver } from './pathExpressionResolver';
import { SymbolIndex } from './symbolIndex';

export const DIAG_CODE_MISSING_FILE_PATH = 'missing-file-path';
export const DIAG_CODE_MISSING_SUBDIRECTORY = 'missing-subdirectory';

interface PathDiagnosticsProviderOptions {
    symbolIndex: SymbolIndex;
    entryFile: URI;
    sourceUri: URI;
    getFlatCommands: (uri: string) => Promise<FlatCommand[]>;
}

export class PathDiagnosticsProvider {
    private readonly resolver: PathExpressionResolver;
    private readonly subdirectoryExistsCache = new Map<string, boolean>();

    constructor(private readonly options: PathDiagnosticsProviderOptions) {
        this.resolver = new PathExpressionResolver({
            symbolIndex: options.symbolIndex,
            getFlatCommands: options.getFlatCommands,
            entryFile: options.entryFile,
        });
    }

    public async getDiagnostics(commands: FlatCommand[]): Promise<Diagnostic[]> {
        const diagnostics: Diagnostic[] = [];

        for (const command of commands) {
            diagnostics.push(...await this.getCommandDiagnostics(command));
        }

        return diagnostics;
    }

    private async getCommandDiagnostics(command: FlatCommand): Promise<Diagnostic[]> {
        switch (command.commandName.toLowerCase()) {
            case 'include':
                return this.getIncludeDiagnostics(command);
            case 'add_subdirectory':
                return this.getAddSubdirectoryDiagnostics(command);
            case 'configure_file':
                return this.getConfigureFileDiagnostics(command);
            case 'add_library':
            case 'add_executable':
                return this.getSourceArgumentDiagnostics(command);
            default:
                return [];
        }
    }

    private createDiagnostic(argCtx: ArgumentContext, severity: DiagnosticSeverity, message: string, code: string): Diagnostic {
        const argText = argCtx.getText();
        const endLine = (argCtx.stop?.line ?? argCtx.start.line) - 1;
        const endCharacter = (argCtx.stop?.column ?? argCtx.start.column) + argText.length;

        return {
            range: Range.create(argCtx.start.line - 1, argCtx.start.column, endLine, endCharacter),
            severity,
            source: 'cmake-intellisence',
            message,
            code,
        };
    }

    private getPathArgument(command: FlatCommand, argIndex: number): { argCtx: ArgumentContext; argText: string } | null {
        const argCtx = command.argument_list()[argIndex];
        if (!argCtx) {
            return null;
        }

        const resolved = resolveArgumentTarget(command, argIndex);
        if (!resolved || resolved.subject !== DefinitionSubject.FilePath) {
            return null;
        }

        return { argCtx, argText: resolved.text };
    }

    private createRequest(commandName: string, argText: string, argCtx: ArgumentContext) {
        return {
            commandName,
            argText,
            sourceUri: this.options.sourceUri,
            maxLine: argCtx.start.line - 1,
        };
    }

    private isLikelySourcePath(expandedPath: string): boolean {
        return expandedPath.includes('/') || expandedPath.includes('\\') || path.extname(expandedPath) !== '';
    }

    private async getIncludeDiagnostics(command: FlatCommand): Promise<Diagnostic[]> {
        const pathArgument = this.getPathArgument(command, 0);
        if (!pathArgument) {
            return [];
        }

        const result = await this.resolver.resolveFileRequestDetailed(
            this.createRequest(command.commandName.toLowerCase(), pathArgument.argText, pathArgument.argCtx),
        );
        if (result.reason !== 'missing-file' || !result.expandedPath) {
            return [];
        }

        return [this.createDiagnostic(
            pathArgument.argCtx,
            DiagnosticSeverity.Warning,
            localize('diagnostics.missingFilePath', result.expandedPath),
            DIAG_CODE_MISSING_FILE_PATH,
        )];
    }

    private async getConfigureFileDiagnostics(command: FlatCommand): Promise<Diagnostic[]> {
        const pathArgument = this.getPathArgument(command, 0);
        if (!pathArgument) {
            return [];
        }

        const result = await this.resolver.resolveFileRequestDetailed(
            this.createRequest(command.commandName.toLowerCase(), pathArgument.argText, pathArgument.argCtx),
        );
        if (result.reason !== 'missing-file' || !result.expandedPath) {
            return [];
        }

        return [this.createDiagnostic(
            pathArgument.argCtx,
            DiagnosticSeverity.Warning,
            localize('diagnostics.missingConfigureInput', result.expandedPath),
            DIAG_CODE_MISSING_FILE_PATH,
        )];
    }

    private async getSourceArgumentDiagnostics(command: FlatCommand): Promise<Diagnostic[]> {
        const diagnostics: Diagnostic[] = [];
        const args = command.argument_list();

        for (let index = 1; index < args.length; index++) {
            const pathArgument = this.getPathArgument(command, index);
            if (!pathArgument) {
                continue;
            }

            const result = await this.resolver.resolveFileRequestDetailed(
                this.createRequest(command.commandName.toLowerCase(), pathArgument.argText, pathArgument.argCtx),
            );
            if (result.reason !== 'missing-file' || !result.expandedPath || !this.isLikelySourcePath(result.expandedPath)) {
                continue;
            }

            diagnostics.push(this.createDiagnostic(
                pathArgument.argCtx,
                DiagnosticSeverity.Warning,
                localize('diagnostics.missingSourceFile', result.expandedPath),
                DIAG_CODE_MISSING_FILE_PATH,
            ));
        }

        return diagnostics;
    }

    private async getAddSubdirectoryDiagnostics(command: FlatCommand): Promise<Diagnostic[]> {
        const pathArgument = this.getPathArgument(command, 0);
        if (!pathArgument) {
            return [];
        }

        const expanded = await this.resolver.expandPathExpressionDetailed(
            this.createRequest(command.commandName.toLowerCase(), pathArgument.argText, pathArgument.argCtx),
        );
        if (expanded.reason !== 'resolved' || !expanded.expandedPath) {
            return [];
        }

        const cmakeListsPath = path.isAbsolute(expanded.expandedPath)
            ? path.join(path.normalize(expanded.expandedPath), 'CMakeLists.txt')
            : path.resolve(path.dirname(this.options.sourceUri.fsPath), expanded.expandedPath, 'CMakeLists.txt');

        if (this.directoryHasCMakeLists(cmakeListsPath)) {
            return [];
        }

        return [this.createDiagnostic(
            pathArgument.argCtx,
            DiagnosticSeverity.Warning,
            localize('diagnostics.missingSubdirectory', expanded.expandedPath),
            DIAG_CODE_MISSING_SUBDIRECTORY,
        )];
    }

    private directoryHasCMakeLists(cmakeListsPath: string): boolean {
        const cached = this.subdirectoryExistsCache.get(cmakeListsPath);
        if (cached !== undefined) {
            return cached;
        }

        const exists = fs.existsSync(cmakeListsPath) && !fs.statSync(cmakeListsPath).isDirectory();
        this.subdirectoryExistsCache.set(cmakeListsPath, exists);
        return exists;
    }
}