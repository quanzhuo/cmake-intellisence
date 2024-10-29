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

IfCmd: 'if';
ElseIfCmd: 'elseif';
ElseCmd: 'else';
EndIfCmd: 'endif';
ForeachCmd: 'foreach';
EndForeachCmd: 'endforeach';
WhileCmd: 'while';
EndWhileCmd: 'endwhile';
BreakCmd: 'break';
ContinueCmd: 'continue';
FunctionCmd: 'function';
EndFunctionCmd: 'endfunction';
MacroCmd: 'macro';
EndMacroCmd: 'endmacro';
SetCmd: 'set';
OptionCmd: 'option';
IncludeCmd: 'include';
AddSubDirectory: 'add_subdirectory';

ID options{caseInsensitive = false;} : [a-zA-Z_] [a-zA-Z0-9_]* ;

BracketArgument
    :   '[' BracketNested ']';

QuotedArgument
    :   '"' QuotedElement* '"' ;

UnquotedArgument
    :   (UnquotedElement)+ ;

BracketComment
    :   '#[' BracketNested ']' -> channel(COMMENTS) ;

LineComment
    :   '#' ~[\r\n]* -> channel(COMMENTS) ;


// NL should be ignored between '(' and ')'
IgnoreNLBetweenArgs
    :   '\r'? '\n' { this.nestingLevel > 0 }? -> channel(HIDDEN) ;

NL  :  '\r'? '\n' ;

WS  :   [ \t]+ -> skip ;

LP  :   '(' {this.nestingLevel++;} ;

RP  :   ')' {this.nestingLevel--;} ;

EscapeSequence
    :  EscapeIdentity | EscapeEncoded | EscapeSemicolon ;

fragment EscapeIdentity
options{caseInsensitive = false;}
    :   '\\' ~[a-zA-Z0-9;] ;

fragment EscapeEncoded
    :   '\\t' | '\\r' | '\\n';

fragment EscapeSemicolon
    :   '\\;';

fragment BracketNested
    :   '=' BracketNested '='
    |   '[' .*? ']'
    ;

fragment QuotedElement
    :   ~[\\"] | EscapeSequence | '\\' NL;

fragment UnquotedElement
    :   ~[ \t\r\n()#"\\] | EscapeSequence;
