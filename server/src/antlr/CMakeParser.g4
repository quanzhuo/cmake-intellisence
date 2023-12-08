parser grammar CMakeParser;

options {
    tokenVocab = CMakeLexer;
}

file
    : (command | conditional | loop | macroOrFuncDef | newLine) * EOF;

conditional: ifCmd controlBody (elseIfCmd controlBody)* (elseCmd controlBody)? endIfCmd;
loop: foreachLoop | whileLoop;
macroOrFuncDef: macroDefinition | functionDefinition;

foreachLoop: foreachCmd controlBody endForeachCmd;
whileLoop: whileCmd controlBody endWhileCmd;
macroDefinition: macroCmd controlBody endMacroCmd;
functionDefinition: functionCmd controlBody endFunctionCmd;

controlBody: (conditional | command | loop | newLine )*;

ifCmd: IfCmd LP argument* RP NL;
elseIfCmd: ElseIfCmd LP argument* RP NL;
elseCmd: ElseCmd LP RP NL;
endIfCmd: EndIfCmd LP argument* RP NL;
foreachCmd: ForeachCmd LP argument+ RP NL;
endForeachCmd: EndForeachCmd LP argument+ RP NL;
whileCmd: WhileCmd LP argument+ RP NL;
endWhileCmd: EndWhileCmd LP argument* RP NL;
macroCmd: MacroCmd LP argument+ RP NL;
endMacroCmd: EndMacroCmd LP argument* RP NL;
functionCmd: FunctionCmd LP argument+ RP NL;
endFunctionCmd: EndFunctionCmd LP argument* RP NL;
breakCmd: BreakCmd LP RP NL;
continueCmd: ContinueCmd LP RP NL;
setCmd: SetCmd LP argument+ RP NL;
optionCmd: SetCmd LP argument+ RP NL;
includeCmd: IncludeCmd LP argument+ RP NL;
addSubDirectoryCmd: AddSubDirectory LP argument+ RP NL;
otherCmd: ID LP argument * RP NL;
newLine: NL;

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
