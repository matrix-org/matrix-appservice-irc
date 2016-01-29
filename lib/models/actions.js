/*
 * An action is an event that can be bridged between protocols. A typical
 * example would be a Message, but this could be a topic change, a nick change,
 * etc.
 *
 * The purpose of this file is to provide a standard representation for actions,
 * and provide conversion facilities between them.
 */
"use strict";

var extend = require("extend");
var ircFormatting = require("../irclib/formatting");
var matrixLib = require("../mxlib/matrix");
var log = require("../logging").get("actions");
var ACTIONS = {
    MESSAGE: "message",
    EMOTE: "emote",
    TOPIC: "topic",
    NOTICE: "notice",
    IMAGE: "image",
    FILE: "file"
};

// Every action MUST have a protocol and action key. The remaining keys can
// vary depending on the protocol.
var createAction = function(protocol, action, opts) {
    return extend({
        action: action,
        protocol: protocol,
    }, opts);
};

var createIrcAction = function(action, opts) {
    return createAction("irc", action, opts);
};

var createMatrixAction = function(action, opts) {
    return createAction("matrix", action, opts);
};

module.exports.irc = {
    createMessage: function(text) {
        return createIrcAction(ACTIONS.MESSAGE, {
            text: text
        });
    },
    createEmote: function(text) {
        return createIrcAction(ACTIONS.EMOTE, {
            text: text
        });
    },
    createNotice: function(notice) {
        return createIrcAction(ACTIONS.NOTICE, {
            text: notice
        });
    },
    createTopic: function(topic) {
        return createIrcAction(ACTIONS.TOPIC, {
            topic: topic
        });
    }
};

module.exports.matrix = {
    createNotice: function(text) {
        return createMatrixAction(ACTIONS.NOTICE, {
            body: text
        });
    },
    createAction: function(event) {
        event.content = event.content || {};

        if (event.type === "m.room.message") {
            var fmtText = (event.content.format === "org.matrix.custom.html" ?
                event.content.formatted_body : undefined);
            var body = event.content.body;

            var msgTypeToAction = {
                "m.emote": ACTIONS.EMOTE,
                "m.notice": ACTIONS.NOTICE,
                "m.image": ACTIONS.IMAGE,
                "m.file": ACTIONS.FILE
            };
            var action = msgTypeToAction[event.content.msgtype] || ACTIONS.MESSAGE;
            if (event.content.msgtype === "m.image" ||
                    event.content.msgtype === "m.file") {
                var fileSize = "";
                if (event.content.info && event.content.info.size &&
                        typeof event.content.info.size === "number") {
                    fileSize = " (" + Math.round(event.content.info.size / 1024) +
                        "KB)";
                }
                body = matrixLib.decodeMxc(event.content.url) +
                        " - " + event.content.body + fileSize;
            }

            return createMatrixAction(action, {
                body: body,
                htmlBody: fmtText
            });
        }
        else if (event.type === "m.room.topic") {
            return createMatrixAction(ACTIONS.TOPIC, {
                topic: event.content.topic
            });
        }
    }
};

// IRC -> Matrix
module.exports.toMatrix = function(action) {
    if (action.protocol !== "irc") {
        log.error("Bad src protocol: %s", action.protocol);
        return null;
    }
    var opts = {};
    switch (action.action) {
        case ACTIONS.MESSAGE:
        case ACTIONS.EMOTE:
        case ACTIONS.NOTICE:
            var fmtText = ircFormatting.ircToHtml(action.text);
            opts = {
                body: action.text
            };
            // TODO: This does mean anything with < > ' " will be sent as HTML
            // which isn't ideal.
            if (fmtText !== action.text) {
                opts.body = ircFormatting.stripIrcFormatting(action.text);
                opts.htmlBody = fmtText;
            }
            break;
        case ACTIONS.TOPIC:
            opts = {
                topic: action.topic // straight 1:1 mapping here
            };
            break;
        default:
            log.error("IRC->MX: Unknown action: %s", action.action);
            return null;
    }

    return createMatrixAction(action.action, opts);
};

// Matrix -> IRC
module.exports.toIrc = function(action) {
    if (action.protocol !== "matrix") {
        log.error("Bad src protocol: %s", action.protocol);
        return null;
    }
    var opts = {};
    switch (action.action) {
        case ACTIONS.MESSAGE:
        case ACTIONS.EMOTE:
        case ACTIONS.NOTICE:
            if (action.htmlBody) {
                // irc formatted text is the main text part
                opts.text = ircFormatting.htmlToIrc(action.htmlBody);
            }
            else {
                opts.text = action.body;
            }
            break;
        case ACTIONS.IMAGE:
            action.action = ACTIONS.MESSAGE;
            opts.text = "Posted an Image: " + action.body;
            break;
        case ACTIONS.FILE:
            action.action = ACTIONS.MESSAGE;
            opts.text = "Posted a File: " + action.body;
            break;
        case ACTIONS.TOPIC:
            opts = {
                topic: action.topic // straight 1:1 mapping here
            };
            break;
        default:
            log.error("MX->IRC: Unknown action: %s", action.action);
            return null;
    }

    return createIrcAction(action.action, opts);
};
