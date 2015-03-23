"use strict";
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



var RESET_CODE = '\u000f';

module.exports.htmlToIrc = function(html) {
    return html;
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