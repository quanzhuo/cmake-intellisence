// Generated from java-escape by ANTLR 4.11.1
// jshint ignore: start
import antlr4 from './antlr4/index.js';
import CMakeListener from './CMakeListener.js';
const serializedATN = [4,1,27,156,2,0,7,0,2,1,7,1,2,2,7,2,1,0,1,0,1,0,5,
0,10,8,0,10,0,12,0,13,9,0,1,0,1,0,1,1,1,1,1,1,5,1,20,8,1,10,1,12,1,23,9,
1,1,1,1,1,1,1,1,1,5,1,29,8,1,10,1,12,1,32,9,1,1,1,1,1,1,1,1,1,5,1,38,8,1,
10,1,12,1,41,9,1,1,1,1,1,1,1,1,1,5,1,47,8,1,10,1,12,1,50,9,1,1,1,1,1,1,1,
1,1,4,1,56,8,1,11,1,12,1,57,1,1,1,1,1,1,1,1,1,1,5,1,65,8,1,10,1,12,1,68,
9,1,1,1,1,1,1,1,1,1,4,1,74,8,1,11,1,12,1,75,1,1,1,1,1,1,1,1,1,1,5,1,83,8,
1,10,1,12,1,86,9,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,1,4,1,98,8,1,11,
1,12,1,99,1,1,1,1,1,1,1,1,1,1,5,1,107,8,1,10,1,12,1,110,9,1,1,1,1,1,1,1,
1,1,4,1,116,8,1,11,1,12,1,117,1,1,1,1,1,1,1,1,1,1,5,1,125,8,1,10,1,12,1,
128,9,1,1,1,1,1,1,1,1,1,5,1,134,8,1,10,1,12,1,137,9,1,1,1,3,1,140,8,1,1,
2,1,2,1,2,1,2,1,2,1,2,5,2,148,8,2,10,2,12,2,151,9,2,1,2,3,2,154,8,2,1,2,
0,0,3,0,2,4,0,0,185,0,11,1,0,0,0,2,139,1,0,0,0,4,153,1,0,0,0,6,7,3,2,1,0,
7,8,5,23,0,0,8,10,1,0,0,0,9,6,1,0,0,0,10,13,1,0,0,0,11,9,1,0,0,0,11,12,1,
0,0,0,12,14,1,0,0,0,13,11,1,0,0,0,14,15,5,0,0,1,15,1,1,0,0,0,16,17,5,1,0,
0,17,21,5,25,0,0,18,20,3,4,2,0,19,18,1,0,0,0,20,23,1,0,0,0,21,19,1,0,0,0,
21,22,1,0,0,0,22,24,1,0,0,0,23,21,1,0,0,0,24,140,5,26,0,0,25,26,5,2,0,0,
26,30,5,25,0,0,27,29,3,4,2,0,28,27,1,0,0,0,29,32,1,0,0,0,30,28,1,0,0,0,30,
31,1,0,0,0,31,33,1,0,0,0,32,30,1,0,0,0,33,140,5,26,0,0,34,35,5,3,0,0,35,
39,5,25,0,0,36,38,3,4,2,0,37,36,1,0,0,0,38,41,1,0,0,0,39,37,1,0,0,0,39,40,
1,0,0,0,40,42,1,0,0,0,41,39,1,0,0,0,42,140,5,26,0,0,43,44,5,4,0,0,44,48,
5,25,0,0,45,47,3,4,2,0,46,45,1,0,0,0,47,50,1,0,0,0,48,46,1,0,0,0,48,49,1,
0,0,0,49,51,1,0,0,0,50,48,1,0,0,0,51,140,5,26,0,0,52,53,5,5,0,0,53,55,5,
25,0,0,54,56,3,4,2,0,55,54,1,0,0,0,56,57,1,0,0,0,57,55,1,0,0,0,57,58,1,0,
0,0,58,59,1,0,0,0,59,60,5,26,0,0,60,140,1,0,0,0,61,62,5,6,0,0,62,66,5,25,
0,0,63,65,3,4,2,0,64,63,1,0,0,0,65,68,1,0,0,0,66,64,1,0,0,0,66,67,1,0,0,
0,67,69,1,0,0,0,68,66,1,0,0,0,69,140,5,26,0,0,70,71,5,7,0,0,71,73,5,25,0,
0,72,74,3,4,2,0,73,72,1,0,0,0,74,75,1,0,0,0,75,73,1,0,0,0,75,76,1,0,0,0,
76,77,1,0,0,0,77,78,5,26,0,0,78,140,1,0,0,0,79,80,5,8,0,0,80,84,5,25,0,0,
81,83,3,4,2,0,82,81,1,0,0,0,83,86,1,0,0,0,84,82,1,0,0,0,84,85,1,0,0,0,85,
87,1,0,0,0,86,84,1,0,0,0,87,140,5,26,0,0,88,89,5,9,0,0,89,90,5,25,0,0,90,
140,5,26,0,0,91,92,5,10,0,0,92,93,5,25,0,0,93,140,5,26,0,0,94,95,5,11,0,
0,95,97,5,25,0,0,96,98,3,4,2,0,97,96,1,0,0,0,98,99,1,0,0,0,99,97,1,0,0,0,
99,100,1,0,0,0,100,101,1,0,0,0,101,102,5,26,0,0,102,140,1,0,0,0,103,104,
5,12,0,0,104,108,5,25,0,0,105,107,3,4,2,0,106,105,1,0,0,0,107,110,1,0,0,
0,108,106,1,0,0,0,108,109,1,0,0,0,109,111,1,0,0,0,110,108,1,0,0,0,111,140,
5,26,0,0,112,113,5,13,0,0,113,115,5,25,0,0,114,116,3,4,2,0,115,114,1,0,0,
0,116,117,1,0,0,0,117,115,1,0,0,0,117,118,1,0,0,0,118,119,1,0,0,0,119,120,
5,26,0,0,120,140,1,0,0,0,121,122,5,14,0,0,122,126,5,25,0,0,123,125,3,4,2,
0,124,123,1,0,0,0,125,128,1,0,0,0,126,124,1,0,0,0,126,127,1,0,0,0,127,129,
1,0,0,0,128,126,1,0,0,0,129,140,5,26,0,0,130,131,5,15,0,0,131,135,5,25,0,
0,132,134,3,4,2,0,133,132,1,0,0,0,134,137,1,0,0,0,135,133,1,0,0,0,135,136,
1,0,0,0,136,138,1,0,0,0,137,135,1,0,0,0,138,140,5,26,0,0,139,16,1,0,0,0,
139,25,1,0,0,0,139,34,1,0,0,0,139,43,1,0,0,0,139,52,1,0,0,0,139,61,1,0,0,
0,139,70,1,0,0,0,139,79,1,0,0,0,139,88,1,0,0,0,139,91,1,0,0,0,139,94,1,0,
0,0,139,103,1,0,0,0,139,112,1,0,0,0,139,121,1,0,0,0,139,130,1,0,0,0,140,
3,1,0,0,0,141,154,5,17,0,0,142,154,5,16,0,0,143,154,5,18,0,0,144,154,5,15,
0,0,145,149,5,25,0,0,146,148,3,4,2,0,147,146,1,0,0,0,148,151,1,0,0,0,149,
147,1,0,0,0,149,150,1,0,0,0,150,152,1,0,0,0,151,149,1,0,0,0,152,154,5,26,
0,0,153,141,1,0,0,0,153,142,1,0,0,0,153,143,1,0,0,0,153,144,1,0,0,0,153,
145,1,0,0,0,154,5,1,0,0,0,17,11,21,30,39,48,57,66,75,84,99,108,117,126,135,
139,149,153];


