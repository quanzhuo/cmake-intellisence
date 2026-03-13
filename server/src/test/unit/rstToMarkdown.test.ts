import * as assert from 'assert';
import { rstToMarkdown } from '../../rstToMarkdown';

suite('RST to Markdown Tests', () => {
    test('converts command docs into markdown headings and fences', () => {
        const input = `add_subdirectory
----------------

Add a subdirectory to the build.

 add_subdirectory(source_dir [binary_dir] [EXCLUDE_FROM_ALL] [SYSTEM])

Adds a subdirectory to the build. The \`\`source_dir\`\` specifies the directory.

.. versionadded:: 3.25
  If the \`\`SYSTEM\`\` argument is provided, the \`\`SYSTEM\`\` directory
  property will be set to true.
`;

        const result = rstToMarkdown(input);

        assert(result.includes('## add_subdirectory'));
        assert(result.includes('```cmake\nadd_subdirectory(source_dir [binary_dir] [EXCLUDE_FROM_ALL] [SYSTEM])\n```'));
        assert(result.includes('The `source_dir` specifies the directory.'));
        assert(result.includes('> **Version added 3.25:** If the `SYSTEM` argument is provided, the `SYSTEM` directory'));
    });

    test('converts notes, roles and code-block directives', () => {
        const input = `find_package
------------

.. note:: The :guide:\`Using Dependencies Guide\` provides an introduction.

Search Modes
^^^^^^^^^^^^

See :ref:\`Full Signature\` for details.

.. code-block:: cmake

  find_package(Foo REQUIRED)

The \`\`FetchContent\`\` module can redirect this command.
`;

        const result = rstToMarkdown(input);

        assert(result.includes('## find_package'));
        assert(result.includes('### Search Modes'));
        assert(result.includes('> **Note:** The Using Dependencies Guide provides an introduction.'));
        assert(result.includes('See Full Signature for details.'));
        assert(result.includes('```cmake\nfind_package(Foo REQUIRED)\n```'));
        assert(result.includes('The `FetchContent` module can redirect this command.'));
    });
});