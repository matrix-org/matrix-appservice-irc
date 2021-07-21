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

// since trimRight()/trimEnd() may break unicode characters
function trimTrailingWhitespace(input: string): string {
    return input.replace(/\s*$/u, '');
}

// a unicode-aware substring(0, $x) that tries to not break words if possible
export function trimString(input: string, maxLength: number): string {
    const re = new RegExp(`^([\\s\\S]{0,${maxLength}})(\\p{L}?)`, 'u');
    const match = input.match(re);

    if (!match) {
        // fallback to a dumb substring() if the regex failed for any reason
        return trimTrailingWhitespace(input.substring(0, maxLength));
    }

    const trimmed = trimTrailingWhitespace(match[1]);

    if (match[2]) {
        // find as much as you can that is followed by a word boundary,
        // shorter than what we have now, but at least 75% of the desired length
        const smallerMatch = trimmed.match(/^([\s\S]*\S)\b[\s\S]/u);
        const minLength = maxLength * 0.75;

        if (smallerMatch && smallerMatch[1].length >= minLength) {
            return smallerMatch[1];
        }
    }

    return trimmed;
}
