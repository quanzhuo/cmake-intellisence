import CMakeListener from "./parser/CMakeListener";
import CMakeLexer from "./parser/CMakeLexer";

export class FormatListener extends CMakeListener {
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

    /**
     * Get comment on right of token whose index is tokenIndex.
     * 
     * According to syntax in CMake.g4, the '\n' immidiately after the command
     * is sent to the parser, while all other newlines is ignored. So if token is
     * '\n', '(' or argument, there maybe multiple comments on right, if token is
     * ')', there will be only one comment on right.
     * 
     * @param tokenIndex index of token
     * @return
     */
    private getCommentOnRight(tokenIndex: number): string {
        const hiddenTokens = this._tokenStream.getHiddenTokensToRight(tokenIndex, CMakeLexer.HIDDEN);
        if (hiddenTokens === null) {
            return "";
        }

        let result = "";
        const tokenLine: number = this._tokenStream.get(tokenIndex).line;
        const total: number = this._tokenStream.tokens.length;
        for (const t of hiddenTokens) {
            // comment is on same line as the previous token
            if (t.line === tokenLine) {
                result += t.text;
            } else {
                const tokenType: number = this._tokenStream.get(tokenIndex).type;
                if (tokenType === CMakeLexer.NL) {
                    result += ' '.repeat(this.getIndent()) + t.text
                } else {
                    result += ' '.repeat(this.getIndent() + 4) + t.text;
                }
            }
            const next: number = t.tokenIndex + 1;
            if (next < total && this._tokenStream.get(next).type !== CMakeLexer.NL
                || next >= total) {
                result += "\n";
            }
        }
        return result;
    }

    private getIndent(): number {
        return this._indent * this._indentLevel;
    }

    /**
     * @param id    command name
     * @param index left paren's index in token stream
     * @return
     */
    private getTextBeforeFirstArg(id: string, index: number) {
        return ' '.repeat(this.getIndent())
            + id
            + "("
            + this.getCommentOnRight(index);
    }

    /**
     * @param index index of right paren in token stream
     * @return
     */
    private getTextAfterLastArg(index: number): string {
        let ret = ")";

        // get comment after ')'
        ret += this.getCommentOnRight(index);
        return ret;
    }

    private isComment(token: any): boolean {
        return token.type === CMakeLexer.BracketComment ||
            token.type === CMakeLexer.LineComment;
    }

    private addNewlineBeforeBlock(index: number) {
        if (index <= 0) {
            return;
        }

        // if this is not the top level command, return
        if (this._indentLevel > 0) {
            return;
        }

        const token = this._tokenStream.get(index - 1);
        if (!this.isComment(token)) {
            this._formatted += "\n";
        }
    }

    private addNewLineAfterBlock() {
        if (this._indentLevel > 0) {
            return;
        }

        this._formatted += "\n";
    }

    /**
     * @param index token index of newline token
     */
    private addCommentsAfterSeprator(index: number) {
        const newline = this._tokenStream.get(index);
        if (newline.type === CMakeLexer.NL) {
            this._formatted += this.getCommentOnRight(index);
        }
    }

    private getContextText(ctx: any): string {
        if (ctx.getChildCount() === 0) {
            return "";
        }

        let result: string = "";
        for (let i = 0; i < ctx.getChildCount(); ++i) {
            result += ctx.getChild(i).getText();
        }

        return result;
    }

    private exitBeginBlockCmd(ctx: any): void {
        const index: number = ctx.RParen().getSymbol().tokenIndex;
        const text: string = this.getTextAfterLastArg(index);
        this._formatted += text;

        // append a newline as command seprator
        this._formatted += "\n";

        ++this._indentLevel;

        // comments after the newline
        const nlIndex: number = text === ")" ? index + 1 : index + 2;
        this.addCommentsAfterSeprator(nlIndex);
    }