const atn = new antlr4.atn.ATNDeserializer().deserialize(serializedATN);

const decisionsToDFA = atn.decisionToState.map( (ds, index) => new antlr4.dfa.DFA(ds, index) );

const sharedContextCache = new antlr4.PredictionContextCache();

export default class CMakeParser extends antlr4.Parser {

    static grammarFileName = "java-escape";
    static literalNames = [ null, "'if'", "'elseif'", "'else'", "'endif'", 
                            "'foreach'", "'endforeach'", "'while'", "'endwhile'", 
                            "'break'", "'continue'", "'function'", "'endfunction'", 
                            "'macro'", "'endmacro'", null, null, null, null, 
                            null, null, null, null, null, null, "'('", "')'" ];
    static symbolicNames = [ null, null, null, null, null, null, null, null, 
                             null, null, null, null, null, null, null, "ID", 
                             "BracketArgument", "QuotedArgument", "UnquotedArgument", 
                             "BracketComment", "LineComment", "IgnoreNLBetweenArgs", 
                             "IgnoreExtraNLBetweenCmds", "NL", "WS", "LParen", 
                             "RParen", "Escape" ];
    static ruleNames = [ "file", "command", "argument" ];

    constructor(input) {
        super(input);
        this._interp = new antlr4.atn.ParserATNSimulator(this, atn, decisionsToDFA, sharedContextCache);
        this.ruleNames = CMakeParser.ruleNames;
        this.literalNames = CMakeParser.literalNames;
        this.symbolicNames = CMakeParser.symbolicNames;
    }

    get atn() {
        return atn;
    }



