"use strict";
const { niceDiff } = require("../../lib/util/NiceDiff.js");

describe("niceDiff", function() {
    [
        [
            'should not generate a diff if the message is short enough',
            'hello everyone', 'hello world',
            undefined,
        ],
        [
            'should generate a diff for short, multiline messages',
            'one\nfoo\nthree', 'one\ntwo\nthree',
            's/foo/two/',
        ],
        [
            'should generate sed-like substitution when a short part of the message changes',
            "Sounds good – I'll be there before 9", "Sounds good – I'll be there after 9",
            's/before/after/'
        ],
        [
            'should only show changes from the line that has changed in multiline messages',
            'in a marmalade forest\nbetween the make-believe trees\nI forgot the third verse, sorry',
            'in a marmalade forest\nbetween the make-believe trees\nin a cottage-cheese cottage...',
            's/I forgot the third verse, sorry/in a cottage-cheese cottage.../',
        ],
    ].forEach(c => it(c[0], () => {
        const result = niceDiff(c[1], c[2]);
        console.log(`"${c[1]}" -> "${c[2]}" -> ${result}`);
        expect(result).toBe(c[3]);
    }));
});
