import { Diagnostic, DiagnosticSeverity } from "vscode-languageserver";
import Token from "./parser/antlr4/Token";
import CMakeListener from "./parser/CMakeListener";

export default class SemanticDiagnosticsListener extends CMakeListener {
    private diagnostics: Diagnostic[] = [];

    enterAddSubDirCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterBreakCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterContinueCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterElseCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterElseIfCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterEndForeachCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterEndFunctionCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterEndIfCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterEndMacroCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterEndWhileCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterForeachCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterFunctionCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterIfCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterIncludeCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterMacroCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterOptionCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterWhileCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterSetCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    enterOtherCmd(ctx: any): void {
        this.checkCmdCase(ctx.start);
    }

    checkCmdCase(token: Token) {
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
                message: "cmake encourage lower case command name"
            });
        }
    }

    getSemanticDiagnostics(): Diagnostic[] {
        return this.diagnostics;
    }
}