	file() {
	    let localctx = new FileContext(this, this._ctx, this.state);
	    this.enterRule(localctx, 0, CMakeParser.RULE_file);
	    var _la = 0; // Token type
	    try {
	        this.enterOuterAlt(localctx, 1);
	        this.state = 11;
	        this._errHandler.sync(this);
	        _la = this._input.LA(1);
	        while((((_la) & ~0x1f) == 0 && ((1 << _la) & 65534) !== 0)) {
	            this.state = 6;
	            this.command();
	            this.state = 7;
	            this.match(CMakeParser.NL);
	            this.state = 13;
	            this._errHandler.sync(this);
	            _la = this._input.LA(1);
	        }
	        this.state = 14;
	        this.match(CMakeParser.EOF);
	    } catch (re) {
	    	if(re instanceof antlr4.error.RecognitionException) {
		        localctx.exception = re;
		        this._errHandler.reportError(this, re);
		        this._errHandler.recover(this, re);
		    } else {
		    	throw re;
		    }
	    } finally {
	        this.exitRule();
	    }
	    return localctx;
	}



	command() {
	    let localctx = new CommandContext(this, this._ctx, this.state);
	    this.enterRule(localctx, 2, CMakeParser.RULE_command);
	    var _la = 0; // Token type
	    try {
	        this.state = 139;
	        this._errHandler.sync(this);
	        switch(this._input.LA(1)) {
	        case 1:
	            localctx = new IfCmdContext(this, localctx);
	            this.enterOuterAlt(localctx, 1);
	            this.state = 16;
	            this.match(CMakeParser.T__0);
	            this.state = 17;
	            this.match(CMakeParser.LParen);
	            this.state = 21;
	            this._errHandler.sync(this);
	            _la = this._input.LA(1);
	            while((((_la) & ~0x1f) == 0 && ((1 << _la) & 34045952) !== 0)) {
	                this.state = 18;
	                this.argument();
	                this.state = 23;
	                this._errHandler.sync(this);
	                _la = this._input.LA(1);
	            }
	            this.state = 24;
	            this.match(CMakeParser.RParen);
	            break;
	        case 2:
	            localctx = new ElseIfCmdContext(this, localctx);
	            this.enterOuterAlt(localctx, 2);
	            this.state = 25;
	            this.match(CMakeParser.T__1);
	            this.state = 26;
	            this.match(CMakeParser.LParen);
	            this.state = 30;
	            this._errHandler.sync(this);
	            _la = this._input.LA(1);
	            while((((_la) & ~0x1f) == 0 && ((1 << _la) & 34045952) !== 0)) {
	                this.state = 27;
	                this.argument();
	                this.state = 32;
	                this._errHandler.sync(this);
	                _la = this._input.LA(1);
	            }
	            this.state = 33;
	            this.match(CMakeParser.RParen);
	            break;
	        case 3:
	            localctx = new ElseCmdContext(this, localctx);
	            this.enterOuterAlt(localctx, 3);
	            this.state = 34;
	            this.match(CMakeParser.T__2);
	            this.state = 35;
	            this.match(CMakeParser.LParen);
	            this.state = 39;
	            this._errHandler.sync(this);
	            _la = this._input.LA(1);
	            while((((_la) & ~0x1f) == 0 && ((1 << _la) & 34045952) !== 0)) {
	                this.state = 36;
	                this.argument();
	                this.state = 41;
	                this._errHandler.sync(this);
	                _la = this._input.LA(1);
	            }
	            this.state = 42;
	            this.match(CMakeParser.RParen);
	            break;
	        case 4:
	            localctx = new EndIfCmdContext(this, localctx);
	            this.enterOuterAlt(localctx, 4);
	            this.state = 43;
	            this.match(CMakeParser.T__3);
	            this.state = 44;
	            this.match(CMakeParser.LParen);
	            this.state = 48;
	            this._errHandler.sync(this);
	            _la = this._input.LA(1);
	            while((((_la) & ~0x1f) == 0 && ((1 << _la) & 34045952) !== 0)) {
	                this.state = 45;
	                this.argument();
	                this.state = 50;
	                this._errHandler.sync(this);
	                _la = this._input.LA(1);
	            }
	            this.state = 51;
	            this.match(CMakeParser.RParen);
	            break;
	        case 5:
	            localctx = new ForeachCmdContext(this, localctx);
	            this.enterOuterAlt(localctx, 5);
	            this.state = 52;
	            this.match(CMakeParser.T__4);
	            this.state = 53;
	            this.match(CMakeParser.LParen);
	            this.state = 55; 
	            this._errHandler.sync(this);
	            _la = this._input.LA(1);
	            do {
	                this.state = 54;
	                this.argument();
	                this.state = 57; 
	                this._errHandler.sync(this);
	                _la = this._input.LA(1);
	            } while((((_la) & ~0x1f) == 0 && ((1 << _la) & 34045952) !== 0));
	            this.state = 59;
	            this.match(CMakeParser.RParen);
	            break;
	        case 6:
	            localctx = new EndForeachCmdContext(this, localctx);
	            this.enterOuterAlt(localctx, 6);
	            this.state = 61;
	            this.match(CMakeParser.T__5);
	            this.state = 62;
	            this.match(CMakeParser.LParen);
	            this.state = 66;
	            this._errHandler.sync(this);
	            _la = this._input.LA(1);
	            while((((_la) & ~0x1f) == 0 && ((1 << _la) & 34045952) !== 0)) {
	                this.state = 63;
	                this.argument();
	                this.state = 68;
	                this._errHandler.sync(this);
	                _la = this._input.LA(1);
	            }
	            this.state = 69;
	            this.match(CMakeParser.RParen);
	            break;
	        case 7:
	            localctx = new WhileCmdContext(this, localctx);
	            this.enterOuterAlt(localctx, 7);
	            this.state = 70;
	            this.match(CMakeParser.T__6);
	            this.state = 71;
	            this.match(CMakeParser.LParen);
	            this.state = 73; 
	            this._errHandler.sync(this);
	            _la = this._input.LA(1);
	            do {
	                this.state = 72;
	                this.argument();
	                this.state = 75; 
	                this._errHandler.sync(this);
	                _la = this._input.LA(1);
	            } while((((_la) & ~0x1f) == 0 && ((1 << _la) & 34045952) !== 0));
	            this.state = 77;
	            this.match(CMakeParser.RParen);
	            break;
	        case 8:
	            localctx = new EndWhileCmdContext(this, localctx);
	            this.enterOuterAlt(localctx, 8);
	            this.state = 79;
	            this.match(CMakeParser.T__7);
	            this.state = 80;
	            this.match(CMakeParser.LParen);
	            this.state = 84;
	            this._errHandler.sync(this);
	            _la = this._input.LA(1);
	            while((((_la) & ~0x1f) == 0 && ((1 << _la) & 34045952) !== 0)) {
	                this.state = 81;
	                this.argument();
	                this.state = 86;
	                this._errHandler.sync(this);
	                _la = this._input.LA(1);
	            }
	            this.state = 87;
	            this.match(CMakeParser.RParen);
	            break;
	        case 9:
	            localctx = new BreakCmdContext(this, localctx);
	            this.enterOuterAlt(localctx, 9);
	            this.state = 88;
	            this.match(CMakeParser.T__8);
	            this.state = 89;
	            this.match(CMakeParser.LParen);
	            this.state = 90;
	            this.match(CMakeParser.RParen);
	            break;
	        case 10:
	            localctx = new ContinueCmdContext(this, localctx);
	            this.enterOuterAlt(localctx, 10);
	            this.state = 91;
	            this.match(CMakeParser.T__9);
	            this.state = 92;
	            this.match(CMakeParser.LParen);
	            this.state = 93;
	            this.match(CMakeParser.RParen);
	            break;
	        case 11:
	            localctx = new FunctionCmdContext(this, localctx);
	            this.enterOuterAlt(localctx, 11);
	            this.state = 94;
	            this.match(CMakeParser.T__10);
	            this.state = 95;
	            this.match(CMakeParser.LParen);
	            this.state = 97; 
	            this._errHandler.sync(this);
	            _la = this._input.LA(1);
	            do {
	                this.state = 96;
	                this.argument();
	                this.state = 99; 
	                this._errHandler.sync(this);
	                _la = this._input.LA(1);
	            } while((((_la) & ~0x1f) == 0 && ((1 << _la) & 34045952) !== 0));
	            this.state = 101;
	            this.match(CMakeParser.RParen);
	            break;
	        case 12:
	            localctx = new EndFunctionCmdContext(this, localctx);
	            this.enterOuterAlt(localctx, 12);
	            this.state = 103;
	            this.match(CMakeParser.T__11);
	            this.state = 104;
	            this.match(CMakeParser.LParen);
	            this.state = 108;
	            this._errHandler.sync(this);
	            _la = this._input.LA(1);
	            while((((_la) & ~0x1f) == 0 && ((1 << _la) & 34045952) !== 0)) {
	                this.state = 105;
	                this.argument();
	                this.state = 110;
	                this._errHandler.sync(this);
	                _la = this._input.LA(1);
	            }
	            this.state = 111;
	            this.match(CMakeParser.RParen);
	            break;
	        case 13:
	            localctx = new MacroCmdContext(this, localctx);
	            this.enterOuterAlt(localctx, 13);
	            this.state = 112;
	            this.match(CMakeParser.T__12);
	            this.state = 113;
	            this.match(CMakeParser.LParen);
	            this.state = 115; 
	            this._errHandler.sync(this);
	            _la = this._input.LA(1);
	            do {
	                this.state = 114;
	                this.argument();
	                this.state = 117; 
	                this._errHandler.sync(this);
	                _la = this._input.LA(1);
	            } while((((_la) & ~0x1f) == 0 && ((1 << _la) & 34045952) !== 0));
	            this.state = 119;
	            this.match(CMakeParser.RParen);
	            break;
	        case 14:
	            localctx = new EndMacroCmdContext(this, localctx);
	            this.enterOuterAlt(localctx, 14);
	            this.state = 121;
	            this.match(CMakeParser.T__13);
	            this.state = 122;
	            this.match(CMakeParser.LParen);
	            this.state = 126;
	            this._errHandler.sync(this);
	            _la = this._input.LA(1);
	            while((((_la) & ~0x1f) == 0 && ((1 << _la) & 34045952) !== 0)) {
	                this.state = 123;
	                this.argument();
	                this.state = 128;
	                this._errHandler.sync(this);
	                _la = this._input.LA(1);
	            }
	            this.state = 129;
	            this.match(CMakeParser.RParen);
	            break;
	        case 15:
	            localctx = new OtherCmdContext(this, localctx);
	            this.enterOuterAlt(localctx, 15);
	            this.state = 130;
	            this.match(CMakeParser.ID);
	            this.state = 131;
	            this.match(CMakeParser.LParen);
	            this.state = 135;
	            this._errHandler.sync(this);
	            _la = this._input.LA(1);
	            while((((_la) & ~0x1f) == 0 && ((1 << _la) & 34045952) !== 0)) {
	                this.state = 132;
	                this.argument();
	                this.state = 137;
	                this._errHandler.sync(this);
	                _la = this._input.LA(1);
	            }
	            this.state = 138;
	            this.match(CMakeParser.RParen);
	            break;
	        default:
	            throw new antlr4.error.NoViableAltException(this);
	        }
	    } catch (re) {
	    	if(re instanceof antlr4.error.RecognitionException) {
		        localctx.exception = re;
		        this._errHandler.reportError(this, re);
		        this._errHandler.recover(this, re);
		    } else {
		    	throw re;
		    }
	    } finally {
	        this.exitRule();
	    }
	    return localctx;
	}



