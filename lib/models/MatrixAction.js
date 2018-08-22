"use strict";
const ircFormatting = require("../irc/formatting");
const log = require("../logging").get("MatrixAction");
const ContentRepo = require("matrix-appservice-bridge").ContentRepo;
const escapeStringRegexp = require('escape-string-regexp');

const ACTION_TYPES = ["message", "emote", "topic", "notice", "file", "image", "video", "audio"];
const EVENT_TO_TYPE = {
    "m.room.message": "message",
    "m.room.topic": "topic"
};
const MSGTYPE_TO_TYPE = {
    "m.emote": "emote",
    "m.notice": "notice",
    "m.image": "image",
    "m.video": "video",
    "m.audio": "audio",
    "m.file": "file"
};

const PILL_MIN_LENGTH_TO_MATCH = 4;
const MAX_MATCHES = 5;

function MatrixAction(type, text, htmlText, timestamp) {
    if (ACTION_TYPES.indexOf(type) === -1) {
        throw new Error("Unknown MatrixAction type: " + type);
    }
    this.type = type;
    this.text = text;
    this.htmlText = htmlText;
    this.ts = timestamp || 0;
}

MatrixAction.prototype.formatMentions = function(nickUserIdMap) {
    const regexString = "(" +
        Object.keys(nickUserIdMap).map((value) => escapeStringRegexp(value)).join("|")
        + ")";
    const usersRegex = MentionRegex(regexString);
    const matched = new Set(); // lowercased nicknames we have matched already.
    let match;
    for (let i = 0; i < MAX_MATCHES && (match = usersRegex.exec(this.text)) !== null; i++) {
        let matchName = match[2];
        // Deliberately have a minimum length to match on,
        // so we don't match smaller nicks accidentally.
        if (matchName.length < PILL_MIN_LENGTH_TO_MATCH || matched.has(matchName.toLowerCase())) {
            continue;
        }
        let userId = nickUserIdMap[matchName];
        if (userId === undefined) {
            // We might need to search case-insensitive.
            const nick = Object.keys(nickUserIdMap).find((n) =>
                n.toLowerCase() === matchName.toLowerCase()
            );
            if (nick === undefined) {
                continue;
            }
            userId = nickUserIdMap[nick];
            matchName = nick;
        }
        // If this message is not HTML, we should make it so.
        if (this.htmlText === undefined) {
            // This looks scary and unsafe, but further down we check
            // if `text` contains any HTML and escape + set `htmlText` appropriately.
            this.htmlText = this.text;
        }
        userId = ircFormatting.escapeHtmlChars(userId);
        /* Due to how Riot and friends do push notifications, we need the plain text to match something.
           Modern client's will pill-ify and will show a displayname, so we can use the localpart so it
           matches  and doesn't degrade too badly on limited clients.*/
        const localpart = userId.substr(1, userId.indexOf(":")-1);
        const regex = MentionRegex(escapeStringRegexp(matchName));
        this.htmlText = this.htmlText.replace(regex,
`$1<a href="https://matrix.to/#/${userId}">${ircFormatting.escapeHtmlChars(matchName)}</a>`
        );
        this.text = this.text.replace(regex, `$1${localpart}`);
        // Don't match this name twice, we've already replaced all entries.
        matched.add(matchName.toLowerCase());
    }
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
        if (["m.image", "m.file", "m.video", "m.audio"].indexOf(event.content.msgtype) !== -1) {
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
            text = `${event.content.body}${fileSize} < ${url} >`;
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

function MentionRegex(matcher) {
    const WORD_BOUNDARY = "^|\:|\#|```|\\s|$|,";
    return new RegExp(
        `(${WORD_BOUNDARY})(@?(${matcher}))(?=${WORD_BOUNDARY})`
    ,"igmu");
}

module.exports = MatrixAction;
