/*
Copyright 2021 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

import * as Diff from 'diff';

function formatChanges(diff: Diff.Change[]): string[] {
    // true if Change represents... no change
    const noChanges = (change: Diff.Change) => !change.added && !change.removed;

    const substitutions = [];
    let i = 0;
    while (i < diff.length - 1) {
        if (diff[i].removed) {
            let replacement: string;
            if (diff[i+1].added) {
                replacement = diff[i+1].value;
            }
            else if (noChanges(diff[i+1])) {
                replacement = '';
            }
            else {
                i++;
                continue;
            }
            substitutions.push([diff[i].value.trim(), replacement]);
        }
        i++;
    }

    const additions = [];
    // noops before and after so that we can go through
    // the entire thing without caring about bounds
    const paddedDiff = [
        { value: '' } as Diff.Change,
        ...diff,
        { value: '' } as Diff.Change,
    ];
    i = 1;
    while (i < paddedDiff.length - 1) {
        if (noChanges(paddedDiff[i - 1]) && paddedDiff[i].added && noChanges(paddedDiff[i + 1])) {
            // ideally last two words of what was before... (regex always matches)
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const prefix = paddedDiff[i - 1].value.match(/(\S+\s+)?\S*\s*$/)![0];
            // ...and first two words of what followed (regex always matches)
            // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
            const postfix = paddedDiff[i + 1].value.match(/^\S*(\s+\S+)?/)![0];

            additions.push([prefix, paddedDiff[i].value, postfix]);
        }
        i++;
    }

    // if it mixes substitutions and additions, give up - it's not gonna be very readable
    if (substitutions.length > 0 && additions.length === 0) {
        return substitutions.map(c => `s/${c[0]}/${c[1]}/`);
    }
    if (substitutions.length === 0 && additions.length > 0) {
        return additions.map(a => `* ${a.join('')}`);
    }
    return [];
}

// Minimum length of the message for us to try to generate a diff for
const MIN_MESSAGE_LENGTH = 20;
// The maximum number of substitutions that we still consider to be readable
const MAX_SUBSTITUTIONS = 3;

/**
 * Try to find a sensible representation of a message edit,
 * or returns undefined if it deems posting the entire new message
 * to be a better choice. Optimize for terseness, legibility
 * and an IRC-native feel.
 *
 * @param {string} from The original message
 * @param {string} to The new, edited version
 */
export function messageDiff(from: string, to: string): string|undefined {
    // don't bother if the message is short enough
    if (to.length < MIN_MESSAGE_LENGTH && !to.match(/\n/)) {
        return undefined;
    }

    const changesets = [
        formatChanges(Diff.diffWords(from, to)),
        formatChanges(Diff.diffLines(from, to)),
    ].filter(
        diffs => diffs.length > 0 && diffs.length <= MAX_SUBSTITUTIONS
    ).filter(
        // a newline in a diff is a total disaster
        diffs => !diffs.find(diff => diff.match(/\n/))
    ).map(
        diffs => diffs.join(', ')
    ).sort(
        // prefer shorter overall length
        (a, b) => a.length - b.length
    );

    if (changesets.length > 0) {
        return changesets[0];
    }

    return undefined;
}