	argument() {
	    let localctx = new ArgumentContext(this, this._ctx, this.state);
	    this.enterRule(localctx, 4, CMakeParser.RULE_argument);
	    var _la = 0; // Token type
	    try {
	        this.state = 153;
	        this._errHandler.sync(this);
	        switch(this._input.LA(1)) {
	        case 17:
	            this.enterOuterAlt(localctx, 1);
	            this.state = 141;
	            this.match(CMakeParser.QuotedArgument);
	            break;
	        case 16:
	            this.enterOuterAlt(localctx, 2);
	            this.state = 142;
	            this.match(CMakeParser.BracketArgument);
	            break;
	        case 18:
	            this.enterOuterAlt(localctx, 3);
	            this.state = 143;
	            this.match(CMakeParser.UnquotedArgument);
	            break;
	        case 15:
	            this.enterOuterAlt(localctx, 4);
	            this.state = 144;
	            this.match(CMakeParser.ID);
	            break;
	        case 25:
	            this.enterOuterAlt(localctx, 5);
	            this.state = 145;
	            this.match(CMakeParser.LParen);
	            this.state = 149;
	            this._errHandler.sync(this);
	            _la = this._input.LA(1);
	            while((((_la) & ~0x1f) == 0 && ((1 << _la) & 34045952) !== 0)) {
	                this.state = 146;
	                this.argument();
	                this.state = 151;
	                this._errHandler.sync(this);
	                _la = this._input.LA(1);
	            }
	            this.state = 152;
	            this.match(CMakeParser.RParen);
	            break;
	        default:
	            throw new antlr4.error.NoViableAltException(this);
	        }
	    } catch (re) {
	    	if(re instanceof antlr4.error.RecognitionException) {
		        localctx.exception = re;
		        this._errHandler.reportError(this, re);
		        this._errHandler.recover(this, re);
		    } else {
		    	throw re;
		    }
	    } finally {
	        this.exitRule();
	    }
	    return localctx;
	}


}

