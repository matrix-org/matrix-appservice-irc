"use strict";
const { MatrixAction } = require("../../lib/models/MatrixAction");

const FakeIntent = {
    getProfileInfo: (userId) => {
        return new Promise((resolve, reject) => {
            if (userId === "@jc.denton:unatco.gov") {
                resolve({displayname: "TheJCDenton"});
            }
            else if (userId === "@paul.denton:unatco.gov") {
                resolve({displayname: "ThePaulDenton"});
            }
            else {
                reject("This user was not found");
            }
        });
    }
}

describe("MatrixAction", function() {

    it("should not highlight mentions to text without mentions", () => {
        const action = new MatrixAction("message", "Some text");
        return action.formatMentions(new Map(Object.entries({
            "Some Person": "@foobar:localhost"
        })), FakeIntent).then(() => {
            expect(action.text).toEqual("Some text");
            expect(action.htmlText).toBeNull();
        });
    });

    it("should highlight a user", () => {
        const action = new MatrixAction(
            "message",
            "JCDenton, it's a bomb!",
            "JCDenton, it's a bomb!",
            null
        );
        return action.formatMentions(new Map(Object.entries({
            "JCDenton": "@jc.denton:unatco.gov"
        })), FakeIntent).then(() => {
            expect(action.text).toEqual("TheJCDenton, it's a bomb!");
            expect(action.htmlText).toEqual(
                "<a href=\"https://matrix.to/#/@jc.denton:unatco.gov\">"+
                "TheJCDenton</a>, it's a bomb!"
            );
        });
    });
    it("should highlight a possessive mention", () => {
        const action = new MatrixAction(
            "message",
            "Did you get JCDenton's report?",
            "Did you get JCDenton's report?",
            null
        );
        return action.formatMentions(new Map(Object.entries({
            "JCDenton": "@jc.denton:unatco.gov"
        })), FakeIntent).then(() => {
            expect(action.text).toEqual("Did you get TheJCDenton's report?");
            expect(action.htmlText).toEqual(
                "Did you get <a href=\"https://matrix.to/#/@jc.denton:unatco.gov\">"+
                "TheJCDenton</a>'s report?"
            );
        });
    });
    it("should highlight a quote", () => {
        const action = new MatrixAction(
            "message",
            "Hey, you missed: <JCDenton> it's a bomb!",
            "Hey, you missed: &lt;JCDenton&gt; it's a bomb!",
            null
        );
        return action.formatMentions(new Map(Object.entries({
            "JCDenton": "@jc.denton:unatco.gov"
        })), FakeIntent).then(() => {
            expect(action.text).toEqual("Hey, you missed: <TheJCDenton> it's a bomb!");
            expect(action.htmlText).toEqual(
                "Hey, you missed: &lt;<a href=\"https://matrix.to/#/@jc.denton:unatco.gov\">"+
                "TheJCDenton</a>&gt; it's a bomb!"
            );
        });
    });
    it("should highlight a user, regardless of case", () => {
        const action = new MatrixAction(
            "message",
            "JCDenton, it's a bomb!",
            "JCDenton, it's a bomb!",
            null
        );
        return action.formatMentions(new Map(Object.entries({
            "jcdenton": "@jc.denton:unatco.gov"
        })), FakeIntent).then(() => {
            expect(action.text).toEqual("TheJCDenton, it's a bomb!");
            expect(action.htmlText).toEqual(
                "<a href=\"https://matrix.to/#/@jc.denton:unatco.gov\">"+
                "TheJCDenton</a>, it's a bomb!"
            );
        });

    });
    it("should highlight a user, with plain text", () => {
        const action = new MatrixAction("message", "JCDenton, it's a bomb!");
        return action.formatMentions(new Map(Object.entries({
            "JCDenton": "@jc.denton:unatco.gov"
        })), FakeIntent).then(() => {
            expect(action.text).toEqual("TheJCDenton, it's a bomb!");
            expect(action.htmlText).toEqual(
                "<a href=\"https://matrix.to/#/@jc.denton:unatco.gov\">"+
                "TheJCDenton</a>, it's a bomb!"
            );
        });
    });
    it("should highlight a user, with weird characters", () => {
        const action = new MatrixAction("message", "`||JCDenton[m], it's a bomb!");
        return action.formatMentions(new Map(Object.entries({
            "`||JCDenton[m]": "@jc.denton:unatco.gov"
        })), FakeIntent).then(() => {
            expect(action.text).toEqual("TheJCDenton, it's a bomb!");
            expect(action.htmlText).toEqual(
                "<a href=\"https://matrix.to/#/@jc.denton:unatco.gov\">"+
                "TheJCDenton</a>, it's a bomb!"
            );
        });
    });
    it("should highlight multiple users", () => {
        const action = new MatrixAction(
            "message",
            "JCDenton is sent to assassinate PaulDenton",
            "JCDenton is sent to assassinate PaulDenton",
            null
        );
        return action.formatMentions(new Map(Object.entries({
            "JCDenton": "@jc.denton:unatco.gov",
            "PaulDenton": "@paul.denton:unatco.gov"
        })), FakeIntent).then(() => {
            expect(action.text).toEqual("TheJCDenton is sent to assassinate ThePaulDenton");
            expect(action.htmlText).toEqual(
                "<a href=\"https://matrix.to/#/@jc.denton:unatco.gov\">TheJCDenton</a> is sent" +
                " to assassinate <a href=\"https://matrix.to/#/@paul.denton:unatco.gov\">" +
                "ThePaulDenton</a>"
            );
        });
    });
    it("should highlight multiple mentions of the same user", () => {
        const action = new MatrixAction(
            "message",
            "JCDenton, meet JCDenton",
            "JCDenton, meet JCDenton",
            null
        );
        return action.formatMentions(new Map(Object.entries({
            "JCDenton": "@jc.denton:unatco.gov"
        })), FakeIntent).then(() => {
            expect(action.text).toEqual("TheJCDenton, meet TheJCDenton");
            expect(action.htmlText).toEqual(
                "<a href=\"https://matrix.to/#/@jc.denton:unatco.gov\">TheJCDenton</a>," +
                " meet <a href=\"https://matrix.to/#/@jc.denton:unatco.gov\">TheJCDenton</a>"
            );
        });
    });
    it("should not highlight mentions in a URL with www.", () => {
        const action = new MatrixAction(
            "message",
            "Go to http://www.JCDenton.com",
            "Go to <a href='http://www.JCDenton.com'>my website</a>",
            null
        );
        return action.formatMentions(new Map(Object.entries({
            "JCDenton": "@jc.denton:unatco.gov"
        })), FakeIntent).then(() => {
            expect(action.text).toEqual("Go to http://www.JCDenton.com");
            expect(action.htmlText).toEqual(
                "Go to <a href='http://www.JCDenton.com'>my website</a>"
            );
        });
    });
    it("should not highlight mentions in a URL with http://", () => {
        const action = new MatrixAction(
            "message",
            "Go to http://JCDenton.com",
            "Go to <a href='http://JCDenton.com'>my website</a>",
            null
        );
        return action.formatMentions(new Map(Object.entries({
            "JCDenton": "@jc.denton:unatco.gov"
        })), FakeIntent).then(() => {
            expect(action.text).toEqual("Go to http://JCDenton.com");
            expect(action.htmlText).toEqual(
                "Go to <a href='http://JCDenton.com'>my website</a>"
            );
        });
    });
    it("should fallback to userIds", () => {
        const action = new MatrixAction(
            "message",
            "AnnaNavarre: The machine would not make a mistake!",
            "AnnaNavarre: The machine would not make a mistake!",
            null
        );
        return action.formatMentions(new Map(Object.entries({
            "AnnaNavarre": "@anna.navarre:unatco.gov"
        })), FakeIntent).then(() => {
            expect(action.text).toEqual("anna.navarre: The machine would not make a mistake!");
            expect(action.htmlText).toEqual(
                "<a href=\"https://matrix.to/#/@anna.navarre:unatco.gov\">"+
                "anna.navarre</a>: The machine would not make a mistake!"
            );
        });
    });
});
