/*
 * Contains integration tests for all IRC-initiated events.
 */
"use strict";

describe("IRC-to-Matrix", function() {

    beforeEach(function(done) {
        console.log(" === IRC-to-Matrix Test Start === ");
        done();
    });

    it("should bridge IRC text as Matrix message's m.text", 
    function(done) {
        done();
    });

    it("should bridge IRC actions as Matrix message's m.emote", 
    function(done) {
        done();
    });

    it("should bridge IRC notices as Matrix message's m.notice", 
    function(done) {
        done();
    });

    it("should create a 1:1 matrix room when it receives a PM from a real IRC user", 
    function(done) {
        done();
    });
});