"use strict";
var q = require("q");

// set up integration testing mocks
var proxyquire =  require('proxyquire');
var clientMock = require("../util/client-sdk-mock");
clientMock["@global"] = true; 
var ircMock = require("../util/irc-mock");
ircMock["@global"] = true;
var dbHelper = require("../util/db-helper");
var asapiMock = require("../util/asapi-controller-mock");

// set up test config
var appConfig = require("../util/config-mock");
var roomMapping = appConfig.roomMapping;

describe("Invite-only rooms", function() {
    var ircService = null;
    var mockAsapiController = null;

    var botUserId = "@"+appConfig.botLocalpart+":"+appConfig.homeServerDomain;
    var testUser = {
        id: "@flibble:wibble",
        nick: "flibble"
    };

    beforeEach(function(done) {
        console.log(" === Invite Rooms Test Start === ");
        ircMock._reset();
        clientMock._reset();
        ircService = proxyquire("../../lib/irc-appservice.js", {
            "matrix-js-sdk": clientMock,
            "irc": ircMock
        });
        mockAsapiController = asapiMock.create();

        // do the init
        dbHelper._reset(appConfig.databaseUri).then(function() {
            ircService.configure(appConfig.ircConfig);
            return ircService.register(mockAsapiController, appConfig.serviceConfig);
        }).done(function() {
            done();
        });
    });

    it("should not be joined by the bot if the AS does not know the room ID", 
    function(done) {
        mockAsapiController._trigger("type:m.room.member", {
            content: {
                membership: "invite",
            },
            state_key: botUserId,
            user_id: testUser.id,
            room_id: "!unknownroomid:here",
            type: "m.room.member"
        }).catch(function(e) {
            // XXX mingy check here, but better than nothing
            if (typeof e === "string" && e.indexOf("unknown room") !== -1) {
                done();
            }
        });
    });

    it("should be joined by the bot if the AS does know the room ID", 
    function(done) {
        var sdk = clientMock._client();
        var joinedRoom = false;
        sdk.joinRoom.andCallFake(function(roomId) {
            expect(roomId).toEqual(roomMapping.roomId);
            joinedRoom = true;
            return q({});
        });

        mockAsapiController._trigger("type:m.room.member", {
            content: {
                membership: "invite",
            },
            state_key: botUserId,
            user_id: testUser.id,
            room_id: roomMapping.roomId,
            type: "m.room.member"
        }).then(function() {
            if (joinedRoom) {
                done();
            }
        });
    });
});
