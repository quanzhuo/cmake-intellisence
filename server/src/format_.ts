import CMakeLexer from "./parser/CMakeLexer";
import CMakeListener from "./parser/CMakeListener";
import { incToBaseDir } from "./symbolTable/goToDefination";

export class Formatter extends CMakeListener {
    private _indent: number;
    private _indentLevel: number;
    private _tokenStream: any;
    private _formatted: string;

    constructor(_indent: number, tokenStream: any) {
        super();

        this._indent = _indent;
        this._indentLevel = 0;
        this._tokenStream = tokenStream;
        this._formatted = "";
    }

    getFormatedText(): string {
        return this._formatted;
    }
    enterFile(ctx: any): void {
        for (let token of this._tokenStream.tokens) {
            if (token.channel !== CMakeLexer.HIDDEN) {
                break;
            }
            this._formatted += token.text;
        }
    }
    enterAddSubDirCmd(ctx: any): void {
        this.enterCommand("add_subdirectory", ctx);
    }
    enterContinueCmd(ctx: any): void {
        this.enterCommand("continue", ctx);
    }
    enterBreakCmd(ctx: any): void {
        this.enterCommand("break", ctx);
    }
    enterElseCmd(ctx: any): void {
        this.enterCommand("else", ctx);
    }
    enterElseIfCmd(ctx: any): void {
        this.enterCommand("elseif", ctx);
    }
    enterEndForeachCmd(ctx: any): void {
        this.enterCommand("endforeach", ctx);
    }
    enterEndFunctionCmd(ctx: any): void {
        this.enterCommand("endfunction", ctx);
    }
    enterEndIfCmd(ctx: any): void {
        this.enterCommand("endif", ctx);
    }
    enterEndMacroCmd(ctx: any): void {
        this.enterCommand("endmacro", ctx);
    }
    enterEndWhileCmd(ctx: any): void {
        this.enterCommand("endwhile", ctx);
    }
    enterFunctionCmd(ctx: any): void {
        this.enterCommand("function", ctx);
    }
    enterForeachCmd(ctx: any): void {
        this.enterCommand("foreach", ctx);
    }
    enterIfCmd(ctx: any): void {
        this.enterCommand("if", ctx);
    }
    enterIncludeCmd(ctx: any): void {
        this.enterCommand("include", ctx);
    }
    enterMacroCmd(ctx: any): void {
        this.enterCommand("macro", ctx);
    }
    enterOptionCmd(ctx: any): void {
        this.enterCommand("option", ctx);
    }
    enterSetCmd(ctx: any): void {
        this.enterCommand("set", ctx);
    }
    enterWhileCmd(ctx: any): void {
        this.enterCommand("while", ctx);
    }
    enterOtherCmd(ctx: any): void {
        const token = ctx.ID().symbol;
        this.enterCommand(ctx.ID().symbol.text, ctx);
    }

    private getIndent(): number {
        return this._indent * this._indentLevel;
    }

    private isBlockCmd(cmd: string): boolean {
        return ['if', 'elseif', 'else', 'while', 'foreach', 'function', 'macro'].includes(cmd.toLowerCase());
    }

    private isEndBlockCmd(cmd: string): boolean {
        return ['elseif', 'else', 'endif', 'endwhile', 'endforeach', 'endfunction', 'endmacro'].includes(cmd.toLowerCase());
    }

    private getHiddenTextOnRight(tokenIndex: number, indent: number): string {
        const token = this._tokenStream.get(tokenIndex);

        let result = "";
        const hiddenTokens = this._tokenStream.getHiddenTokensToRight(tokenIndex, CMakeLexer.HIDDEN);
        if (hiddenTokens === null) {
            return result;
        }

        if ((hiddenTokens.length > 0) &&
            (hiddenTokens[0].type === CMakeLexer.LineComment || hiddenTokens[0].type === CMakeLexer.BracketComment) &&
            hiddenTokens[0].line === token.line) {
            result += ' ';
        }

        // for (const t of hiddenTokens) {
        //     result += t.text;
        // }

        let prevLineNo: number = token.line;
        hiddenTokens.forEach((t, index) => {
            const curLineNo: number = t.line;
            if ((curLineNo !== prevLineNo) &&
                (t.type === CMakeLexer.LineComment || t.type === CMakeLexer.BracketComment)) {
                result += ' '.repeat(indent);
            }
            
            result += t.text;
            prevLineNo = t.line;
        });

        return result;
    }

    private getArgumentText(argCtx: any, indent: number): string {
        let result = "";
        const cnt: number = argCtx.getChildCount();
        if (cnt === 1) {
            result += argCtx.stop.text;
            result += this.getHiddenTextOnRight(argCtx.stop.tokenIndex, indent);
        } else {
            result += '(';
            const lParenIndex: number = argCtx.LParen().symbol.tokenIndex;
            result += this.getHiddenTextOnRight(lParenIndex, indent);
            const innerCnt = argCtx.argument().length;
            argCtx.argument().forEach((innerCtx, index) => {
                result += this.getArgumentText(innerCtx, indent);
                if (index < innerCnt - 1) {
                    result += ' ';
                }
            });
            result += ')';
            const rParenIndex: number = argCtx.RParen().symbol.tokenIndex;
            result += this.getHiddenTextOnRight(rParenIndex, indent);
        }

        return result;
    }

    private enterCommand(cmd: string, ctx: any) {
        if (this.isEndBlockCmd(cmd)) {
            --this._indentLevel;
            if (this._indentLevel < 0) {
                this._indentLevel = 0;
            }
        }

        // indent
        this._formatted += " ".repeat(this.getIndent());

        // the command name and '('
        this._formatted += cmd + '(';

        // comment and newline can be placed after '('
        this._formatted += this.getHiddenTextOnRight(ctx.LParen().symbol.tokenIndex,
            this.getIndent() + this._indent
        );

        // all arguments
        if (ctx.hasOwnProperty('argument')) {
            const cnt: number = ctx.argument().length;
            const indent = (this._indentLevel + 1) * this._indent;
            const cmdLineNo: number = ctx.LParen().symbol.line;
            let prevLineNo: number = cmdLineNo;
            let curLineNo: number = -1;
            ctx.argument().forEach((argCtx, index, array) => {
                curLineNo = argCtx.start.line;
                if (curLineNo !== prevLineNo) {
                    this._formatted += ' '.repeat(indent);
                }

                this._formatted += this.getArgumentText(argCtx, indent);

                const next = index + 1;
                if (next < cnt) {
                    if (array[next].start.line === curLineNo) {
                        this._formatted += ' ';
                    }
                }

                prevLineNo = curLineNo;
            });
        }

        // ')'
        this._formatted += ')';

        // get comment on right of command
        const rParenIndex: number = ctx.RParen().symbol.tokenIndex;
        this._formatted += this.getHiddenTextOnRight(rParenIndex, this.getIndent());

        // command terminator
        this._formatted += '\n';
        const newLineIndex = rParenIndex + 1;

        // consider increase or decrease indent level
        if (this.isBlockCmd(cmd)) {
            ++this._indentLevel;
        }

        // get all comments and newlines after command terminator
        this._formatted += this.getHiddenTextOnRight(newLineIndex, this.getIndent());
    }
}