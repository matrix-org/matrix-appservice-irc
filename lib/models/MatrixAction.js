"use strict";
var ircFormatting = require("../irc/formatting");
var log = require("../logging").get("MatrixAction");
var ContentRepo = require("matrix-appservice-bridge").ContentRepo;

const ACTION_TYPES = ["message", "emote", "topic", "notice", "file", "image", "video"];
const EVENT_TO_TYPE = {
    "m.room.message": "message",
    "m.room.topic": "topic"
};
const MSGTYPE_TO_TYPE = {
    "m.emote": "emote",
    "m.notice": "notice",
    "m.image": "image",
    "m.video": "video",
    "m.file": "file"
};

function MatrixAction(type, text, htmlText, timestamp) {
    if (ACTION_TYPES.indexOf(type) === -1) {
        throw new Error("Unknown MatrixAction type: " + type);
    }
    this.type = type;
    this.text = text;
    this.htmlText = htmlText;
    this.ts = timestamp || 0;
}
MatrixAction.fromEvent = function(client, event, mediaUrl) {
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
        if (["m.image", "m.file", "m.video"].indexOf(event.content.msgtype) !== -1) {
            var fileSize = "";
            if (event.content.info && event.content.info.size &&
                    typeof event.content.info.size === "number") {
                fileSize = " (" + Math.round(event.content.info.size / 1024) + "KB)";
            }

            // By default assume that the media server = client homeserver
            if (!mediaUrl) {
                mediaUrl = client.getHomeserverUrl();
            }

            const url = ContentRepo.getHttpUriForMxc(mediaUrl, event.content.url);
            text = `${event.content.body}${fileSize} <${url}>`;
        }
    }
    return new MatrixAction(type, text, htmlText, event.origin_server_ts);
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

module.exports = MatrixAction;
