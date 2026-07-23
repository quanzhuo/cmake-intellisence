import * as assert from 'assert';
import { URI } from 'vscode-uri';
import { DocumentLinkInfo } from '../../docLink';
import { parseCMakeText } from '../../utils';

suite('Document Link Range Tests', () => {
    test('link ranges should preserve multiline argument coordinates', () => {
        const command = parseCMakeText('configure_file("first\nsecond" output)').flatCommands[0];
        const argument = command.argument_list()[0];
        const linkInfo = Object.create(DocumentLinkInfo.prototype) as {
            createLink: (arg: typeof argument, target: URI) => { range: unknown };
        };

        const link = linkInfo.createLink(argument, URI.file('/target'));

        assert.deepStrictEqual(link.range, {
            start: { line: 0, character: 'configure_file('.length },
            end: { line: 1, character: 'second"'.length },
        });
    });
});
