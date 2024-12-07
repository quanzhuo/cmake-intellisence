lexer grammar CMakeLexer;

@lexer::members {
    private nestingLevel: number = 0;
}

options {
	caseInsensitive = true;
}

channels {
	COMMENTS
}

If: 'if';
ElseIf: 'elseif';
Else: 'else';
EndIf: 'endif';
Foreach: 'foreach';
EndForeach: 'endforeach';
While: 'while';
EndWhile: 'endwhile';
Break: 'break';
Continue: 'continue';
Function: 'function';
EndFunction: 'endfunction';
Macro: 'macro';
EndMacro: 'endmacro';
Set: 'set';
Option: 'option';
Include: 'include';
AddSubDirectory: 'add_subdirectory';
ID options{
	caseInsensitive = false;
}: [a-zA-Z_] [a-zA-Z0-9_]*;

BracketArgument: '[' BracketNested ']';
QuotedArgument: '"' QuotedElement* '"';
UnquotedArgument: (UnquotedElement)+;
BracketComment: '#[' BracketNested ']' -> channel(COMMENTS);
LineComment: '#' ~[\r\n]* -> channel(COMMENTS);

// NL should be ignored between '(' and ')'
IgnoreNLBetweenArgs:
	'\r'? '\n' { this.nestingLevel > 0 }? -> channel(HIDDEN);

NL: '\r'? '\n';
WS: [ \t]+ -> skip;
LP: '(' {this.nestingLevel++;};
RP: ')' {this.nestingLevel--;};

fragment EscapeSequence:
	EscapeIdentity
	| EscapeEncoded
	| EscapeSemicolon;
fragment EscapeIdentity options{
	caseInsensitive = false;
}: '\\' ~[a-zA-Z0-9;];
fragment EscapeEncoded: '\\t' | '\\r' | '\\n';
fragment EscapeSemicolon: '\\;';
fragment BracketNested: '=' BracketNested '=' | '[' .*? ']';
fragment QuotedElement: ~[\\"] | EscapeSequence | '\\' NL;
fragment UnquotedElement: ~[ \t\r\n()#"\\] | EscapeSequence;