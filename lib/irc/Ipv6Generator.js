/*eslint no-invalid-this: 0 */
"use strict";
var Promise = require("bluebird");
var Queue = require("../util/Queue");
var log = require("../logging").get("Ipv6Generator");

function Ipv6Generator(store) {
    // Queue of ipv6 generation requests.
    // We need to queue them because otherwise 2 clashing user_ids could be assigned
    // the same ipv6 value (won't be in the database yet)
    this._queue = new Queue(this._process.bind(this));
    this._dataStore = store;
    this._counter = -1;
}

/**
 * Generate a new IPv6 address for the given IRC client config.
 * @param {string} prefix The IPv6 prefix to use.
 * @param {IrcClientConfig} ircClientConfig The config to set the address on.
 * @return {Promise} Resolves to the IPv6 address generated; the IPv6 address will
 * already be set on the given config.
 */
Ipv6Generator.prototype.generate = Promise.coroutine(function*(prefix, ircClientConfig) {
    if (ircClientConfig.getIpv6Address()) {
        log.info(
            "Using existing IPv6 address %s for %s",
            ircClientConfig.getIpv6Address(),
            ircClientConfig.getUserId()
        );
        return ircClientConfig.getIpv6Address();
    }
    if (this._counter === -1) {
        log.info("Retrieving counter...");
        this._counter = yield this._dataStore.getIpv6Counter();
    }

    // the bot user will not have a user ID
    let id = ircClientConfig.getUserId() || ircClientConfig.getUsername();
    log.info("Enqueueing IPv6 generation request for %s", id);
    yield this._queue.enqueue(id, {
        prefix: prefix,
        ircClientConfig: ircClientConfig
    });
});

Ipv6Generator.prototype._process = Promise.coroutine(function*(item) {
    this._counter += 1;

    // insert : every 4 characters from the end of the string going to the start
    // e.g. 1a2b3c4d5e6 => 1a2:b3c4:d5e6
    let suffix = this._counter.toString(16);
    suffix = suffix.replace(/\B(?=(.{4})+(?!.))/g, ':');
    let address = item.prefix + suffix;

    let config = item.ircClientConfig;
    config.setIpv6Address(address);

    // we only want to persist the IPv6 address for real matrix users
    if (item.ircClientConfig.getUserId()) {
        let existingConfig = yield this._dataStore.getIrcClientConfig(
            item.ircClientConfig.getUserId(), item.ircClientConfig.getDomain()
        );
        if (existingConfig) {
            config = existingConfig;
            config.setIpv6Address(address);
        }
        log.info("Generated new IPv6 address %s for %s", address, config.getUserId());
        // persist to db here before releasing the lock on this request.
        yield this._dataStore.storeIrcClientConfig(config);
    }

    yield this._dataStore.setIpv6Counter(this._counter);

    return config.getIpv6Address();
});

module.exports = Ipv6Generator;
