/*
 * An action is an event that can be bridged between protocols. A typical
 * example would be a Message, but this could be a topic change, a nick change,
 * etc.
 *
 * The purpose of this file is to provide a standard representation for actions,
 * and provide conversion facilities between them.
 */
"use strict";
var ircFormatting = require("../irclib/formatting");
var log = require("../logging").get("actions");

const ACTION_TYPES = ["message", "emote", "topic", "notice", "file", "image"];
const EVENT_TO_TYPE = {
    "m.room.message": "message",
    "m.room.topic": "topic"
};
const MSGTYPE_TO_TYPE = {
    "m.emote": "emote",
    "m.notice": "notice",
    "m.image": "image",
    "m.file": "file"
};

function MatrixAction(type, text, htmlText) {
    if (ACTION_TYPES.indexOf(type) === -1) {
        throw new Error("Unknown MatrixAction type: " + type);
    }
    this.type = type;
    this.text = text;
    this.htmlText = htmlText;
}
MatrixAction.fromEvent = function(client, event) {
    event.content = event.content || {};
    let type = EVENT_TO_TYPE[event.type] || "message"; // mx event type to action type
    let text = event.content.body;
    let htmlText = null;

    if (event.type === "m.room.topic") {
        text = event.content.topic;
    }
    else if (event.type === "m.room.message") {
        if (event.content.format === "org.matrix.custom.html") {
            htmlText = event.content.formatted_body;
        }
        if (MSGTYPE_TO_TYPE[event.content.msgtype]) {
            type = MSGTYPE_TO_TYPE[event.content.msgtype];
        }
        if (event.content.msgtype === "m.image" || event.content.msgtype === "m.file") {
            var fileSize = "";
            if (event.content.info && event.content.info.size &&
                    typeof event.content.info.size === "number") {
                fileSize = " (" + Math.round(event.content.info.size / 1024) +
                    "KB)";
            }
            text = client.mxcUrlToHttp(event.content.url) +
                    " - " + event.content.body + fileSize;
        }
    }
    return new MatrixAction(type, text, htmlText);
};
MatrixAction.fromIrcAction = function(ircAction) {
    switch (ircAction.type) {
        case "message":
        case "emote":
        case "notice":
            let htmlText = ircFormatting.ircToHtml(ircAction.text);
            return new MatrixAction(
                ircAction.type,
                ircFormatting.stripIrcFormatting(ircAction.text),
                // only set HTML text if we think there is HTML, else the bridge
                // will send everything as HTML and never text only.
                ircAction.text !== htmlText ? htmlText : undefined
            );
        case "topic":
            return new MatrixAction("topic", ircAction.text);
        default:
            log.error("MatrixAction.fromIrcAction: Unknown action: %s", ircAction.type);
            return null;
    }
};

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
                // irc formatted text is the main text part
                return new IrcAction(
                    matrixAction.type, ircFormatting.htmlToIrc(matrixAction.htmlText)
                )
            }
            return new IrcAction(matrixAction.type, matrixAction.text);
        case "image":
            return new IrcAction("message", matrixAction.text);
        case "file":
            return new IrcAction("message", "Posted a File: " + matrixAction.text);
        case "topic":
            return new IrcAction(matrixAction.type, matrixAction.text);
        default:
            log.error("IrcAction.fromMatrixAction: Unknown action: %s", matrixAction.type);
            return null;
    }
};

module.exports.MatrixAction = MatrixAction;
module.exports.IrcAction = IrcAction;
