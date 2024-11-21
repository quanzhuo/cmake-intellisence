parser grammar CMakeParser;

options {
    tokenVocab = CMakeLexer;
}

file
    : (command | conditional | loop | macroOrFuncDef) ? ( NL command | NL conditional | NL loop | NL macroOrFuncDef | NL) * EOF;

conditional: ifCmd block (NL elseIfCmd block)* (NL elseCmd block)? NL endIfCmd;
loop: foreachLoop | whileLoop;
macroOrFuncDef: macroDefinition | functionDefinition;

foreachLoop: foreachCmd block NL endForeachCmd;
whileLoop: whileCmd block NL endWhileCmd;
macroDefinition: macroCmd block NL endMacroCmd;
functionDefinition: functionCmd block NL endFunctionCmd;

block: (NL command | NL conditional | NL loop | NL )*;

ifCmd: IfCmd LP argument* RP;
elseIfCmd: ElseIfCmd LP argument* RP;
elseCmd: ElseCmd LP RP;
endIfCmd: EndIfCmd LP argument* RP;
foreachCmd: ForeachCmd LP argument+ RP;
endForeachCmd: EndForeachCmd LP argument+ RP;
whileCmd: WhileCmd LP argument+ RP;
endWhileCmd: EndWhileCmd LP argument* RP;
macroCmd: MacroCmd LP argument+ RP;
endMacroCmd: EndMacroCmd LP argument* RP;
functionCmd: FunctionCmd LP argument+ RP;
endFunctionCmd: EndFunctionCmd LP argument* RP;

breakCmd: BreakCmd LP RP;
continueCmd: ContinueCmd LP RP;
setCmd: SetCmd LP argument+ RP;
optionCmd: OptionCmd LP argument+ RP;
includeCmd: IncludeCmd LP argument+ RP;
addSubDirectoryCmd: AddSubDirectory LP argument+ RP;
otherCmd: ID LP argument * RP;

command
    : breakCmd
    | continueCmd
    | setCmd
    | optionCmd
    | includeCmd
    | addSubDirectoryCmd
    | otherCmd
    ;

argument
    : BracketArgument
    | QuotedArgument
	| UnquotedArgument
	| ID
	| LP argument* RP
	;
