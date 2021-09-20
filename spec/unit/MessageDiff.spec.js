"use strict";
const { messageDiff } = require("../../lib/util/MessageDiff.js");

describe('messageDiff', function() {
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
        [
            'should not use diffs with newlines in them',
            'a\nb\nc', 'bla\nbleh\nc',
            's/a/bla/, s/b/bleh/',
        ],
        [
            'should only show small portion of the message when a new word is added',
            'this is a message where i a word', 'this is a message where i missed a word',
            '* where i missed a word',
        ],
        [
            'should only show small portion of the message when a new word is added at the beginning',
            'get lunch now, be back a bit later', 'gonna get lunch now, be back a bit later',
            '* gonna get lunch',
        ],
        [
            'should only show small portion of the message when a new word is added at the beginning',
            "I'm gonna get lunch now", "I'm gonna get lunch now, bbl",
            '* lunch now, bbl',
        ],
        [
            'should show word removals as s/foo//',
            'I gotta go clean up my filthy room', 'I gotta go clean up my room',
            's/filthy//'
        ],
    ].forEach(c => it(c[0], () => {
        const result = messageDiff(c[1], c[2]);
        expect(result).toBe(c[3]);
    }));
});
