import { CommonTokenStream } from "antlr4";
import CMakeSimpleLexer from "./generated/CMakeSimpleLexer";
import { CommandContext, FileContext } from "./generated/CMakeSimpleParser";
import CMakeSimpleParserListener from "./generated/CMakeSimpleParserListener";

export class Formatter extends CMakeSimpleParserListener {
    private _indent: number;
    private _indentLevel: number;
    private _tokenStream: CommonTokenStream;
    private _formatted: string;
    private hiddenChannel = CMakeSimpleLexer.channelNames.indexOf("HIDDEN");
    private commentsChannel = CMakeSimpleLexer.channelNames.indexOf("COMMENTS");

    constructor(_indent: number, tokenStream: any) {
        super();

        this._indent = _indent;
        this._indentLevel = 0;
        this._tokenStream = tokenStream;
        this._formatted = "";
    }

    get formatted(): string {
        return this._formatted;
    }

    enterFile = (ctx: FileContext) => {
        for (let token of this._tokenStream.tokens) {
            if (token.channel !== this.hiddenChannel && token.channel !== this.commentsChannel) {
                break;
            }
            this._formatted += token.text;
        }
    };


    enterCommand = (ctx: CommandContext) => {
        const cmd = ctx.start.text;

        if (this.isEndCommandGroupCmd(cmd)) {
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
        const cnt: number = ctx.argument_list().length;
        const indent = (this._indentLevel + 1) * this._indent;
        const cmdLineNo: number = ctx.LParen().symbol.line;
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

        // ')'
        const rParenToken = ctx.RParen().symbol;
        const rParenIndex = rParenToken.tokenIndex;
        const prevToken = this._tokenStream.get(rParenIndex - 1);
        if (rParenToken.line !== prevToken.line) {
            this._formatted += ' '.repeat(this.getIndent());
        }
        this._formatted += ')';

        // get comment on right of command
        this._formatted += this.getHiddenTextOnRight(rParenIndex, this.getIndent());

        // command terminator
        this._formatted += '\n';
        const newLineIndex = rParenIndex + 1;

        // consider increase or decrease indent level
        if (this.isCommandGroupCmd(cmd)) {
            ++this._indentLevel;
        }

        // get all comments and newlines after command terminator
        this._formatted += this.getHiddenTextOnRight(newLineIndex, this.getIndent());
    };

    private getIndent(): number {
        return this._indent * this._indentLevel;
    }

    private isCommandGroupCmd(cmd: string): boolean {
        return ['if', 'elseif', 'else', 'while', 'foreach', 'function', 'macro', 'block'].includes(cmd.toLowerCase());
    }

    private isEndCommandGroupCmd(cmd: string): boolean {
        return ['elseif', 'else', 'endif', 'endwhile', 'endforeach', 'endfunction', 'endmacro', 'endblock'].includes(cmd.toLowerCase());
    }

    private getHiddenTextOnRight(tokenIndex: number, indent: number): string {
        const token = this._tokenStream.get(tokenIndex);

        let result = "";
        // set channelIndex = -1 to get any non-default channel tokens
        const hiddenTokens = this._tokenStream.getHiddenTokensToRight(tokenIndex, -1);
        if (hiddenTokens === null) {
            return result;
        }

        if ((hiddenTokens.length > 0) &&
            (hiddenTokens[0].type === CMakeSimpleLexer.LineComment || hiddenTokens[0].type === CMakeSimpleLexer.BracketComment) &&
            hiddenTokens[0].line === token.line) {
            result += ' ';
        }

        let prevLineNo: number = token.line;
        hiddenTokens.forEach((t, index) => {
            const curLineNo: number = t.line;
            if ((curLineNo !== prevLineNo) &&
                (t.type === CMakeSimpleLexer.LineComment || t.type === CMakeSimpleLexer.BracketComment)) {
                result += ' '.repeat(indent);
            }

            result += t.text;
            prevLineNo = t.line;
        });

        return result;
    }

    private getArgumentText(argCtx: CommandContext, indent: number): string {
        let result = "";
        const cnt: number = argCtx.getChildCount();
        if (cnt === 1) {
            result += argCtx.stop.text;
            result += this.getHiddenTextOnRight(argCtx.stop.tokenIndex, indent);
        } else {
            result += '(';
            const lParenIndex: number = argCtx.LParen().symbol.tokenIndex;
            result += this.getHiddenTextOnRight(lParenIndex, indent);
            const innerCnt = argCtx.argument_list().length;
            const innerIndent = indent + this._indent;
            let prevLineNo: number = argCtx.LParen().symbol.line;
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

            const rParenToken = argCtx.RParen().symbol;
            if ((innerCnt > 0) &&
                (argCtx.argument_list()[innerCnt - 1].stop.line !== rParenToken.line)) {
                result += ' '.repeat(indent);
            }

            result += ')';
            result += this.getHiddenTextOnRight(rParenToken.tokenIndex, indent);
        }

        return result;
    }
}