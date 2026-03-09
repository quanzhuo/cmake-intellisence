import { ParserRuleContext, TerminalNode, Token } from 'antlr4';
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
import CMakeParserVisitor from './generated/CMakeParserVisitor';

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
 * The result is sorted by source position (guaranteed by tree visit order),
 * suitable for binary search.
 *
 * Uses Visitor instead of Listener: command visit methods push and return
 * without calling visitChildren, avoiding unnecessary descent into argument nodes.
 * Structural nodes (file, entity, conditional, etc.) have no visit method defined,
 * so they fall through to the default visitChildren — correctly recursing into
 * nested commands.
 */
export function extractFlatCommands(tree: FileContext): FlatCommand[] {
    const commands: FlatCommand[] = [];
    const push = (ctx: ParserRuleContext) => { commands.push(new FlatCommand(ctx)); };

    const visitor = new class extends CMakeParserVisitor<void> {
        // Control flow commands
        visitIfCmd = (ctx: IfCmdContext) => { push(ctx); };
        visitElseIfCmd = (ctx: ElseIfCmdContext) => { push(ctx); };
        visitElseCmd = (ctx: ElseCmdContext) => { push(ctx); };
        visitEndIfCmd = (ctx: EndIfCmdContext) => { push(ctx); };
        visitForeachCmd = (ctx: ForeachCmdContext) => { push(ctx); };
        visitEndForeachCmd = (ctx: EndForeachCmdContext) => { push(ctx); };
        visitWhileCmd = (ctx: WhileCmdContext) => { push(ctx); };
        visitEndWhileCmd = (ctx: EndWhileCmdContext) => { push(ctx); };
        visitMacroCmd = (ctx: MacroCmdContext) => { push(ctx); };
        visitEndMacroCmd = (ctx: EndMacroCmdContext) => { push(ctx); };
        visitFunctionCmd = (ctx: FunctionCmdContext) => { push(ctx); };
        visitEndFunctionCmd = (ctx: EndFunctionCmdContext) => { push(ctx); };
        // Regular commands
        visitBreakCmd = (ctx: BreakCmdContext) => { push(ctx); };
        visitContinueCmd = (ctx: ContinueCmdContext) => { push(ctx); };
        visitSetCmd = (ctx: SetCmdContext) => { push(ctx); };
        visitOptionCmd = (ctx: OptionCmdContext) => { push(ctx); };
        visitIncludeCmd = (ctx: IncludeCmdContext) => { push(ctx); };
        visitAddSubDirectoryCmd = (ctx: AddSubDirectoryCmdContext) => { push(ctx); };
        visitOtherCmd = (ctx: OtherCmdContext) => { push(ctx); };
    };

    visitor.visit(tree);
    return commands;
}
