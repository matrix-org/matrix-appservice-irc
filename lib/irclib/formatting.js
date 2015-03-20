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
    //                  Foreground          Background
    //                 ______|_______       ____|____
    //                /              \     /         \
    var colorRegex = /(\003[0-9]{1,2})[,]?([0-9]{1,2})?([^\003]+)/;
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
        [/\002([^\002]+)(\002)?/, ["<b>", "</b>"]],
        [/\037([^\037]+)(\037)?/, ["<u>", "</u>"]],
        [/\035([^\035]+)(\035)?/, ["<i>", "</i>"]]
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