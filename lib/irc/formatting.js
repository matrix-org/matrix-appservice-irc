"use strict";

const sanitizeHtml = require('sanitize-html');
const htmlNamesToColorCodes = {
    white:     ['00', '0'],
    black:     ['01', '1'],
    navy:      ['02', '2'],
    green:     ['03', '3'],
    red:       ['04', '4'],
    maroon:    ['05', '5'],
    purple:    ['06', '6'],
    orange:    ['07', '7'],
    yellow:    ['08', '8'],
    lime:      ['09', '9'],
    teal:      ['10'],
    aqua:      ['11'],
    blue:      ['12'],
    fuchsia:   ['13'],
    gray:      ['14'],
    lightgrey: ['15']
};

// These map the CSS color names to mIRC hex colors
const htmlNamesToHex = {
    white:     '#FFFFFF',
    black:     '#000000',
    navy:      '#00007F',
    green:     '#009300',
    red:       '#FF0000',
    maroon:    '#7F0000',
    purple:    '#9C009C',
    orange:    '#FC7F00',
    yellow:    '#FFFF00',
    lime:      '#00FC00',
    teal:      '#009393',
    aqua:      '#00FFFF',
    blue:      '#0000FC',
    fuchsia:   '#FF00FF',
    gray:      '#7F7F7F',
    lightgrey: '#D2D2D2'
};

// store the reverse mapping
var colorCodesToHtmlNames = {};
var htmlNames = Object.keys(htmlNamesToColorCodes);
htmlNames.forEach(function(htmlName) {
    htmlNamesToColorCodes[htmlName].forEach(function(colorNum) {
        colorCodesToHtmlNames[colorNum] = htmlNamesToHex[htmlName];
    });
});

const STYLE_COLOR = '\u0003';
const STYLE_BOLD = '\u0002';
const STYLE_ITALICS = '\u001d';
const STYLE_UNDERLINE = '\u001f';
const STYLE_CODES = [STYLE_BOLD, STYLE_ITALICS, STYLE_UNDERLINE];
const RESET_CODE = '\u000f';
const REVERSE_CODE = '\u0016';

/**
 * This is used as the default state for irc to html conversion.
 * The color attributes (color and bcolor) can be:
 *  - null for no colour, or
 *  - a string with an HTML/CSS colour.
 *
 * @type {{color: (null|string), bcolor: (null|string), history: Array}}
 */
const STYLE_DEFAULT_STATE = {
    "color": null, // The foreground colour.
    "bcolor": null, // The background colour.
    "history": [] // The history of opened tags. See the htmlTag function.
};

