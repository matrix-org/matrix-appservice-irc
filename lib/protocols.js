/*
 * Goto class for 'Mappers' which can convert between protocols.
 */
"use strict";

var PROTOCOLS = {
    IRC: "irc",
    MATRIX: "matrix"
};
module.exports.PROTOCOLS = PROTOCOLS;

var mappers = {
//  actions: {
//      srcProtocol: {
//          dstProtocol: Mapper
//      }
//  },
//  rooms: {
//      srcProtocol: {
//          dstProtocol: Mapper
//      }
//  },
//  users: {
//      srcProtocol: {
//          dstProtocol: Mapper
//      }
//  }
};

module.exports.setMapper = function(kind, srcProtocol, dstProtocol, mapper) {
    if (!mappers[kind]) {
        mappers[kind] = {};
    }
    if (!mappers[kind][srcProtocol]) {
        mappers[kind][srcProtocol] = {};
    }
    mappers[kind][srcProtocol][dstProtocol] = mapper;
};
module.exports.map = function(kind, srcProtocol, dstProtocol, obj) {
    if (!obj) {
        return;
    }
    if (mappers[kind] && mappers[kind][srcProtocol] && 
            mappers[kind][srcProtocol][dstProtocol]) {
        return mappers[kind][srcProtocol][dstProtocol](obj);
    }
};