CMakeParser.EOF = antlr4.Token.EOF;
CMakeParser.T__0 = 1;
CMakeParser.T__1 = 2;
CMakeParser.T__2 = 3;
CMakeParser.T__3 = 4;
CMakeParser.T__4 = 5;
CMakeParser.T__5 = 6;
CMakeParser.T__6 = 7;
CMakeParser.T__7 = 8;
CMakeParser.T__8 = 9;
CMakeParser.T__9 = 10;
CMakeParser.T__10 = 11;
CMakeParser.T__11 = 12;
CMakeParser.T__12 = 13;
CMakeParser.T__13 = 14;
CMakeParser.ID = 15;
CMakeParser.BracketArgument = 16;
CMakeParser.QuotedArgument = 17;
CMakeParser.UnquotedArgument = 18;
CMakeParser.BracketComment = 19;
CMakeParser.LineComment = 20;
CMakeParser.IgnoreNLBetweenArgs = 21;
CMakeParser.IgnoreExtraNLBetweenCmds = 22;
CMakeParser.NL = 23;
CMakeParser.WS = 24;
CMakeParser.LParen = 25;
CMakeParser.RParen = 26;
CMakeParser.Escape = 27;

CMakeParser.RULE_file = 0;
CMakeParser.RULE_command = 1;
CMakeParser.RULE_argument = 2;

