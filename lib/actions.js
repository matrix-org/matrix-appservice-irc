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

var createAction = function(protocol, action, opts) {
    return extend({
        action: action,
        protocol: protocol,
    }, opts);
}

var createMessage = function(protocol, text, formattedText) {
    return createAction(protocol, ACTIONS.MESSAGE, {
        text: text,
        formattedText: formattedText
    });
};

var createEmote = function(protocol, text, formattedText) {
    return createAction(protocol, ACTIONS.EMOTE, {
        text: text,
        formattedText: formattedText
    });
};

var createTopic = function(protocol, topic) {
    return createAction(protocol, ACTIONS.TOPIC, {
        topic: topic
    });
};

var createNotice = function(protocol, notice) {
    return createAction(protocol, ACTIONS.NOTICE, {
        text: notice
    });
};

module.exports.irc = {
    createMessage: function(text) {
        return createMessage(PROTOCOLS.IRC, text);
    },
    createEmote: function(text) {
        return createEmote(PROTOCOLS.IRC, text);
    },
    createTopic: function(topic) {
        return createTopic(PROTOCOLS.IRC, topic);
    },
    createNotice: function(notice) {
        return createNotice(PROTOCOLS.IRC, notice);
    }
};

module.exports.matrix = {
    createAction: function(event) {
        event.content = event.content || {};

        if (event.type === "m.room.message") {
            var fmtText = (event.content.format === "org.matrix.custom.html" ? 
                event.content.formatted_body : undefined);
            if (event.content.msgtype === "m.emote") {
                return createEmote(PROTOCOLS.MATRIX, event.content.body);
            }
            else if(event.content.msgtype === "m.notice") {
                return createNotice(PROTOCOLS.MATRIX, event.content.body);
            }
            else {
                return createMessage(
                    PROTOCOLS.MATRIX, event.content.body, fmtText
                );
            }
        }
        else if (event.type === "m.room.topic") {
            return createTopic(PROTOCOLS.MATRIX, event.content.topic);
        }
    }
};

// IRC -> Matrix
protocols.setMapper("actions", PROTOCOLS.IRC, PROTOCOLS.MATRIX, function(action) {
    if (action.protocol === PROTOCOLS.MATRIX) {
        return action;
    }
    var opts = {};
    switch(action.action) {
        case ACTIONS.MESSAGE:
        case ACTIONS.EMOTE:
        case ACTIONS.NOTICE:
            var fmtText = formatting.ircToHtml(action.text);
            opts = {
                text: action.text
            };
            if (fmtText !== action.text) {
                opts.formattedText = fmtText;
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

    return createAction(PROTOCOLS.MATRIX, action.action, opts);
});

// Matrix -> IRC
protocols.setMapper("actions", PROTOCOLS.MATRIX, PROTOCOLS.IRC, function(action) {
    if (action.protocol === PROTOCOLS.IRC) {
        return action;
    }
    var opts = {};
    switch(action.action) {
        case ACTIONS.MESSAGE:
        case ACTIONS.EMOTE:
        case ACTIONS.NOTICE:
            if (action.formattedText) {
                // irc formatted text is the main text part
                opts.text = formatting.htmlToIrc(action.formattedText);
            }
            else {
                opts.text = action.text;
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

    return createAction(PROTOCOLS.IRC, action.action, opts);
});