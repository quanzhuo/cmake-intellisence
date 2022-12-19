grammar CMake;

@lexer::members {
    this.nesting = 0;
    this.newLineCount = 1;
}

file
    :   (command NL) * EOF // every command except the last must be terminated with newline
    ;

command
    : 'if' '(' argument* ')'			   # IfCmd
	| 'elseif' '(' argument* ')'		   # ElseIfCmd
	| 'else' '(' argument* ')'			   # ElseCmd
	| 'endif' '(' argument* ')'			   # EndIfCmd
	| 'foreach' '(' argument+ ')'		   # ForeachCmd
	| 'endforeach' '(' argument* ')'	   # EndForeachCmd
	| 'while' '(' argument+ ')'			   # WhileCmd
	| 'endwhile' '(' argument* ')'		   # EndWhileCmd
	| 'break' '(' ')'					   # BreakCmd
	| 'continue' '(' ')'				   # ContinueCmd
	| 'function' '(' argument+ ')'		   # FunctionCmd
	| 'endfunction' '(' argument* ')'	   # EndFunctionCmd
	| 'macro' '(' argument+ ')'			   # MacroCmd
	| 'endmacro' '(' argument* ')'		   # EndMacroCmd
    | 'set' '(' argument+ ')'              # SetCmd
    | 'option' '(' argument+ ')'           # OptionCmd
    | 'include' '(' argument+ ')'          # IncludeCmd
    | 'add_subdirectory' '(' argument+ ')' # AddSubDirCmd
    |   ID '(' argument * ')'              # OtherCmd
    ;

argument
    :   QuotedArgument
    |   BracketArgument
	|   UnquotedArgument
	|   ID
	|   '(' argument* ')'
	;

ID  : [a-zA-Z_] [a-zA-Z0-9_]*
    ;

BracketArgument
    :   '[' BracketNested ']'
    ;

QuotedArgument
    :   '"' QuotedElement* '"'
    ;

UnquotedArgument
    :   (UnquotedElement)+
    ;

BracketComment
    :   '#[' BracketNested ']' -> channel(HIDDEN)
    ;

LineComment
    :   '#' ~[\r\n]* -> channel(HIDDEN)
    ;


// NL should be ignored in the following two cases
// 1. NL between '(' and ')'
// 2. NL between command invocations
IgnoreNLBetweenArgs
    :   '\r'? '\n' { this.nesting > 0 }? -> channel(HIDDEN)
    ;

IgnoreExtraNLBetweenCmds
    :   '\r'? '\n' { this.newLineCount > 0 }? -> channel(HIDDEN)
    ;

NL  :   {this.newLineCount++;} '\r'? '\n'
    ;

// all whitespace should be ignored by lexer
WS  :   [ \t]+ -> skip
    ;

LParen
    :   '(' {this.nesting++;}
    ;

RParen
    :   ')' {this.nesting--; this.newLineCount = 0;}
    ;

Escape
    :  EscapeIdentity | EscapeEncoded | EscapeSemi
    ;

fragment
EscapeIdentity
    :   '\\' ~[a-zA-Z0-9;]
    ;

fragment
EscapeEncoded
    :   '\\t' | '\\r' | '\\n'
    ;

fragment
EscapeSemi
    :   '\\;'
    ;

fragment
BracketNested
    :   '=' BracketNested '='
    |   '[' .*? ']'
    ;

fragment
QuotedElement
    :   ~[\\"] | Escape | '\\' NL
    ;

fragment
UnquotedElement
    :   ~[ \t\r\n()#"\\] | Escape
    ;
