"use strict";
var ircFormatting = require("../irc/formatting");
var log = require("../logging").get("IrcAction");

const ACTION_TYPES = ["message", "emote", "topic", "notice"];

function IrcAction(type, text, timestamp) {
    if (ACTION_TYPES.indexOf(type) === -1) {
        throw new Error("Unknown IrcAction type: " + type);
    }
    this.type = type;
    this.text = text;
    this.ts = timestamp || 0;
}
IrcAction.fromMatrixAction = function(matrixAction) {
    switch (matrixAction.type) {
        case "message":
        case "emote":
        case "notice":
            if (matrixAction.htmlText) {
                let ircText = ircFormatting.htmlToIrc(matrixAction.htmlText);
                if (ircText === null) {
                    ircText = matrixAction.text; // fallback
                }
                // irc formatted text is the main text part
                return new IrcAction(matrixAction.type, ircText, matrixAction.ts)
            }
            return new IrcAction(matrixAction.type, matrixAction.text, matrixAction.ts);
        case "image":
            return new IrcAction(
                "emote", "uploaded an image: " + matrixAction.text, matrixAction.ts
            );
        case "video":
            return new IrcAction(
                "emote", "uploaded a video: " + matrixAction.text, matrixAction.ts
            );
        case "file":
            return new IrcAction("emote", "posted a file: " + matrixAction.text, matrixAction.ts);
        case "topic":
            return new IrcAction(matrixAction.type, matrixAction.text, matrixAction.ts);
        default:
            log.error("IrcAction.fromMatrixAction: Unknown action: %s", matrixAction.type);
            return null;
    }
};

module.exports = IrcAction;