    private exitEndBlockCmd(ctx: any): void {
        const index: number = ctx.RParen().getSymbol().tokenIndex;
        const text: string = this.getTextAfterLastArg(index);
        this._formatted += text;

        // append a newline as command seprator
        this._formatted += "\n";

        this.addNewLineAfterBlock();

        // comments after the newline
        const nlIndex: number = text === ")" ? index + 1 : index + 2;
        this.addCommentsAfterSeprator(nlIndex);
    }

    enterFile(ctx: any): void {
        let hasComment = false;
        for (const token of this._tokenStream.tokens) {
            if (token.channel !== CMakeLexer.HIDDEN) {
                break;
            }
            hasComment = true;
            this._formatted += token.text + "\n";
        }

        // add a newline before the first command
        if (hasComment) {
            this._formatted += "\n";
        }
    }

    enterIfCmd(ctx: any): void {
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this.addNewlineBeforeBlock(index - 1);
        this._formatted += this.getTextBeforeFirstArg("if", index);
    }

    exitIfCmd(ctx: any): void {
        this.exitBeginBlockCmd(ctx);
    }

    enterElseIfCmd(ctx: any): void {
        --this._indentLevel;
        this._formatted += this.getTextBeforeFirstArg("elseif", ctx.LParen().getSymbol().tokenIndex);
    }

    exitElseIfCmd(ctx: any): void {
        this.exitBeginBlockCmd(ctx);
    }

    enterElseCmd(ctx: any): void {
        --this._indentLevel;
        this._formatted += this.getTextBeforeFirstArg("else", ctx.LParen().getSymbol().tokenIndex);
    }

    exitElseCmd(ctx: any): void {
        this.exitBeginBlockCmd(ctx);
    }

    enterEndIfCmd(ctx: any): void {
        --this._indentLevel;
        this._formatted += this.getTextBeforeFirstArg("endif", ctx.LParen().getSymbol().tokenIndex);
    }

    exitEndIfCmd(ctx: any): void {
        this.exitEndBlockCmd(ctx);
    }

    enterWhileCmd(ctx: any): void {
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this.addNewlineBeforeBlock(index - 1);
        this._formatted += this.getTextBeforeFirstArg("while", index);
    }

    exitWhileCmd(ctx: any): void {
        this.exitBeginBlockCmd(ctx);
    }

    enterEndWhileCmd(ctx: any): void {
        --this._indentLevel;
        this._formatted += this.getTextBeforeFirstArg("endwhile", ctx.LParen().getSymbol().tokenIndex);
    }

    exitEndWhileCmd(ctx: any): void {
        this.exitEndBlockCmd(ctx);
    }

    enterForeachCmd(ctx: any): void {
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this.addNewlineBeforeBlock(index - 1);
        this._formatted += this.getTextBeforeFirstArg("foreach", index);
    }

    exitForeachCmd(ctx: any): void {
        this.exitBeginBlockCmd(ctx);
    }

    enterEndForeachCmd(ctx: any): void {
        --this._indentLevel;
        this._formatted += this.getTextBeforeFirstArg("endforeach", ctx.LParen().getSymbol().tokenIndex);
    }

    exitEndForeachCmd(ctx: any): void {
        this.exitEndBlockCmd(ctx);
    }

    enterBreakCmd(ctx: any): void {
        this._formatted += this.getTextBeforeFirstArg("break", ctx.LParen().getSymbol().tokenIndex);
    }

    exitBreakCmd(ctx: any): void {
        this.exitOtherCmd(ctx);
    }

    enterContinueCmd(ctx: any): void {
        this._formatted += this.getTextBeforeFirstArg("continue", ctx.LParen().getSymbol().tokenIndex);
    }

    exitContinueCmd(ctx: any): void {
        this.exitOtherCmd(ctx);
    }

    enterFunctionCmd(ctx: any): void {
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this.addNewlineBeforeBlock(index - 1);
        this._formatted += this.getTextBeforeFirstArg("function", index);
    }

    exitFunctionCmd(ctx: any): void {
        this.exitBeginBlockCmd(ctx);
    }

