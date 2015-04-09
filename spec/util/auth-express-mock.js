// Mocks the specific use case for express for auth/server.js
"use strict";
var reqHandler = null;

module.exports = function(getTestMethods) {
    if (getTestMethods) {
        return {
            _reset: function() {
                reqHandler = null;
            },
            _triggerRedirectUrl: function(sessionToken, queryParams) {
                d = q.defer();

                var res = {
                    send: function(stuff) {
                        d.resolve(stuff);
                    }
                };

                var req = {
                    params: {
                        token: sessionToken // XXX brittle; assumes ":token" on express regex
                    },
                    query: queryParams
                };

                reqHandler(req, res);
                return d.promise;
            }
        };
    }

    return {
        use: function(){},
        listen: jasmine.createSpy("express.listen(port,fn)"),
        get: function(pathRegex, requestHandler) {
            if (reqHandler != null) {
                console.log("===========================================");
                console.error("Express Auth Mock may be broken! Multiple calls"+
                    " to app.get but the mock only handles a single handler!");
                console.log("===========================================");
            }
            reqHandler = requestHandler;
        }
    };
};