import { MSC3968Content } from "matrix-appservice-bridge";

export const defaultEventFeatures: MSC3968Content = {
    keys: {
        "m.in_reply_to": -50, // replies
        "m.new_content": -100, // edits
        "m.relates_to": -1, // Other relations are unlikely to be bridged gracefully
        // encrypted files:
        "file": -100,
        "thumbnail_file": -100
    },
    // discourage HTML elements with no counterpart on IRC:
    html_elements_default: -1,
    html_elements: {
        "a": 0,
        "b": 0,
        "code": 0,
        "div": 0,
        "font": 0,
        "p": 0,
        "pre": 0,
        "i": 0,
        "u": 0,
        "span": 0,
        "strong": 0,
        "em": 0,
        "strike": 0
    },
    // forbid text messages which are neither text nor HTML (eg. `m.location`),
    // and encourage text messages over media (which IRC users may prefer not to display inline):
    mimetypes_default: -100,
    mimetypes: {
        "text/plain": 0,
        "text/html": 0
    },
    msgtypes_default: -100,
    msgtypes: {
        "m.audio": 0,
        "m.emote": 100,
        "m.file": 0,
        "m.image": 0,
        "m.notice": 100,
        "m.text": 100,
        "m.video": 0,
        "m.server_notice": 0
    },
}

