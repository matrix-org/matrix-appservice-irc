"use strict";
var sanitizeHtml = require('sanitize-html');
var htmlNamesToColorCodes = {
    white: '\u000300',
    black: '\u000301',
    navy: '\u000302',
    green: '\u000303',
    maroon: '\u000304',
    red: '\u000305',
    purple: '\u000306',
    olive: '\u000307',
    yellow: '\u000308',
    lime: '\u000309',
    teal: '\u000310',
    aqua: '\u000311',
    blue: '\u000312',
    fuchsia: '\u000313',
    gray: '\u000314',
    silver: '\u000315'
};
// store the reverse mapping
var colorCodesToHtmlNames = {}; 
var htmlNames = Object.keys(htmlNamesToColorCodes);
for (var i=0; i<htmlNames.length; i++) {
    var htmlName = htmlNames[i];
    colorCodesToHtmlNames[htmlNamesToColorCodes[htmlName]] = htmlName;
}

var STYLE_BOLD = '\u0002';
var STYLE_ITALICS = '\u001d';
var STYLE_UNDERLINE = '\u001f';
var STYLE_CODES = [STYLE_BOLD, STYLE_ITALICS, STYLE_UNDERLINE];
var RESET_CODE = '\u000f';

module.exports.htmlToIrc = function(html) {
    if (!html) {
        return html;
    }

    // Sanitize the HTML first to allow us to regex parse this (which also does
    // things like case-sensitivity and spacing)
    var cleanHtml = sanitizeHtml(html, {
        allowedTags: ["b", "i", "u", "strong", "font"],
        allowedAttributes: {
            font: ["color"]
        }
    });

    // noddy find/replace on OPEN tags is possible now
    var replacements = [
        [/<b>/g, STYLE_BOLD], [/<u>/g, STYLE_UNDERLINE], [/<i>/g, STYLE_ITALICS],
        [/<strong>/g, STYLE_BOLD]
    ];
    Object.keys(htmlNamesToColorCodes).forEach(function(htmlColor) {
        replacements.push([
            new RegExp('<font color="'+htmlColor+'">', 'g'),
            htmlNamesToColorCodes[htmlColor]
        ]);
    });
    for (var i=0; i<replacements.length; i++) {
        var rep = replacements[i];
        cleanHtml = cleanHtml.replace(rep[0], rep[1]);
    }
    // this needs a single pass through to fix up the reset codes, as they
    // 'close' all open tags. This pass through checks which tags are open and
    // then reopens them after a reset code.
    var openStyleCodes = [];
    var openColorCode = null;
    var closeTagsToStyle = {
        "</b>": STYLE_BOLD, 
        "</u>": STYLE_UNDERLINE, 
        "</i>": STYLE_ITALICS, 
        "</strong>": STYLE_BOLD
    };
    var closeTags = Object.keys(closeTagsToStyle);
    var replacement;
    for (var i=0; i<cleanHtml.length; i++) {
        var ch = cleanHtml[i];
        if (STYLE_CODES.indexOf(ch) >= 0) {
            openStyleCodes.push(ch);
        }
        else if (colorCodesToHtmlNames[ch]) {
            openColorCode = ch;
        }
        else if (ch === "<") {
            if (cleanHtml.indexOf("</font>", i) === i) {
                replacement = RESET_CODE + openStyleCodes.join("");
                cleanHtml = cleanHtml.replace(
                    "</font>", replacement
                );
                openColorCode = null;
                i += replacement.length;
            }
            else {
                for (var j=0; j<closeTags.length; j++) {
                    var closeTag = closeTags[j];
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
                        i += replacement.length;
                    }
                }
            }
        }
    }
    return cleanHtml;
};

module.exports.ircToHtml = function(text) {
    // Color codes look like 003xx or 003xx,yy (xx=foreground, yy=background)
    // We want to match until it hits another color (starting 003) or hits the
    // reset code 000f. That is the 'end tag', represented as a non-greedy match
    // for the reset code, or any character until 003.
    //
    //                  Foreground          Background      End 'tag'
    //                 ______|_______       ____|____    _______|________
    //                /              \     /         \  /                \
    var colorRegex = /(\003[0-9]{1,2})[,]?([0-9]{1,2})?(.*?\u000f|[^\003]+)/;
    var groups;
    if (colorRegex.test(text)) {
        while (groups = colorRegex.exec(text)) {
            // ignore bg for now (groups[2])
            var coloredText = groups[3];
            var text = text.replace(
                groups[0],
                '<font color="'+colorCodesToHtmlNames[groups[1]]+'">'+
                coloredText+
                '</font>'
            );
        }
    }

    // styles: bold, italics, underline
    var styleCodes = [
        [/\x02(.*?\x0f|[^\x02]+)(\x02)?/, ["<b>", "</b>"]],
        [/\x1f(.*?\x0f|[^\x1f]+)(\x1f)?/, ["<u>", "</u>"]],
        [/\x1d(.*?\x0f|[^\x1d]+)(\x1d)?/, ["<i>", "</i>"]]
    ];
    for (var i=0; i<styleCodes.length; i++) {
        var styleCode = styleCodes[i]; // [ /regex/ , [ open_tag, close_tag ]]
        var styleRegex = styleCode[0];
        var styleTags = styleCode[1];
        if (styleRegex.test(text)) {
            while (groups = styleRegex.exec(text)) {
                var text = text.replace(
                    groups[0], styleTags[0]+groups[1]+styleTags[1]
                );
            }
        }
    }
    return text;
};