class FileContext extends antlr4.ParserRuleContext {

    constructor(parser, parent, invokingState) {
        if(parent===undefined) {
            parent = null;
        }
        if(invokingState===undefined || invokingState===null) {
            invokingState = -1;
        }
        super(parent, invokingState);
        this.parser = parser;
        this.ruleIndex = CMakeParser.RULE_file;
    }

	EOF() {
	    return this.getToken(CMakeParser.EOF, 0);
	};

	command = function(i) {
	    if(i===undefined) {
	        i = null;
	    }
	    if(i===null) {
	        return this.getTypedRuleContexts(CommandContext);
	    } else {
	        return this.getTypedRuleContext(CommandContext,i);
	    }
	};

	NL = function(i) {
		if(i===undefined) {
			i = null;
		}
	    if(i===null) {
	        return this.getTokens(CMakeParser.NL);
	    } else {
	        return this.getToken(CMakeParser.NL, i);
	    }
	};


	enterRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.enterFile(this);
		}
	}

	exitRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.exitFile(this);
		}
	}


}



class CommandContext extends antlr4.ParserRuleContext {

    constructor(parser, parent, invokingState) {
        if(parent===undefined) {
            parent = null;
        }
        if(invokingState===undefined || invokingState===null) {
            invokingState = -1;
        }
        super(parent, invokingState);
        this.parser = parser;
        this.ruleIndex = CMakeParser.RULE_command;
    }


	 
		copyFrom(ctx) {
			super.copyFrom(ctx);
		}

}


class OtherCmdContext extends CommandContext {

    constructor(parser, ctx) {
        super(parser);
        super.copyFrom(ctx);
    }

	ID() {
	    return this.getToken(CMakeParser.ID, 0);
	};

	LParen() {
	    return this.getToken(CMakeParser.LParen, 0);
	};

	RParen() {
	    return this.getToken(CMakeParser.RParen, 0);
	};

	argument = function(i) {
	    if(i===undefined) {
	        i = null;
	    }
	    if(i===null) {
	        return this.getTypedRuleContexts(ArgumentContext);
	    } else {
	        return this.getTypedRuleContext(ArgumentContext,i);
	    }
	};

	enterRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.enterOtherCmd(this);
		}
	}

	exitRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.exitOtherCmd(this);
		}
	}


}

CMakeParser.OtherCmdContext = OtherCmdContext;

class FunctionCmdContext extends CommandContext {

    constructor(parser, ctx) {
        super(parser);
        super.copyFrom(ctx);
    }

	LParen() {
	    return this.getToken(CMakeParser.LParen, 0);
	};

	RParen() {
	    return this.getToken(CMakeParser.RParen, 0);
	};

	argument = function(i) {
	    if(i===undefined) {
	        i = null;
	    }
	    if(i===null) {
	        return this.getTypedRuleContexts(ArgumentContext);
	    } else {
	        return this.getTypedRuleContext(ArgumentContext,i);
	    }
	};

	enterRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.enterFunctionCmd(this);
		}
	}

	exitRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.exitFunctionCmd(this);
		}
	}


}

CMakeParser.FunctionCmdContext = FunctionCmdContext;

class EndMacroCmdContext extends CommandContext {

    constructor(parser, ctx) {
        super(parser);
        super.copyFrom(ctx);
    }

	LParen() {
	    return this.getToken(CMakeParser.LParen, 0);
	};

	RParen() {
	    return this.getToken(CMakeParser.RParen, 0);
	};

	argument = function(i) {
	    if(i===undefined) {
	        i = null;
	    }
	    if(i===null) {
	        return this.getTypedRuleContexts(ArgumentContext);
	    } else {
	        return this.getTypedRuleContext(ArgumentContext,i);
	    }
	};

	enterRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.enterEndMacroCmd(this);
		}
	}

	exitRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.exitEndMacroCmd(this);
		}
	}


}

CMakeParser.EndMacroCmdContext = EndMacroCmdContext;

class IfCmdContext extends CommandContext {

    constructor(parser, ctx) {
        super(parser);
        super.copyFrom(ctx);
    }

	LParen() {
	    return this.getToken(CMakeParser.LParen, 0);
	};

	RParen() {
	    return this.getToken(CMakeParser.RParen, 0);
	};

	argument = function(i) {
	    if(i===undefined) {
	        i = null;
	    }
	    if(i===null) {
	        return this.getTypedRuleContexts(ArgumentContext);
	    } else {
	        return this.getTypedRuleContext(ArgumentContext,i);
	    }
	};

	enterRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.enterIfCmd(this);
		}
	}

	exitRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.exitIfCmd(this);
		}
	}


}

