import { Parser, ParserRuleContext, ParseTree, ParseTreeWalker } from "antlr4";
import { AddSubDirectoryCmdContext, ArgumentContext, BreakCmdContext, CommandContext, CommandGroupContext, ConditionalContext, ContinueCmdContext, ElseCmdContext, ElseIfCmdContext, EndForeachCmdContext, EndFunctionCmdContext, EndIfCmdContext, EndMacroCmdContext, EndWhileCmdContext, FileContext, ForeachCmdContext, ForeachLoopContext, FunctionCmdContext, FunctionDefinitionContext, IfCmdContext, IncludeCmdContext, LoopContext, MacroCmdContext, MacroDefinitionContext, MacroOrFuncDefContext, OptionCmdContext, OtherCmdContext, SetCmdContext, WhileCmdContext, WhileLoopContext } from "./generated/CMakeParser";
import CMakeParserListener from "./generated/CMakeParserListener";
import { SelectionRange, SelectionRangeParams } from "vscode-languageserver";
import { Position } from "vscode-languageserver-textdocument";

export class SelectionRangeListener extends CMakeParserListener {
    private ranges: SelectionRange[] = [];

    constructor(
        private params: SelectionRangeParams
    ) {
        super();
    }

    static run(tree: FileContext, params: SelectionRangeParams) {
        const listener = new SelectionRangeListener(params);
        ParseTreeWalker.DEFAULT.walk(listener, tree);
    }

    isPositionInNode(position: Position, ctx: ParserRuleContext): boolean {
        const [startLine, startColumn, endLine, endColumn] = [
            ctx.start.line,
            ctx.start.column,
            ctx.stop.line,
            ctx.stop.column
        ];

        if (position.line < startLine || position.line > endLine) {
            return false;
        }
        if (position.line === startLine && position.character < startColumn) {
            return false;
        }
        if (position.line === endLine && position.character > endColumn) {
            return false;
        }
        return true;
    }

    // enterFile = (ctx: FileContext) => { };
    // enterConditional = (ctx: ConditionalContext) => { };
    // enterLoop = (ctx: LoopContext) => { };
    // enterMacroOrFuncDef = (ctx: MacroOrFuncDefContext) => { };
    // enterForeachLoop = (ctx: ForeachLoopContext) => { };
    // enterWhileLoop = (ctx: WhileLoopContext) => { };
    // enterMacroDefinition = (ctx: MacroDefinitionContext) => { };
    // enterFunctionDefinition = (ctx: FunctionDefinitionContext) => { };
    // enterCommandGroup = (ctx: CommandGroupContext) => { };
    enterIfCmd = (ctx: IfCmdContext) => { 
        if (!this.isPositionInNode(this.params.positions[0], ctx)) {
            return;
        }
    };
    enterElseIfCmd = (ctx: ElseIfCmdContext) => { 
        if (!this.isPositionInNode(this.params.positions[0], ctx)) {
            return;
        }
    };
    enterElseCmd = (ctx: ElseCmdContext) => {
        if (!this.isPositionInNode(this.params.positions[0], ctx)) {
            return;
        }
     };
    enterEndIfCmd = (ctx: EndIfCmdContext) => { 
        if (!this.isPositionInNode(this.params.positions[0], ctx)) {
            return;
        }
    };
    enterForeachCmd = (ctx: ForeachCmdContext) => {
        if (!this.isPositionInNode(this.params.positions[0], ctx)) {
            return;
        }
     };
    enterEndForeachCmd = (ctx: EndForeachCmdContext) => {
        if (!this.isPositionInNode(this.params.positions[0], ctx)) {
            return;
        }
     };
    enterWhileCmd = (ctx: WhileCmdContext) => {
        if (!this.isPositionInNode(this.params.positions[0], ctx)) {
            return;
        }
     };
    enterEndWhileCmd = (ctx: EndWhileCmdContext) => { 
        if (!this.isPositionInNode(this.params.positions[0], ctx)) {
            return;
        }
    };
    enterMacroCmd = (ctx: MacroCmdContext) => {
        if (!this.isPositionInNode(this.params.positions[0], ctx)) {
            return;
        }
     };
    enterEndMacroCmd = (ctx: EndMacroCmdContext) => {
        if (!this.isPositionInNode(this.params.positions[0], ctx)) {
            return;
        }
     };
    enterFunctionCmd = (ctx: FunctionCmdContext) => { 
        if (!this.isPositionInNode(this.params.positions[0], ctx)) {
            return;
        }
    };
    enterEndFunctionCmd = (ctx: EndFunctionCmdContext) => {
        if (!this.isPositionInNode(this.params.positions[0], ctx)) {
            return;
        }
     };
    enterCommand = (ctx: CommandContext) => {
        if (!this.isPositionInNode(this.params.positions[0], ctx)) {
            return;
        }
     };
    // enterArgument = (ctx: ArgumentContext) => { };
}