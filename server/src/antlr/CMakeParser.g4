parser grammar CMakeParser;

options {
	tokenVocab = CMakeLexer;
}

file: (command | conditional | loop | macroOrFuncDef)? commandGroup EOF;

conditional:
	ifCmd commandGroup (NL elseIfCmd commandGroup)* (NL elseCmd commandGroup)? NL endIfCmd;
loop: foreachLoop | whileLoop;
macroOrFuncDef: macroDefinition | functionDefinition;

foreachLoop: foreachCmd commandGroup NL endForeachCmd;
whileLoop: whileCmd commandGroup NL endWhileCmd;
macroDefinition: macroCmd commandGroup NL endMacroCmd;
functionDefinition: functionCmd commandGroup NL endFunctionCmd;

commandGroup: (NL command | NL conditional | NL loop | NL macroOrFuncDef | NL)*;

ifCmd: If LP argument* RP;
elseIfCmd: ElseIf LP argument* RP;
elseCmd: Else LP RP;
endIfCmd: EndIf LP argument* RP;
foreachCmd: Foreach LP argument+ RP;
endForeachCmd: EndForeach LP argument* RP;
whileCmd: While LP argument+ RP;
endWhileCmd: EndWhile LP argument* RP;
macroCmd: Macro LP argument+ RP;
endMacroCmd: EndMacro LP argument* RP;
functionCmd: Function LP argument+ RP;
endFunctionCmd: EndFunction LP argument* RP;

breakCmd: Break LP RP;
continueCmd: Continue LP RP;
setCmd: Set LP argument+ RP;
optionCmd: Option LP argument+ RP;
includeCmd: Include LP argument+ RP;
addSubDirectoryCmd: AddSubDirectory LP argument+ RP;
otherCmd: ID LP argument* RP;

command:
	breakCmd
	| continueCmd
	| setCmd
	| optionCmd
	| includeCmd
	| addSubDirectoryCmd
	| otherCmd;

argument:
	BracketArgument
	| QuotedArgument
	| UnquotedArgument
	| If
	| ElseIf
	| Else
	| EndIf
	| Foreach
	| EndForeach
	| While
	| EndWhile
	| Break
	| Continue
	| Function
	| EndFunction
	| Macro
	| EndMacro
	| Set
	| Option
	| Include
	| AddSubDirectory
	| ID
	| LP argument* RP;