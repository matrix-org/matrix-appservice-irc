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

// a unicode-aware substring(0, $x)
export function trimString(input: string, maxLength: number): string {
    const re = new RegExp(`^([\\s\\S]{0,${maxLength}})`, 'u');
    const match = input.match(re);

    let trimmed: string;
    if (match) {
        trimmed = match[1];
    }
    else {
        // fallback to a dumb substring() if the regex failed for any reason
        trimmed = input.substring(0, maxLength);
    }
    //
    // trimRight()/trimEnd() may break unicode characters
    return trimmed.replace(/\s*$/u, '');
}