CMakeParser.IfCmdContext = IfCmdContext;

class EndForeachCmdContext extends CommandContext {

    constructor(parser, ctx) {
        super(parser);
        super.copyFrom(ctx);
    }

	LParen() {
	    return this.getToken(CMakeParser.LParen, 0);
	};

	RParen() {
	    return this.getToken(CMakeParser.RParen, 0);
	};

	argument = function(i) {
	    if(i===undefined) {
	        i = null;
	    }
	    if(i===null) {
	        return this.getTypedRuleContexts(ArgumentContext);
	    } else {
	        return this.getTypedRuleContext(ArgumentContext,i);
	    }
	};

	enterRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.enterEndForeachCmd(this);
		}
	}

	exitRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.exitEndForeachCmd(this);
		}
	}


}

CMakeParser.EndForeachCmdContext = EndForeachCmdContext;

class EndWhileCmdContext extends CommandContext {

    constructor(parser, ctx) {
        super(parser);
        super.copyFrom(ctx);
    }

	LParen() {
	    return this.getToken(CMakeParser.LParen, 0);
	};

	RParen() {
	    return this.getToken(CMakeParser.RParen, 0);
	};

	argument = function(i) {
	    if(i===undefined) {
	        i = null;
	    }
	    if(i===null) {
	        return this.getTypedRuleContexts(ArgumentContext);
	    } else {
	        return this.getTypedRuleContext(ArgumentContext,i);
	    }
	};

	enterRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.enterEndWhileCmd(this);
		}
	}

	exitRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.exitEndWhileCmd(this);
		}
	}


}

CMakeParser.EndWhileCmdContext = EndWhileCmdContext;

class BreakCmdContext extends CommandContext {

    constructor(parser, ctx) {
        super(parser);
        super.copyFrom(ctx);
    }

	LParen() {
	    return this.getToken(CMakeParser.LParen, 0);
	};

	RParen() {
	    return this.getToken(CMakeParser.RParen, 0);
	};

	enterRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.enterBreakCmd(this);
		}
	}

	exitRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.exitBreakCmd(this);
		}
	}


}

CMakeParser.BreakCmdContext = BreakCmdContext;

class MacroCmdContext extends CommandContext {

    constructor(parser, ctx) {
        super(parser);
        super.copyFrom(ctx);
    }

	LParen() {
	    return this.getToken(CMakeParser.LParen, 0);
	};

	RParen() {
	    return this.getToken(CMakeParser.RParen, 0);
	};

	argument = function(i) {
	    if(i===undefined) {
	        i = null;
	    }
	    if(i===null) {
	        return this.getTypedRuleContexts(ArgumentContext);
	    } else {
	        return this.getTypedRuleContext(ArgumentContext,i);
	    }
	};

	enterRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.enterMacroCmd(this);
		}
	}

	exitRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.exitMacroCmd(this);
		}
	}


}

CMakeParser.MacroCmdContext = MacroCmdContext;

class ElseIfCmdContext extends CommandContext {

    constructor(parser, ctx) {
        super(parser);
        super.copyFrom(ctx);
    }

	LParen() {
	    return this.getToken(CMakeParser.LParen, 0);
	};

	RParen() {
	    return this.getToken(CMakeParser.RParen, 0);
	};

	argument = function(i) {
	    if(i===undefined) {
	        i = null;
	    }
	    if(i===null) {
	        return this.getTypedRuleContexts(ArgumentContext);
	    } else {
	        return this.getTypedRuleContext(ArgumentContext,i);
	    }
	};

	enterRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.enterElseIfCmd(this);
		}
	}

	exitRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.exitElseIfCmd(this);
		}
	}


}

CMakeParser.ElseIfCmdContext = ElseIfCmdContext;

class EndIfCmdContext extends CommandContext {

    constructor(parser, ctx) {
        super(parser);
        super.copyFrom(ctx);
    }

	LParen() {
	    return this.getToken(CMakeParser.LParen, 0);
	};

	RParen() {
	    return this.getToken(CMakeParser.RParen, 0);
	};

	argument = function(i) {
	    if(i===undefined) {
	        i = null;
	    }
	    if(i===null) {
	        return this.getTypedRuleContexts(ArgumentContext);
	    } else {
	        return this.getTypedRuleContext(ArgumentContext,i);
	    }
	};

	enterRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.enterEndIfCmd(this);
		}
	}

	exitRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.exitEndIfCmd(this);
		}
	}


}

CMakeParser.EndIfCmdContext = EndIfCmdContext;

class ForeachCmdContext extends CommandContext {

    constructor(parser, ctx) {
        super(parser);
        super.copyFrom(ctx);
    }

	LParen() {
	    return this.getToken(CMakeParser.LParen, 0);
	};

	RParen() {
	    return this.getToken(CMakeParser.RParen, 0);
	};