    enterEndFunctionCmd(ctx: any): void {
        --this._indentLevel;
        this._formatted += this.getTextBeforeFirstArg("endfunction", ctx.LParen().getSymbol().tokenIndex);
    }

    exitEndFunctionCmd(ctx: any): void {
        this.exitEndBlockCmd(ctx);
    }

    enterMacroCmd(ctx: any): void {
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this.addNewlineBeforeBlock(index - 1);
        this._formatted += this.getTextBeforeFirstArg("macro", index);
    }

    exitMacroCmd(ctx: any): void {
        this.exitBeginBlockCmd(ctx);
    }

    enterEndMacroCmd(ctx: any): void {
        --this._indentLevel;
        this._formatted += this.getTextBeforeFirstArg("endmacro", ctx.LParen().getSymbol().tokenIndex);
    }

    exitEndMacroCmd(ctx: any): void {
        this.exitEndBlockCmd(ctx);
    }

    enterOtherCmd(ctx: any): void {
        this._formatted += this.getTextBeforeFirstArg(ctx.ID().getText(), ctx.LParen().getSymbol().tokenIndex);
    }

    exitOtherCmd(ctx: any): void {
        const index: number = ctx.RParen().getSymbol().tokenIndex;
        const text: string = this.getTextAfterLastArg(index);
        this._formatted += text;

        // append a newline as command seprator
        this._formatted += "\n";

        // comments after the newline
        const nlIndex: number = text === ")" ? index + 1 : index + 2;
        this.addCommentsAfterSeprator(nlIndex);
    }

    enterSetCmd(ctx: any): void {
        this._formatted += this.getTextBeforeFirstArg("set", ctx.LParen().getSymbol().tokenIndex);
    }

    exitSetCmd(ctx: any): void {
        this.exitOtherCmd(ctx);
    }

    enterOptionCmd(ctx: any): void {
        this._formatted += this.getTextBeforeFirstArg("option", ctx.LParen().getSymbol().tokenIndex);
    }

    exitOptionCmd(ctx: any): void {
        this.exitOtherCmd(ctx);
    }

    enterIncludeCmd(ctx: any): void {
        this._formatted += this.getTextBeforeFirstArg("include", ctx.LParen().getSymbol().tokenIndex);
    }

    exitIncludeCmd(ctx: any): void {
        this.exitOtherCmd(ctx);
    }

    enterAddSubDirCmd(ctx: any): void {
        this._formatted += this.getTextBeforeFirstArg("add_subdirectory", ctx.LParen().getSymbol().tokenIndex);
    }

    exitAddSubDirCmd(ctx: any): void {
        this.exitOtherCmd(ctx);
    }

    enterArgument(ctx: any): void {
        const count: number = ctx.getChildCount();
        if (count === 1) {
            const lParenLine: number = ctx.parentCtx.LParen().getSymbol().line;
            if (lParenLine !== ctx.stop.line) {
                this._formatted += ' '.repeat(this.getIndent() + 4);
            }
            this._formatted += this.getContextText(ctx);
        } else if (count > 1) {
            this._formatted += "(";

            // Comment can be placed after '('
            const leftParen = ctx.LParen();
            const index = leftParen.getSymbol().tokenIndex;
            this._formatted += this.getCommentOnRight(index);
        }
    }

    exitArgument(ctx: any): void {
        const count: number = ctx.getChildCount();
        if (count > 1) {
            this._formatted += ")";
        }

        let next: number;
        if (count === 1) {
            next = ctx.stop.tokenIndex + 1;
        } else {
            next = ctx.RParen().getSymbol().tokenIndex + 1;
        }

        // If this argument is not the last argument,  append a space
        if (this._tokenStream.get(next).type !== CMakeLexer.RParen) {
            this._formatted += " ";
        }

        // Comment can be placed after argument
        this._formatted += this.getCommentOnRight(next - 1);
    }
}