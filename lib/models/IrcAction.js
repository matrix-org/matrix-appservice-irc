"use strict";
var ircFormatting = require("../irc/formatting");
var log = require("../logging").get("IrcAction");

const ACTION_TYPES = ["message", "emote", "topic", "notice"];

function IrcAction(type, text) {
    if (ACTION_TYPES.indexOf(type) === -1) {
        throw new Error("Unknown IrcAction type: " + type);
    }
    this.type = type;
    this.text = text;
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
                return new IrcAction(matrixAction.type, ircText)
            }
            return new IrcAction(matrixAction.type, matrixAction.text);
        case "image":
            return new IrcAction("emote", "uploaded an image: " + matrixAction.text);
        case "video":
            return new IrcAction("emote", "uploaded a video: " + matrixAction.text);
        case "file":
            return new IrcAction("emote", "posted a file: " + matrixAction.text);
        case "topic":
            return new IrcAction(matrixAction.type, matrixAction.text);
        default:
            log.error("IrcAction.fromMatrixAction: Unknown action: %s", matrixAction.type);
            return null;
    }
};

module.exports = IrcAction;