	argument = function(i) {
	    if(i===undefined) {
	        i = null;
	    }
	    if(i===null) {
	        return this.getTypedRuleContexts(ArgumentContext);
	    } else {
	        return this.getTypedRuleContext(ArgumentContext,i);
	    }
	};

	enterRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.enterForeachCmd(this);
		}
	}

	exitRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.exitForeachCmd(this);
		}
	}


}

CMakeParser.ForeachCmdContext = ForeachCmdContext;

class WhileCmdContext extends CommandContext {

    constructor(parser, ctx) {
        super(parser);
        super.copyFrom(ctx);
    }

	LParen() {
	    return this.getToken(CMakeParser.LParen, 0);
	};

	RParen() {
	    return this.getToken(CMakeParser.RParen, 0);
	};

	argument = function(i) {
	    if(i===undefined) {
	        i = null;
	    }
	    if(i===null) {
	        return this.getTypedRuleContexts(ArgumentContext);
	    } else {
	        return this.getTypedRuleContext(ArgumentContext,i);
	    }
	};

	enterRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.enterWhileCmd(this);
		}
	}

	exitRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.exitWhileCmd(this);
		}
	}


}

CMakeParser.WhileCmdContext = WhileCmdContext;

class ContinueCmdContext extends CommandContext {

    constructor(parser, ctx) {
        super(parser);
        super.copyFrom(ctx);
    }

	LParen() {
	    return this.getToken(CMakeParser.LParen, 0);
	};

	RParen() {
	    return this.getToken(CMakeParser.RParen, 0);
	};

	enterRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.enterContinueCmd(this);
		}
	}

	exitRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.exitContinueCmd(this);
		}
	}


}

CMakeParser.ContinueCmdContext = ContinueCmdContext;

class EndFunctionCmdContext extends CommandContext {

    constructor(parser, ctx) {
        super(parser);
        super.copyFrom(ctx);
    }

	LParen() {
	    return this.getToken(CMakeParser.LParen, 0);
	};

	RParen() {
	    return this.getToken(CMakeParser.RParen, 0);
	};

	argument = function(i) {
	    if(i===undefined) {
	        i = null;
	    }
	    if(i===null) {
	        return this.getTypedRuleContexts(ArgumentContext);
	    } else {
	        return this.getTypedRuleContext(ArgumentContext,i);
	    }
	};

	enterRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.enterEndFunctionCmd(this);
		}
	}

	exitRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.exitEndFunctionCmd(this);
		}
	}


}

CMakeParser.EndFunctionCmdContext = EndFunctionCmdContext;

class ElseCmdContext extends CommandContext {

    constructor(parser, ctx) {
        super(parser);
        super.copyFrom(ctx);
    }

	LParen() {
	    return this.getToken(CMakeParser.LParen, 0);
	};

	RParen() {
	    return this.getToken(CMakeParser.RParen, 0);
	};

	argument = function(i) {
	    if(i===undefined) {
	        i = null;
	    }
	    if(i===null) {
	        return this.getTypedRuleContexts(ArgumentContext);
	    } else {
	        return this.getTypedRuleContext(ArgumentContext,i);
	    }
	};

	enterRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.enterElseCmd(this);
		}
	}

	exitRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.exitElseCmd(this);
		}
	}


}

CMakeParser.ElseCmdContext = ElseCmdContext;

class ArgumentContext extends antlr4.ParserRuleContext {

    constructor(parser, parent, invokingState) {
        if(parent===undefined) {
            parent = null;
        }
        if(invokingState===undefined || invokingState===null) {
            invokingState = -1;
        }
        super(parent, invokingState);
        this.parser = parser;
        this.ruleIndex = CMakeParser.RULE_argument;
    }

	QuotedArgument() {
	    return this.getToken(CMakeParser.QuotedArgument, 0);
	};

	BracketArgument() {
	    return this.getToken(CMakeParser.BracketArgument, 0);
	};

	UnquotedArgument() {
	    return this.getToken(CMakeParser.UnquotedArgument, 0);
	};

	ID() {
	    return this.getToken(CMakeParser.ID, 0);
	};

	LParen() {
	    return this.getToken(CMakeParser.LParen, 0);
	};

	RParen() {
	    return this.getToken(CMakeParser.RParen, 0);
	};

	argument = function(i) {
	    if(i===undefined) {
	        i = null;
	    }
	    if(i===null) {
	        return this.getTypedRuleContexts(ArgumentContext);
	    } else {
	        return this.getTypedRuleContext(ArgumentContext,i);
	    }
	};

	enterRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.enterArgument(this);
		}
	}

	exitRule(listener) {
	    if(listener instanceof CMakeListener ) {
	        listener.exitArgument(this);
		}
	}


}




CMakeParser.FileContext = FileContext; 
CMakeParser.CommandContext = CommandContext; 
CMakeParser.ArgumentContext = ArgumentContext; 
