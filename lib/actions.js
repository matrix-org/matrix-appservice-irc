/*
 * An action is an event that can be bridged between protocols. A typical 
 * example would be a Message, but this could be a topic change, a nick change,
 * etc.
 *
 * The purpose of this file is to provide a standard representation for actions,
 * and provide conversion facilities between them (this is added as a protocol
 * mapper).
 */
"use strict";

var extend = require("extend");
var formatting = require("./irclib/formatting");
var log = require("./logging").get("actions");
var protocols = require("./protocols");
var PROTOCOLS = protocols.PROTOCOLS;
var ACTIONS = {
    MESSAGE: "message",
    EMOTE: "emote",
    TOPIC: "topic",
    NOTICE: "notice"
};

// Every action MUST have a protocol and action key. The remaining keys can
// vary depending on the protocol.
var createAction = function(protocol, action, opts) {
    return extend({
        action: action,
        protocol: protocol,
    }, opts);
}

var createIrcAction = function(action, opts) {
    return createAction(PROTOCOLS.IRC, action, opts);
};

var createMatrixAction = function(action, opts) {
    return createAction(PROTOCOLS.MATRIX, action, opts);
}

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
    createAction: function(event) {
        event.content = event.content || {};

        if (event.type === "m.room.message") {
            var fmtText = (event.content.format === "org.matrix.custom.html" ? 
                event.content.formatted_body : undefined);
            var msgTypeToAction = {
                "m.emote": ACTIONS.EMOTE,
                "m.notice": ACTIONS.NOTICE
            };
            var action = msgTypeToAction[event.content.msgtype] || ACTIONS.MESSAGE;
            return createMatrixAction(action, {
                body: event.content.body,
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
protocols.setMapperToMatrix("actions", function(action) {
    if (action.protocol !== PROTOCOLS.IRC) {
        log.error("Bad src protocol: %s", action.protocol);
        return;
    }
    var opts = {};
    switch(action.action) {
        case ACTIONS.MESSAGE:
        case ACTIONS.EMOTE:
        case ACTIONS.NOTICE:
            var fmtText = formatting.ircToHtml(action.text);
            opts = {
                body: action.text
            };
            if (fmtText !== action.text) {
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
            return;
    }

    return createMatrixAction(action.action, opts);
});

// Matrix -> IRC
protocols.setMapperToIrc("actions", function(action) {
    if (action.protocol !== PROTOCOLS.MATRIX) {
        log.error("Bad src protocol: %s", action.protocol);
        return;
    }
    var opts = {};
    switch(action.action) {
        case ACTIONS.MESSAGE:
        case ACTIONS.EMOTE:
        case ACTIONS.NOTICE:
            if (action.htmlBody) {
                // irc formatted text is the main text part
                opts.text = formatting.htmlToIrc(action.htmlBody);
            }
            else {
                opts.text = action.body;
            }
            break;
        case ACTIONS.TOPIC:
            opts = {
                topic: action.topic // straight 1:1 mapping here
            };
            break;
        default:
            log.error("MX->IRC: Unknown action: %s", action.action);
            return;
    }

    return createIrcAction(action.action, opts);
});