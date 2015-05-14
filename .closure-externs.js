/* Node.js Externs */
// ==========================================================================

function require(path){}
var module = {
  exports: {}
};

/** @constructor */function Buffer(something){}
var process = {};
var __dirname = "";


/* Q Externs */
// ==========================================================================

/**
 * @typedef {{
 *   resolve: function(*=),
 *   reject: function(*=),
 *   notify: function(*=),
 *   promise: !Object
 *   }}
 */
var Deferred;

/** @param {*=} opt_value */
Deferred.resolve = function(opt_value) {};

/** @param {*=} opt_reason */
Deferred.reject = function(opt_reason) {};

/** @param {*=} opt_value */
Deferred.notify = function(opt_value) {};

/** @type {!Promise} */  // ES6 defined promise interface
Deferred.promise;

