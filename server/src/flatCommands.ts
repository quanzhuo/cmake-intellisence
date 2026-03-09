import { ParseTreeWalker, ParserRuleContext, TerminalNode, Token } from 'antlr4';
import {
    AddSubDirectoryCmdContext, ArgumentContext,
    BreakCmdContext, ContinueCmdContext,
    ElseCmdContext, ElseIfCmdContext, EndForeachCmdContext, EndFunctionCmdContext,
    EndIfCmdContext, EndMacroCmdContext, EndWhileCmdContext,
    FileContext, ForeachCmdContext, FunctionCmdContext,
    IfCmdContext, IncludeCmdContext,
    MacroCmdContext, OptionCmdContext, OtherCmdContext,
    SetCmdContext, WhileCmdContext
} from './generated/CMakeParser';
import CMakeParserListener from './generated/CMakeParserListener';

/**
 * A unified wrapper around any CMakeParser command context.
 * Provides the same API surface as CMakeSimpleParser.CommandContext,
 * enabling binary search and flat iteration over all commands in a file.
 */
export class FlatCommand {
    public readonly commandName: string;

    constructor(public readonly ctx: ParserRuleContext) {
        this.commandName = ctx.start.text;
    }

    get start(): Token { return this.ctx.start; }
    get stop(): Token | null { return this.ctx.stop ?? null; }

    /** Simulates CMakeSimpleParser.CommandContext.ID() */
    ID(): { symbol: Token; getText(): string } {
        return {
            symbol: this.ctx.start,
            getText: () => this.ctx.start.text
        };
    }

    LP(): TerminalNode { return (this.ctx as any).LP(); }
    RP(): TerminalNode { return (this.ctx as any).RP(); }

    argument_list(): ArgumentContext[] {
        return typeof (this.ctx as any).argument_list === 'function'
            ? (this.ctx as any).argument_list()
            : [];
    }

    argument(i: number): ArgumentContext {
        return (this.ctx as any).argument(i);
    }

    getText(): string { return this.ctx.getText(); }
    getChildCount(): number { return this.ctx.getChildCount(); }
}

/**
 * Extract a flat, document-ordered list of all commands from a Full Parser tree.
 * The result is sorted by source position (guaranteed by tree walk order),
 * suitable for binary search.
 */
export function extractFlatCommands(tree: FileContext): FlatCommand[] {
    const commands: FlatCommand[] = [];
    const push = (ctx: ParserRuleContext) => commands.push(new FlatCommand(ctx));

    const listener = new class extends CMakeParserListener {
        // Control flow commands
        enterIfCmd = (ctx: IfCmdContext) => push(ctx);
        enterElseIfCmd = (ctx: ElseIfCmdContext) => push(ctx);
        enterElseCmd = (ctx: ElseCmdContext) => push(ctx);
        enterEndIfCmd = (ctx: EndIfCmdContext) => push(ctx);
        enterForeachCmd = (ctx: ForeachCmdContext) => push(ctx);
        enterEndForeachCmd = (ctx: EndForeachCmdContext) => push(ctx);
        enterWhileCmd = (ctx: WhileCmdContext) => push(ctx);
        enterEndWhileCmd = (ctx: EndWhileCmdContext) => push(ctx);
        enterMacroCmd = (ctx: MacroCmdContext) => push(ctx);
        enterEndMacroCmd = (ctx: EndMacroCmdContext) => push(ctx);
        enterFunctionCmd = (ctx: FunctionCmdContext) => push(ctx);
        enterEndFunctionCmd = (ctx: EndFunctionCmdContext) => push(ctx);
        // Regular commands
        enterBreakCmd = (ctx: BreakCmdContext) => push(ctx);
        enterContinueCmd = (ctx: ContinueCmdContext) => push(ctx);
        enterSetCmd = (ctx: SetCmdContext) => push(ctx);
        enterOptionCmd = (ctx: OptionCmdContext) => push(ctx);
        enterIncludeCmd = (ctx: IncludeCmdContext) => push(ctx);
        enterAddSubDirectoryCmd = (ctx: AddSubDirectoryCmdContext) => push(ctx);
        enterOtherCmd = (ctx: OtherCmdContext) => push(ctx);
    };

    ParseTreeWalker.DEFAULT.walk(listener, tree);
    return commands;
}