function escapeHtmlChars(text) {
    return text
         .replace(/&/g, "&amp;")
         .replace(/</g, "&lt;")
         .replace(/>/g, "&gt;")
         .replace(/"/g, "&quot;")
         .replace(/'/g, "&#39;"); // to work on HTML4 (&apos; is HTML5 only)
}

// It's useful!
module.exports.escapeHtmlChars = escapeHtmlChars;

/**
 * Given the state of the message, open or close an HTML tag with the
 * appropriate attributes.
 *
 * Tags are stored in an array, which is used as a stack.
 * Opening a tag is always pushed to the end. This can happen multiple times
 * for nested tags of the same type.
 * Closing a tag closes all tags up to the most recent corresponding tag in
 * the history, and re-opens the ones opened after. Nothing happens if the tag
 * doesn't exist.
 *
 * @param {Object} state Current state of a message
 * @param {string} name Name of the HTML tag.
 * @param {boolean} open Open or close the tag (optional) .
 *                       Detected automatically when omitted.
 * @returns {string} Text containing the relevant open/closing tags.
 */
function htmlTag(state, name, open) {
    let text = '';

    if (typeof open === 'undefined') {
        open = (state.history.indexOf(name) === -1);
    }

    if (open) {
        state.history.push(name);
        if (name === 'font') {
            // Create style from state
            let style = '';
            if (state.color) {
                style += ' color="' + state.color + '"';
            }
            if (state.bcolor) {
                style += ' data-mx-bg-color="' + state.bcolor + '"';
            }
            text = '<font' + style + '>';
        }
        else {
            text = '<' + name + '>';
        }
    }
    else {
        // Get tags that need to be closed
        let index = name === 'all' ? 0 : state.history.lastIndexOf(name);
        let tags = state.history.splice(index);

        // Close tags
        tags.reverse().forEach( function(t) {
            text += '</' + t + '>';
        });

        // Open tags again
        if (name !== 'all') {
            tags.slice(0, -1).forEach( function (t) {
                text += htmlTag(state, t, true);
            });
        }
    }
    return text;
}

module.exports.stripIrcFormatting = function(text) {
    return text
        .replace(/(\x03\d{0,2}(,\d{0,2})?|\u200B)/g, '') // strip colors
        .replace(/[\x0F\x02\x16\x1F\x1D]/g, ''); // styles too
};

module.exports.htmlToIrc = function(html) {
    if (!html) {
        return html;
    }

    // Sanitize the HTML first to allow us to regex parse this (which also does
    // things like case-sensitivity and spacing)
    var cleanHtml = sanitizeHtml(html, {
        allowedTags: ["b", "i", "u", "strong", "font", "em"],
        allowedAttributes: {
            font: ["color"]
        }
    });
    if (cleanHtml !== html) {
        // There are unrecognised tags. Let's play it safe and break, we can always
        // use the fallback text.
        return null;
    }

    // noddy find/replace on OPEN tags is possible now
    var replacements = [
        [/<b>/g, STYLE_BOLD], [/<u>/g, STYLE_UNDERLINE], [/<i>/g, STYLE_ITALICS],
        [/<strong>/g, STYLE_BOLD], [/<em>/g, STYLE_ITALICS]
    ];
    Object.keys(htmlNamesToColorCodes).forEach(function(htmlColor) {
        replacements.push([
            new RegExp('<font color="' + htmlColor + '">', 'g'),
            STYLE_COLOR + htmlNamesToColorCodes[htmlColor][0]
        ]);
    });
    for (var i = 0; i < replacements.length; i++) {
        var rep = replacements[i];
        cleanHtml = cleanHtml.replace(rep[0], rep[1]);
    }
    // this needs a single pass through to fix up the reset codes, as they
    // 'close' all open tags. This pass through checks which tags are open and
    // then reopens them after a reset code.
    var openStyleCodes = [];
    var closeTagsToStyle = {
        "</b>": STYLE_BOLD,
        "</u>": STYLE_UNDERLINE,
        "</i>": STYLE_ITALICS,
        "</em>": STYLE_ITALICS,
        "</strong>": STYLE_BOLD
    };
    var closeTags = Object.keys(closeTagsToStyle);
    var replacement;
    for (i = 0; i < cleanHtml.length; i++) {
        var ch = cleanHtml[i];
        if (STYLE_CODES.indexOf(ch) >= 0) {
            openStyleCodes.push(ch);
        }
        else if (ch === "<") {
            if (cleanHtml.indexOf("</font>", i) === i) {
                replacement = RESET_CODE + openStyleCodes.join("");
                cleanHtml = cleanHtml.replace(
                    "</font>", replacement
                );
                i += (replacement.length - 1);
            }
            else {
                for (var closeTagIndex = 0; closeTagIndex < closeTags.length; closeTagIndex++) {
                    var closeTag = closeTags[closeTagIndex];
                    if (cleanHtml.indexOf(closeTag, i) === i) {
                        // replace close tag with a reset and pop off the open
                        // formatting code, then reopen remaining tags
                        openStyleCodes.splice(openStyleCodes.indexOf(
                            closeTagsToStyle[closeTag]
                        ), 1);
                        replacement = RESET_CODE + openStyleCodes.join("");
                        cleanHtml = cleanHtml.replace(
                            closeTag, replacement
                        );
                        i += (replacement.length - 1);
                    }
                }
            }
        }
    }
    // sanitize any other tags that are left. We don't know how to handle 'em.
    cleanHtml = cleanHtml.replace(/<[^>]+>/gm, "");

    // unescape html characters
    var escapeChars = [
        [/&gt;/g, '>'], [/&lt;/g, '<'], [/&quot;/g, '"'], [/&amp;/g, '&']
    ];
    escapeChars.forEach(function(escapeSet) {
        cleanHtml = cleanHtml.replace(escapeSet[0], escapeSet[1]);
    });

    return cleanHtml;
};

module.exports.ircToHtml = function(text) {
    // Escape HTML characters and add reset character to close all tags at the end.
    text = escapeHtmlChars(text) + RESET_CODE;

    // Replace all mIRC formatting characters.
    // The color character can have arguments.
    // The regex matches:
    // - Any single 'simple' formatting character: \x02, \x1d, \x1f, \x0f and
    //   \x16 for bold, italics, underline, reset and reverse respectively.
    // - The colour formatting character (\x03) followed by 0 to 2 digits for
    //   the foreground colour and (optionally) a comma and 1-2 digits for the
    //   background colour.
    const colorRegex = /[\x02\x1d\x1f\x0f\x16]|\x03(\d{0,2})(?:,(\d{1,2}))?/g;

    // Maintain a small state machine of which tags are open so we can close the right
    // ones on RESET codes and toggle appropriately if they do the same code again.
    let state = Object.assign({}, STYLE_DEFAULT_STATE);

    // Return message with codes replaced
    return text.replace(colorRegex, function(match, fg, bg) {
        let tags = '';

        // Modify state with the current matched formatting character
        switch (match[0]) {
            case STYLE_BOLD:
                return htmlTag(state, 'b');

            case STYLE_ITALICS:
                return htmlTag(state, 'i');

            case STYLE_UNDERLINE:
                return htmlTag(state, 'u');

            case REVERSE_CODE:
                // Swap the foreground and background colours.
                let temp = state.color;
                state.color = state.bcolor;
                state.bcolor = temp;
                // Close and re-open the font tag.
                return htmlTag(state, 'font', false) + htmlTag(state, 'font', true);

            case RESET_CODE:
                // Close tags
                tags = htmlTag(state, 'all', false);
                // Reset state
                state = Object.assign({}, STYLE_DEFAULT_STATE);
                return tags;

            case STYLE_COLOR:
                // Close font tag
                if (state.color || state.bcolor) {
                    tags += htmlTag(state, 'font', false);
                }
                // Foreground colour
                if (fg) {
                    state.color = colorCodesToHtmlNames[fg];
                }
                // Background colour
                if (bg) {
                    state.bcolor = colorCodesToHtmlNames[bg];
                }
                // Neither
                if (!fg && !bg) {
                    state.color = state.bcolor = null;
                }
                // Create font with style
                if (state.color || state.bcolor) {
                    tags += htmlTag(state, 'font', true);
                }
                return tags;

            // Unknown or ignored character
            default:
                return tags;
        }
    });
};

module.exports.toIrcLowerCase = function(str, caseMapping) {
    caseMapping = caseMapping || "rfc1459";
    var lower = str.toLowerCase();
    if (caseMapping === "rfc1459") {
        lower = lower.
        replace(/\[/g, "{").
        replace(/\]/g, "}").
        replace(/\\/g, "|").
        replace(/\^/g, "~");
    }
    else if (caseMapping === "strict-rfc1459") {
        lower = lower.
        replace(/\[/g, "{").
        replace(/\]/g, "}").
        replace(/\\/g, "|");
    }

    return lower;
};
