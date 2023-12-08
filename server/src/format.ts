import { CommonTokenStream } from "antlr4";
import CMakeLexer from "./generated/CMakeLexer";
import { AddSubDirectoryCmdContext, ArgumentContext, BreakCmdContext, CommandContext, ContinueCmdContext, ControlBodyContext, ElseCmdContext, ElseIfCmdContext, EndForeachCmdContext, EndFunctionCmdContext, EndIfCmdContext, EndMacroCmdContext, EndWhileCmdContext, FileContext, ForeachCmdContext, ForeachLoopContext, FunctionCmdContext, IfCmdContext, IncludeCmdContext, MacroCmdContext, NewLineContext, OptionCmdContext, OtherCmdContext, SetCmdContext, WhileCmdContext } from "./generated/CMakeParser";
import CMakeListener from "./generated/CMakeParserListener";
import { EOL } from "os";

enum Channel {
    DEFAULT_TOKEN_CHANNEL,
    HIDDEN,
    COMMENTS,
}

export class Formatter extends CMakeListener {
    private _indent: number;
    private _indentLevel: number;
    private _tokenStream: CommonTokenStream;
    private _formatted: string;

    constructor(_indent: number, tokenStream: CommonTokenStream) {
        super();

        this._indent = _indent;
        this._indentLevel = 0;
        this._tokenStream = tokenStream;
        this._formatted = "";
    }

    get indent(): number {
        return this._indent * this._indentLevel;
    }

    get formatted(): string {
        return this._formatted;
    }

    enterFile = (ctx: FileContext): void => {
        // get all comments and newlines before first command
        for (const token of this._tokenStream.tokens) {
            if (token.channel === Channel.DEFAULT_TOKEN_CHANNEL) {
                break;
            }

            this._formatted += token.text;
        }
    };

    enterForeachCmd = (ctx: ForeachCmdContext): void => {
    };

    enterControlBody = (ctx: ControlBodyContext): void => {
        ++this._indentLevel;
    };

    exitControlBody = (ctx: ControlBodyContext): void => {
        --this._indentLevel;
        if (this._indentLevel < 0) {
            this._indentLevel = 0;
        }
    };

    enterIfCmd = (ctx: IfCmdContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterElseIfCmd = (ctx: ElseIfCmdContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterElseCmd = (ctx: ElseCmdContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterEndIfCmd = (ctx: EndIfCmdContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterForeachLoop = (ctx: ForeachLoopContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterEndForeachCmd = (ctx: EndForeachCmdContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterWhileCmd = (ctx: WhileCmdContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterEndWhileCmd = (ctx: EndWhileCmdContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterMacroCmd = (ctx: MacroCmdContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterEndMacroCmd = (ctx: EndMacroCmdContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterFunctionCmd = (ctx: FunctionCmdContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterEndFunctionCmd = (ctx: EndFunctionCmdContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterBreakCmd = (ctx: BreakCmdContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterContinueCmd = (ctx: ContinueCmdContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterSetCmd = (ctx: SetCmdContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterOptionCmd = (ctx: OptionCmdContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterIncludeCmd = (ctx: IncludeCmdContext) => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterAddSubDirectoryCmd = (ctx: AddSubDirectoryCmdContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterOtherCmd = (ctx: OtherCmdContext): void => {
        this.formatCommand(ctx.start.text, ctx);
    };

    enterNewLine = (ctx: NewLineContext): void => {
        this._formatted += EOL;
    };

    // enterCommand?: (ctx: CommandContext) => void = (ctx: CommandContext) => {
    //     // this.formatCommand(ctx.start.text, ctx);
    //     console.log(`enterCommand: ${ctx.stop.text}`);
    // };

    private getComentsAndNLOnRight(tokenIndex: number, indent: number): string {
        const token = this._tokenStream.get(tokenIndex);

        let result = "";
        const hiddenTokens = this._tokenStream.getHiddenTokensToRight(tokenIndex, -1);
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

    private getArgumentText(argCtx: ArgumentContext, indent: number): string {
        let result = "";
        const cnt: number = argCtx.getChildCount();
        if (cnt === 1) {
            result += argCtx.stop.text;
            result += this.getComentsAndNLOnRight(argCtx.stop.tokenIndex, indent);
        } else {
            result += '(';
            const lParenIndex: number = argCtx.LP().symbol.tokenIndex;
            result += this.getComentsAndNLOnRight(lParenIndex, indent);
            const innerCnt = argCtx.argument_list().length;
            const innerIndent = indent + this._indent;
            let prevLineNo: number = argCtx.LP().symbol.line;
            argCtx.argument_list().forEach((innerCtx, index) => {
                const curLineNo: number = innerCtx.stop.line;
                if (curLineNo !== prevLineNo) {
                    result += ' '.repeat(innerIndent);
                }
                result += this.getArgumentText(innerCtx, indent);
                if (index < innerCnt - 1) {
                    result += ' ';
                }

                prevLineNo = curLineNo;
            });

            const rParenToken = argCtx.RP().symbol;
            if ((innerCnt > 0) &&
                (argCtx.argument_list()[innerCnt - 1].stop.line !== rParenToken.line)) {
                result += ' '.repeat(indent);
            }

            result += ')';
            result += this.getComentsAndNLOnRight(rParenToken.tokenIndex, indent);
        }

        return result;
    }

    private formatCommand(cmd: string, ctx: any) {
        // indent
        this._formatted += " ".repeat(this.indent);

        // the command name and '('
        this._formatted += cmd + '(';

        // comment and newline can be placed after '('e
        this._formatted += this.getComentsAndNLOnRight(ctx.LP().symbol.tokenIndex,
            this.indent + this._indent
        );

        // all arguments
        if (ctx.argument_list !== undefined) {
            const cnt: number = ctx.argument_list().length;
            const indent = (this._indentLevel + 1) * this._indent;
            const cmdLineNo: number = ctx.LP().symbol.line;
            let prevLineNo: number = cmdLineNo;
            let curLineNo: number = -1;
            ctx.argument_list().forEach((argCtx, index, array) => {
                curLineNo = argCtx.start.line;
                if (curLineNo !== prevLineNo) {
                    this._formatted += ' '.repeat(indent);
                }

                this._formatted += this.getArgumentText(argCtx, indent);

                const next = index + 1;
                if (next < cnt) {
                    if (array[next].start.line === argCtx.stop.line) {
                        this._formatted += ' ';
                    }
                }

                prevLineNo = argCtx.stop.line;
            });
        }

        // ')'
        const rParenToken = ctx.RP().symbol;
        const rParenIndex = rParenToken.tokenIndex;
        const prevToken = this._tokenStream.get(rParenIndex - 1);
        if (rParenToken.line !== prevToken.line) {
            this._formatted += ' '.repeat(this.indent);
        }
        this._formatted += ')';

        // get comment on right of command
        this._formatted += this.getComentsAndNLOnRight(rParenIndex, this.indent);

        // command terminator
        this._formatted += '\n';
        const newLineIndex = rParenIndex + 1;

        // get all comments and newlines after command terminator
        this._formatted += this.getComentsAndNLOnRight(newLineIndex, this.indent);
    }
}
