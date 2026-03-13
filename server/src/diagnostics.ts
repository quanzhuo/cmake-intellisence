import { ErrorListener, RecognitionException, Recognizer, Token } from "antlr4";
import { Diagnostic, DiagnosticSeverity } from "vscode-languageserver";
import { FlatCommand } from "./flatCommands";
import { BreakCmdContext, ContinueCmdContext, ForeachLoopContext, WhileLoopContext } from "./generated/CMakeParser";
import CMakeListener from "./generated/CMakeParserListener";
import localize from "./localize";
import { SymbolIndex } from "./symbolIndex";

export const DIAG_CODE_CMD_CASE = 0;

export class SyntaxErrorListener extends ErrorListener<Token> {
    private diagnostics: Diagnostic[] = [];

    /**
     * 
     * @param recognizer 
     * @param offendingSymbol 
     * @param line start from 1
     * @param column start from 0
     * @param msg 
     * @param e 
     */
    syntaxError(recognizer: Recognizer<Token>, offendingSymbol: Token, line: number, column: number, msg: string, e: RecognitionException | undefined): void {
        this.diagnostics.push({
            range: {
                start: {
                    line: line - 1,
                    character: column
                },
                end: {
                    line: line - 1,
                    character: column + offendingSymbol.text.length
                }
            },
            severity: DiagnosticSeverity.Error,
            source: 'cmake-intellisence',
            message: msg
        });
    }

    public getSyntaxErrors(): Diagnostic[] {
        return this.diagnostics;
    }

    public clearSyntaxErrors() {
        this.diagnostics = [];
    }
}

export default class SemanticDiagnosticsListener extends CMakeListener {
    private diagnostics: Diagnostic[] = [];

    private checkBreakAndContinueCmd(ctx: BreakCmdContext | ContinueCmdContext): void {
        let inLoop = false;
        let node = ctx.parentCtx;
        while (node) {
            if (node instanceof WhileLoopContext || node instanceof ForeachLoopContext) {
                inLoop = true;
                break;
            }
            node = node.parentCtx;
        }

        if (inLoop) {
            return;
        }

        const token = ctx.start;
        const line = token.line - 1, column = token.column;
        this.diagnostics.push({
            range: {
                start: {
                    line,
                    character: column
                },
                end: {
                    line,
                    character: column + token.text.length
                }
            },
            severity: DiagnosticSeverity.Error,
            source: 'cmake-intellisence',
            message: localize('diagnostics.breakContinue', token.text),
        });
    }

    enterBreakCmd = (ctx: BreakCmdContext): void => {
        this.checkBreakAndContinueCmd(ctx);
    };

    enterContinueCmd = (ctx: ContinueCmdContext): void => {
        this.checkBreakAndContinueCmd(ctx);
    };

    getSemanticDiagnostics(): Diagnostic[] {
        return this.diagnostics;
    }
}

export class CommandCaseChecker {
    private diagnostics: Diagnostic[] = [];
    private commands: Set<string>;

    constructor(
        symbolIndex: SymbolIndex,
    ) {
        this.commands = new Set(symbolIndex.getSystemCache().commands.keys());
    }

    check(flatCommands: FlatCommand[]): void {
        for (const cmd of flatCommands) {
            const token = cmd.start;
            const command: string = token.text;
            const lowerCaseCommand = command.toLowerCase();
            if (!this.commands.has(lowerCaseCommand)) {
                continue;
            }
            const line: number = token.line, column: number = token.column;
            const isLowerCase = lowerCaseCommand === command;
            if (!isLowerCase) {
                this.diagnostics.push({
                    range: {
                        start: {
                            line: line - 1,
                            character: column
                        },
                        end: {
                            line: line - 1,
                            character: column + command.length
                        }
                    },
                    severity: DiagnosticSeverity.Information,
                    source: 'cmake-intellisence',
                    message: localize('diagnostics.cmdCase'),
                    code: DIAG_CODE_CMD_CASE,
                });
            }
        }
    }

    getCmdCaseDiagnostics(): Diagnostic[] {
        return this.diagnostics;
    }
}
