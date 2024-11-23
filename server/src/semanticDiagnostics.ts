import { Diagnostic, DiagnosticSeverity } from "vscode-languageserver";
import { DIAG_CODE_CMD_CASE } from "./consts";
import { BreakCmdContext, ContinueCmdContext, LoopContext } from "./generated/CMakeParser";
import CMakeListener from "./generated/CMakeParserListener";
import * as csp from './generated/CMakeSimpleParser';
import CMakeSimpleParserListener from "./generated/CMakeSimpleParserListener";
import localize from "./localize";

export default class SemanticDiagnosticsListener extends CMakeListener {
    private diagnostics: Diagnostic[] = [];

    private checkBreakAndContinueCmd(ctx: BreakCmdContext | ContinueCmdContext): void {
        let inLoop = false;
        let node = ctx.parentCtx;
        while (node) {
            if (node instanceof LoopContext) {
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

export class CommandCaseChecker extends CMakeSimpleParserListener {
    private diagnostics: Diagnostic[] = [];

    enterCommand?: (ctx: csp.CommandContext) => void = (ctx: csp.CommandContext) => {
        const token = ctx.start;
        const text: string = token.text;
        const line: number = token.line, column: number = token.column;
        const isLowerCase = ((cmdText: string) => {
            for (const ch of cmdText) {
                if (ch.toLowerCase() !== ch) {
                    return false;
                }
            }
            return true;
        })(text);

        if (!isLowerCase) {
            this.diagnostics.push({
                range: {
                    start: {
                        line: line - 1,
                        character: column
                    },
                    end: {
                        line: line - 1,
                        character: column + text.length
                    }
                },
                severity: DiagnosticSeverity.Information,
                source: 'cmake-intellisence',
                message: localize('diagnostics.cmdCase'),
                code: DIAG_CODE_CMD_CASE,
            });
        }
    };

    getCmdCaseDdiagnostics(): Diagnostic[] {
        return this.diagnostics;
    }
}
