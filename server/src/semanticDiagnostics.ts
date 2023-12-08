import { Diagnostic, DiagnosticSeverity } from "vscode-languageserver";
import { Token } from "antlr4";
import CMakeListener from "./generated/CMakeParserListener";
import { CmdCaseDiagnostics, extSettings } from "./settings";
import * as builtinCmds from './builtin-cmds.json';
import { BreakCmdContext, ContinueCmdContext, ElseCmdContext, ElseIfCmdContext, EndForeachCmdContext, EndFunctionCmdContext, EndIfCmdContext, EndMacroCmdContext, EndWhileCmdContext, LoopContext } from "./generated/CMakeParser";

export default class SemanticDiagnosticsListener extends CMakeListener {
    private diagnostics: Diagnostic[] = [];

    private checkBreakAndContinueCmd(ctx: BreakCmdContext | ContinueCmdContext): void {
        let inLoop = false;
        let node = ctx.parentCtx;
        while (true) {
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
            message: 'break and continue command must be in loop'
        });
    }

    enterBreakCmd = (ctx: BreakCmdContext): void => {
        this.checkCmdCase(ctx.start);
        this.checkBreakAndContinueCmd(ctx);
    };

    enterContinueCmd = (ctx: ContinueCmdContext): void => {
        this.checkCmdCase(ctx.start);
        this.checkBreakAndContinueCmd(ctx);
    };

    enterElseCmd = (ctx: ElseCmdContext): void => {
        this.checkCmdCase(ctx.start);
    };

    enterElseIfCmd = (ctx: ElseIfCmdContext): void => {
        this.checkCmdCase(ctx.start);
    };

    enterEndForeachCmd = (ctx: EndForeachCmdContext): void => {
        this.checkCmdCase(ctx.start);
    };

    enterEndFunctionCmd = (ctx: EndFunctionCmdContext): void => {
        this.checkCmdCase(ctx.start);
    };

    enterEndIfCmd = (ctx: EndIfCmdContext): void => {
        this.checkCmdCase(ctx.start);
    };

    enterEndMacroCmd = (ctx: EndMacroCmdContext): void => {
        this.checkCmdCase(ctx.start);
    };

    enterEndWhileCmd = (ctx: EndWhileCmdContext): void => {
        this.checkCmdCase(ctx.start);
    };

    enterForeachCmd = (ctx: any): void => {
        this.checkCmdCase(ctx.start);
    };

    enterFunctionCmd = (ctx: any): void => {
        this.checkCmdCase(ctx.start);
    };

    enterIfCmd = (ctx: any): void => {
        this.checkCmdCase(ctx.start);
    };

    enterIncludeCmd = (ctx: any): void => {
        this.checkCmdCase(ctx.start);
    };

    enterMacroCmd = (ctx: any): void => {
        this.checkCmdCase(ctx.start);
    };

    enterOptionCmd = (ctx: any): void => {
        this.checkCmdCase(ctx.start);
    };

    enterWhileCmd = (ctx: any): void => {
        this.checkCmdCase(ctx.start);
    };

    enterSetCmd = (ctx: any): void => {
        this.checkCmdCase(ctx.start);
    };

    enterOtherCmd = (ctx: any): void => {
        this.checkCmdCase(ctx.start);
    };

    checkCmdCase(token: Token) {
        const text: string = token.text;

        switch (extSettings.cmdCaseDiagnostics) {
            case CmdCaseDiagnostics.None: return;
            case CmdCaseDiagnostics.Builtin:
                if (!(text.toLowerCase() in builtinCmds)) {
                    return;
                }
                break;
            case CmdCaseDiagnostics.All:
                break;
            default:
                throw new Error("undefined cmdCaseDiagnostics settings");
        }

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
                message: cmdNameCase
            });
        }
    }

    getSemanticDiagnostics(): Diagnostic[] {
        return this.diagnostics;
    }
}

export const cmdNameCase = 'cmake encourage lower case command name';
