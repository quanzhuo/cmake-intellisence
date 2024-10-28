parser grammar CMakeParser;

options {
    tokenVocab = CMakeLexer;
}

file
    : (command | conditional | loop | macroOrFuncDef | NL) * EOF;

conditional: ifCmd NL controlBody (elseIfCmd NL controlBody)* (elseCmd NL controlBody)? endIfCmd;
loop: foreachLoop | whileLoop;
macroOrFuncDef: macroDefinition | functionDefinition;

foreachLoop: foreachCmd NL controlBody endForeachCmd;
whileLoop: whileCmd NL controlBody endWhileCmd;
macroDefinition: macroCmd NL controlBody endMacroCmd;
functionDefinition: functionCmd NL controlBody endFunctionCmd;

controlBody: (conditional | command | loop | NL )*;

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
optionCmd: SetCmd LP argument+ RP;
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
