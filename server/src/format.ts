import antlr4 from "./parser/antlr4";
import CMakeListener from "./parser/CMakeListener";
import BufferedTokenStream from "./parser/antlr4/BufferedTokenStream";
import Lexer from "./parser/antlr4/Lexer";
import CMakeLexer from "./parser/CMakeLexer";
import TokenStream from "./parser/antlr4/TokenStream";

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
        let total: number = this._tokenStream.tokens.length;
        for (const t of hiddenTokens) {
            result += t.text;
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

        const token = this._tokenStream.get(index - 1);
        if (!this.isComment(token)) {
            this._formatted += "\n";
        }
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

    enterElseIfCmd(ctx: any): void {
        --this._indentLevel;
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this._formatted += this.getTextBeforeFirstArg("elseif", index);
    }

    exitElseIfCmd(ctx: any): void {
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

    enterElseCmd(ctx: any): void {
        --this._indentLevel;
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this._formatted += this.getTextBeforeFirstArg("else", index);
    }

    exitElseCmd(ctx: any): void {
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

    enterEndIfCmd(ctx: any): void {
        --this._indentLevel;
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this._formatted += this.getTextBeforeFirstArg("endif", index);
    }

    exitEndIfCmd(ctx: any): void {
        const index: number = ctx.RParen().getSymbol().tokenIndex;
        const text: string = this.getTextAfterLastArg(index);
        this._formatted += text;

        // append a newline as command seprator
        this._formatted += "\n";

        // append a newline after end block command
        this._formatted += "\n";

        // comments after the newline
        const nlIndex: number = text === ")" ? index + 1 : index + 2;
        this.addCommentsAfterSeprator(nlIndex);
    }

    enterWhileCmd(ctx: any): void {
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this.addNewlineBeforeBlock(index - 1);
        this._formatted += this.getTextBeforeFirstArg("while", index);
    }

    exitWhileCmd(ctx: any): void {
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

    enterEndWhileCmd(ctx: any): void {
        --this._indentLevel;
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this._formatted += this.getTextBeforeFirstArg("endwhile", index);
    }

    exitEndWhileCmd(ctx: any): void {
        const index: number = ctx.RParen().getSymbol().tokenIndex;
        const text: string = this.getTextAfterLastArg(index);
        this._formatted += text;

        // append a newline as command seprator
        this._formatted += "\n";

        // append a newline after end block command
        this._formatted += "\n";

        // comments after the newline
        const nlIndex: number = text === ")" ? index + 1 : index + 2;
        this.addCommentsAfterSeprator(nlIndex);
    }

    enterForeachCmd(ctx: any): void {
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this.addNewlineBeforeBlock(index - 1);
        this._formatted += this.getTextBeforeFirstArg("foreach", index);
    }

    exitForeachCmd(ctx: any): void {
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

    enterEndForeachCmd(ctx: any): void {
        --this._indentLevel;
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this._formatted += this.getTextBeforeFirstArg("endforeach", index);
    }

    exitEndForeachCmd(ctx: any): void {
        const index = ctx.RParen().getSymbol().tokenIndex;
        const text: string = this.getTextAfterLastArg(index);
        this._formatted += text;

        // append a newline as command sperator
        this._formatted += "\n";

        // append a newline after end block command
        this._formatted += "\n";

        // comments after the newline
        const nlIndex: number = text === ")" ? index + 1 : index + 2;
        this.addCommentsAfterSeprator(nlIndex);
    }

    enterBreakCmd(ctx: any): void {
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this._formatted += this.getTextBeforeFirstArg("break", index);
    }

    exitBreakCmd(ctx: any): void {
        const index: number = ctx.RParen().getSymbol().tokenIndex;
        const text: string = this.getTextAfterLastArg(index);
        this._formatted += text;

        // append a newline as command seprator
        this._formatted += "\n";

        // comments after the newline
        const nlIndex: number = text === ")" ? index + 1 : index + 2;
        this.addCommentsAfterSeprator(nlIndex);
    }

    enterContinueCmd(ctx: any): void {
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this._formatted += this.getTextBeforeFirstArg("continue", index);
    }

    exitContinueCmd(ctx: any): void {
        const index: number = ctx.RParen().getSymbol().tokenIndex;
        const text: string = this.getTextAfterLastArg(index);
        this._formatted += text;

        // append a newline as command seprator
        this._formatted += "\n";

        // comments after the newline
        const nlIndex: number = text === ")" ? index + 1 : index + 2;
        this.addCommentsAfterSeprator(nlIndex);
    }

    enterFunctionCmd(ctx: any): void {
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this.addNewlineBeforeBlock(index - 1);
        this._formatted += this.getTextBeforeFirstArg("function", index);
    }

    exitFunctionCmd(ctx: any): void {
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

    enterEndFunctionCmd(ctx: any): void {
        --this._indentLevel;
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this._formatted += this.getTextBeforeFirstArg("endfunction", index);
    }

    exitEndFunctionCmd(ctx: any): void {
        const index: number = ctx.RParen().getSymbol().tokenIndex;
        const text: string = this.getTextAfterLastArg(index);
        this._formatted += text;

        // append a newline as command seprator
        this._formatted += "\n";

        // append a newline after end block command
        this._formatted += "\n";

        // comments after the newline
        const nlIndex: number = text === ")" ? index + 1 : index + 2;
        this.addCommentsAfterSeprator(nlIndex);
    }

    enterMacroCmd(ctx: any): void {
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this.addNewlineBeforeBlock(index - 1);
        this._formatted += this.getTextBeforeFirstArg("macro", index);
    }

    exitMacroCmd(ctx: any): void {
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

    enterEndMacroCmd(ctx: any): void {
        --this._indentLevel;
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this._formatted += this.getTextBeforeFirstArg("endmacro", index);
    }

    exitEndMacroCmd(ctx: any): void {
        const index: number = ctx.RParen().getSymbol().tokenIndex;
        const text: string = this.getTextAfterLastArg(index);
        this._formatted += text;

        // append a newline as command seprator
        this._formatted += "\n";

        // append a newline after end block command
        this._formatted += "\n";

        // comments after the newline
        const nlIndex: number = text === ")" ? index + 1 : index + 2;
        this.addCommentsAfterSeprator(nlIndex);
    }

    enterOtherCmd(ctx: any): void {
        const index: number = ctx.LParen().getSymbol().tokenIndex;
        this._formatted += this.getTextBeforeFirstArg(ctx.ID().getText(), index);
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

    enterArgument(ctx: any): void {
        const count: number = ctx.getChildCount();
        if (count === 1) {
            this._formatted += this.getContextText(ctx);
            // const index: number = ctx.stop.tokenIndex;
            // // if this is the first argument, don't add space
            // if (this._tokenStream.get(index + 1).type !== CMakeLexer.RParen) {
            //     this._formatted += " ";
            // }

            // comment can be placed after argument
            // this._formatted += this.getCommentOnRight(index);
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
            this._formatted += ")" + this.getCommentOnRight(ctx.stop.tokenIndex);
        }

        let index: number;
        if (count === 1) {
            index = ctx.stop.tokenIndex;
        } else {
            index = ctx.RParen().getSymbol().tokenIndex;
        }

        // If this argument is not the last argument,  append a space
        if (this._tokenStream.get(index + 1).type !== CMakeLexer.RParen) {
            this._formatted += " ";
        }

        // Comment can be placed after argument
        this._formatted += this.getCommentOnRight(index);
    }
}