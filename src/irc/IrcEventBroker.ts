/*
Copyright 2019 The Matrix.org Foundation C.I.C.

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

    http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
*/

/*
 * This module contains all the logic to determine how incoming events from
 * IRC clients are mapped to events which are passed to the bridge.
 *
 * For example, every connected IRC client will get messages down their TCP
 * stream, but only 1 client should pass this through to the bridge to
 * avoid duplicates. This is typically handled by the MatrixBridge which is a
 * bot whose job it is to be the unique entity to have responsibility for passing
 * these events through to the bridge.
 *
 * However, we support disabling the bridge entirely which means one of the many
 * TCP streams needs to be responsible for passing the message to the bridge.
 * This is done using the following algorithm:
 *   - Create a hash "H" of (prefix, command, command-parameters) (aka the line)
 *   - Does H exist in the "processed" list?
 *      * YES: Was it you who processed H before?
 *          * YES: Process it again (someone sent the same message twice).
 *          *  NO: Ignore this message. (someone else has processed this)
 *      *  NO: Add H to the "processed" list with your client associated with it
 *             (this works without racing because javascript is single-threaded)
 *             and pass the message to the bridge for processing.
 * There are problems with this approach:
 *   - Unbounded memory consumption on the "processed" list.
 *   - Clients who previously "owned" messages disconnecting and not handling
 *     a duplicate messsage.
 * These are fixed by:
 *   - Periodically culling the "processed" list after a time T.
 *   - Checking if the client who claimed a message still has an active TCP
 *     connection to the server. If they do not have an active connection, the
 *     message hash can be "stolen" by another client.
 *
 * Rationale
 * ---------
 * In an ideal world, we'd have unique IDs on each message and it'd be first come,
 * first serve to claim an incoming message, but IRC doesn't "do" unique IDs.
 *
 * As a result, we need to handle the case where we get a message down that looks
 * exactly like one that was previously handled. Handling this across clients is
 * impossible (every message comes down like this, appearing as dupes). Handling
 * this *within* a client is possible; the *SAME* client which handled the prev
 * message knows that this isn't a dupe because dupes aren't sent down the same
 * TCP connection.
 *
 * Handling messages like this is risky though. We don't know for sure if the
 * client that handled the prev message will handle this new message. Therefore,
 * we check if the client who did the prev message is "dead" (inactive TCP conn),
 * and then "steal" ownership of that message if it is dead (again, this is
 * thread-safe provided the check and steal is done on a single turn of the event
 * loop). Even this isn't perfect though, as the connection may die without us
 * being aware of it (before TCP/app timeouts kick in), so we want to avoid having
 * to rely on stealing messages.
 *
 * We use a hashing algorithm mainly to reduce the key length per message
 * (which would otherwise be max 510 bytes). The strength of the hash (randomness)
 * determines the reliability of the bridge because it determines the rate of
 * "stealing" that is performed. At the moment, a max key size of 510 bytes is
 * acceptable with our expected rate of messages, so we're using the identity
 * function as our hash algorithm.
 *
 * Determining when to remove these keys from the processed dict is Hard. We can't
 * just mark it off when "all clients" get the message because all clients MAY NOT
 * always get the message e.g. due to a disconnect (leading to dead keys which
 * are never collected). Timeouts are reasonable but they need to be > TCP level
 * MSL (worse case) assuming the IRCd in question doesn't store-and-forward. The
 * MSL is typically 2 minutes, so a collection interval of 10 minutes is long
 * enough.
 */
import { IrcAction } from "../models/IrcAction";
import { IrcUser } from "../models/IrcUser";
import { BridgeRequest, BridgeRequestErr } from "../models/BridgeRequest";
import { ProcessedDict } from "../util/ProcessedDict";
import { getLogger } from "../logging";
import { Bridge } from "matrix-appservice-bridge";
import { ClientPool } from "./ClientPool";
import { BridgedClient, BridgedClientStatus } from "./BridgedClient";
import { IrcMessage, ConnectionInstance } from "./ConnectionInstance";
import { IrcHandler } from "../bridge/IrcHandler";
import { QuitDebouncer } from "../bridge/QuitDebouncer";
import { IrcServer } from "./IrcServer";

const log = getLogger("IrcEventBroker");

const BUFFER_TIMEOUT_MS = 5000;

function complete(req: BridgeRequest, promise: Promise<BridgeRequestErr|void>) {
    return promise.then(function(res) {
        req.resolve(res);
    }, function(err) {
        req.reject(err);
    });
}

export class IrcEventBroker {
    private processed: ProcessedDict;
    private channelReqBuffer: {[channel: string]: Promise<unknown>} = {};
    private quitDebouncer: QuitDebouncer;
    constructor(
        private readonly appServiceBridge: Bridge,
        private readonly pool: ClientPool,
        private readonly ircHandler: IrcHandler,
        servers: IrcServer[]) {
        this.processed = new ProcessedDict();
        this.processed.startCleaner(log);
        this.quitDebouncer = new QuitDebouncer(servers, this.handleDebouncedQuit.bind(this));
    }

    /*
    * Attempt to claim this message as this client
    * @return {boolean} True if you successfully claimed it.
    */
    private attemptClaim(client: BridgedClient, msg: IrcMessage) {
        const domain = client.server.domain;
        if (!msg.prefix || !msg.rawCommand || !msg.args) {
            log.warn("Unexpected msg format: %s", JSON.stringify(msg));
            return false; // drop them for now.
        }
        const hash = msg.prefix + msg.rawCommand + msg.args.join("");
        const handledByNick = this.processed.getClaimer(domain, hash);
        // we claim it if no one else has or if we previously did this hash.
        const shouldClaim = (
            handledByNick === null || handledByNick === client.nick
        );
        if (shouldClaim) {
            this.processed.claim(domain, hash, client.nick, msg.rawCommand);
            return true;
        }
        else if (handledByNick) {
            // someone else has allegedly claimed this; see if we can steal it.
            const owner = this.pool.getBridgedClientByNick(client.server, handledByNick);
            if (!owner) {
                // finders keepers
                log.debug(
                    "%s is stealing hash %s from %s because they are dead",
                    client.nick, hash, handledByNick
                );
                this.processed.claim(domain, hash, client.nick, msg.rawCommand);
                return true;
            }
        }
        return false;
    }

    private hookIfClaimed (client: BridgedClient, connInst: ConnectionInstance,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
                           eventName: string, fn: (...args: Array<any>) => void) {
        if (client.isBot && !client.server.isBotEnabled()) {
            return; // don't both attaching listeners we'll never invoke.
        }
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        connInst.addListener(eventName, (...args: Array<any>) => {
            if (client.server.isBotEnabled() && client.isBot) {
                // the bot handles all the things! Just proxy straight through.
                fn.apply(this, args);
            }
            else if (!client.server.isBotEnabled() && !client.isBot) {
                // this works because the last arg in all the callbacks are the
                // raw msg object (default to empty obj just in case)
                let msg = args[args.length - 1] || {};
                if (eventName === "names") {
                    /*
                     * NAMES is special and doesn't abide by this (multi lines per
                     * event), and we don't want to process all these names each time
                     * a client joins a channel(!) so we need to get a unique msg
                     * for the channel only (not users). This is why we skip the names
                     * object attached to the args in the msg.
                     *
                     * We also do not purge NAMES msgs from the processed hash list
                     * to avoid repeatedly joining IRC lists to Matrix. This isn't
                     * perfect: if every connected client died and the list changed,
                     * we wouldn't sync it - but this should be good enough.
                     */
                    const chan = args[0];
                    msg = {
                        prefix: "server_sent",
                        rawCommand: "names",
                        args: [chan]
                    };
                }

                if (this.attemptClaim(client, msg)) {
                    // We're responsible for passing this message to the bridge.
                    fn.apply(this, args);
                }
            }
        });
    }

    /**
     * This function is called when the quit debouncer has deemed it safe to start sending
     * quits from users who were debounced.
     * @param channel The channel to handle QUITs for.
     * @param server The channels server.
     * @param nicks The set of nicks for the channel.
     */
    private async handleDebouncedQuit(channel: string, server: IrcServer, nicks: string[]) {
        log.info(`Sending delayed QUITs for ${channel} (${nicks.length} nicks)`);
        if (nicks.length === 0) {
            return;
        }
        const createUser = (nick: string) => {
            return new IrcUser(
                server,
                nick,
                this.pool.nickIsVirtual(server, nick)
            );
        };

        const createRequest = () => {
            return new BridgeRequest(
                this.appServiceBridge.getRequestFactory().newRequest({
                    data: {
                        isFromIrc: true
                    }
                })
            );
        };
        for (const nick of nicks) {
            const req = createRequest();
            await complete(req, this.ircHandler.onPart(
                req,
                server,
                createUser(nick),
                channel,
                "quit"
            ));
        }
    }

    public sendMetadata(client: BridgedClient, msg: string, force = false, err?: IrcMessage) {
        if ((client.isBot || !client.server.shouldSendConnectionNotices()) && !force) {
            return;
        }
        const req = new BridgeRequest(
            this.appServiceBridge.getRequestFactory().newRequest({
                data: {
                    isFromIrc: true
                }
            })
        );
        complete(req, this.ircHandler.onMetadata(req, client, msg, force, err));
    }

    public addHooks(client: BridgedClient, connInst: ConnectionInstance) {
        const server = client.server;
        const ircHandler = this.ircHandler;

        const createUser = (nick: string) => {
            return new IrcUser(
                server, nick,
                this.pool.nickIsVirtual(server, nick)
            );
        };

        const createRequest = () => {
            return new BridgeRequest(
                this.appServiceBridge.getRequestFactory().newRequest({
                    data: {
                        isFromIrc: true
                    }
                })
            );
        };

        // === Attach client listeners ===
        // We want to listen for PMs for individual clients regardless of whether the
        // bot is enabled or disabled, as only they will receive the event. We handle
        // PMs to the bot now for provisioning.
        // listen for PMs for clients. If you listen for rooms, you'll get
        // duplicates since the bot will also invoke the callback fn!
        connInst.addListener("message", (from: string, to: string, text: string) => {
            if (to.startsWith("#")) { return; }
            const req = createRequest();
            // Check and drop here, because we want to avoid the performance impact.
            if (!IrcEventBroker.isValidNick(to)) {
                req.resolve(BridgeRequestErr.ERR_DROPPED);
                return;
            }
            complete(req, ircHandler.onPrivateMessage(
                req,
                server, createUser(from), createUser(to),
                new IrcAction("message", text)
            ));
        });
        connInst.addListener("notice", (from: string, to: string, text: string) => {
            if (!from || to.startsWith("#")) { return; }
            const req = createRequest();
            // Check and drop here, because we want to avoid the performance impact.
            if (!IrcEventBroker.isValidNick(to)) {
                req.resolve(BridgeRequestErr.ERR_DROPPED);
                return;
            }
            complete(req, ircHandler.onPrivateMessage(
                req,
                server, createUser(from), createUser(to),
                new IrcAction("notice", text)
            ));
        });
        connInst.addListener("ctcp-privmsg", (from: string, to: string, text: string) => {
            if (to.startsWith("#")) { return; }
            if (text.startsWith("ACTION ")) {
                const req = createRequest();
                // Check and drop here, because we want to avoid the performance impact.
                if (!IrcEventBroker.isValidNick(to)) {
                    req.resolve(BridgeRequestErr.ERR_DROPPED);
                    return;
                }
                complete(req, ircHandler.onPrivateMessage(
                    req,
                    server, createUser(from), createUser(to),
                    new IrcAction("emote", text.substring("ACTION ".length))
                ));
            }
        });
        connInst.addListener("invite", (channel: string, from: string) => {
            const req = createRequest();
            complete(req, ircHandler.onInvite(
                req, server, createUser(from), createUser(client.nick), channel
            ));
        });

        // Only a bot should issue a mode, so only the bot should listen for mode_is reply
        if (client.isBot) {
            connInst.addListener("mode_is", (channel: string, mode: string) => {
                const req = createRequest();
                complete(req, ircHandler.onModeIs(req, server, channel, mode));
            });
        }

        // When a names event is received, emit names event in the BridgedClient
        connInst.addListener("names", (chan: string, names: string) => {
            client.emit("irc-names", client, chan, names);
        });

        // Listen for other events

        this.hookIfClaimed(client, connInst, "part", (chan: string, nick: string, reason: string) => {
            const req = createRequest();
            complete(req, ircHandler.onPart(
                req, server, createUser(nick), chan, "part", reason
            ));
        });
        this.hookIfClaimed(client, connInst, "kick", (chan: string, nick: string, by: string, reason: string) => {
            const req = createRequest();
            complete(req, ircHandler.onKick(
                req, server, createUser(by), createUser(nick), chan, reason
            ));
        });
        this.hookIfClaimed(client, connInst, "quit", (nick: string, reason: string, chans: string[]) => {
            chans = chans || [];
            // True if a leave should be sent, otherwise false.
            if (this.quitDebouncer.debounceQuit(nick, server, chans)) {
                chans.forEach((chan) => {
                    const req = createRequest();
                    complete(req, ircHandler.onPart(
                        req, server, createUser(nick), chan, "quit", reason
                    ));
                });
            }
        });
        this.hookIfClaimed(client, connInst, "join", (chan: string, nick: string) => {
            const req = createRequest();
            // True if a join should be sent, otherwise false
            if (this.quitDebouncer.onJoin(nick, chan, server)) {
                complete(req, ircHandler.onJoin(
                    req, server, createUser(nick), chan, "join"
                ));
            }
        });
        this.hookIfClaimed(client, connInst, "nick", (oldNick: string, newNick: string, chans: string[]) => {
            chans = chans || [];
            chans.forEach((chan) => {
                const req = createRequest();
                complete(req, ircHandler.onPart(
                    req, server, createUser(oldNick), chan, "nick"
                ));
                complete(req, ircHandler.onJoin(
                    req, server, createUser(newNick), chan, "nick"
                ));
            });
        });
        // bucket names and drain them one at a time to avoid flooding
        // the matrix side with registrations / joins
        const namesBucket: {chan: string; nick: string; opLevel: string}[] = [
        //  { chan: <channel>, nick: <nick>, opLevel: <@+...> }
        ];
        let processingBucket = false;
        const popName = function() {
            const name = namesBucket.pop(); // LIFO but who cares
            if (!name) {
                processingBucket = false;
                return null;
            }
            const req = createRequest();
            const promise = complete(req, ircHandler.onJoin(
                req, server, createUser(name.nick), name.chan, "names"
            ));
            if (!name.opLevel) {
                return promise;
            }
            // chain off an onMode after the onJoin has been processed.
            return promise.then(() => {
                if (client.status !== BridgedClientStatus.CONNECTED) {
                    req.log.error("No client exists to set onMode for " + name.nick);
                    return null;
                }
                req.log.info(
                    "Calculating +mode for " + name.nick + " in " + name.chan +
                    " with opLevel=" + name.opLevel
                );
                // send onMode for the most powerful prefix only.
                let prefixLetter: null|string = null;
                for (let i = 0; i < name.opLevel.length; i++) {
                    const prefix = name.opLevel[i];
                    if (!prefixLetter) {
                        prefixLetter = prefix;
                        continue;
                    }
                    if (client.isUserPrefixMorePowerfulThan(prefixLetter, prefix)) {
                        prefixLetter = prefix;
                    }
                }
                if (!prefixLetter) {
                    return null;
                }
                const modeLetter = client.modeForPrefix(prefixLetter);
                if (!modeLetter) {
                    return null;
                }

                return complete(req, ircHandler.onMode(
                    req, server, name.chan, name.nick, modeLetter, true, name.nick
                ));
            });
        };
        const purgeNames = function() {
            const promise = popName();
            if (promise) {
                promise.finally(function() {
                    purgeNames();
                });
            }
        };

        this.hookIfClaimed(client, connInst, "names", function(chan: string, names) {
            if (names) {
                const userlist = Object.keys(names);
                userlist.forEach(function(nick) {
                    namesBucket.push({
                        chan: chan,
                        nick: nick,
                        opLevel: names[nick] || "",
                    });
                });
                client.log.info(
                    "NAMEs: Adding %s nicks from %s.", userlist.length, chan
                );
                client.log.debug("Names bucket has %s entries", namesBucket.length);
                if (!processingBucket) {
                    processingBucket = true;
                    purgeNames();
                }
            }
        });
        // listen for mode changes
        this.hookIfClaimed(client, connInst, "+mode", function(channel: string, by: string, mode: string, arg) {
            const req = createRequest();
            complete(req, ircHandler.onMode(
                req, server, channel, by, mode, true, arg
            ));
        });
        this.hookIfClaimed(client, connInst, "-mode", function(channel: string, by: string, mode: string, arg: string) {
            const req = createRequest();
            complete(req, ircHandler.onMode(
                req, server, channel, by, mode, false, arg
            ));
        });
        this.hookIfClaimed(client, connInst, "message", (from: string, to: string, text: string) => {
            if (!to.startsWith("#")) { return; }
            const req = createRequest();
            this.bufferRequestToChannel(to, () => {
                return complete(req, ircHandler.onMessage(
                    req, server, createUser(from), to,
                    new IrcAction("message", text)
                ));
            }, req);
        });
        this.hookIfClaimed(client, connInst, "ctcp-privmsg", function(from: string, to: string, text: string) {
            if (!to.startsWith("#")) { return; }
            if (text.startsWith("ACTION ")) {
                const req = createRequest();
                complete(req, ircHandler.onMessage(
                    req, server, createUser(from), to,
                    new IrcAction("emote", text.substring("ACTION ".length))
                ));
            }
        });
        this.hookIfClaimed(client, connInst, "notice", (from: string, to: string, text: string) => {
            if (!to.startsWith("#")) { return; }
            if (!from) { // ignore server notices
                return;
            }
            const req = createRequest();
            this.bufferRequestToChannel(to, () => {
                return complete(req, ircHandler.onMessage(
                    req, server, createUser(from), to, new IrcAction("notice", text)
                ));
            }, req);
        });
        this.hookIfClaimed(client, connInst, "topic", function(channel: string, topic: string, nick: string) {
            if (!channel.startsWith("#")) { return; }

            if (nick && nick.includes("@")) {
                const match = nick.match(
                    // https://github.com/martynsmith/node-irc/blob/master/lib/parse_message.js#L26
                    /^([_a-zA-Z0-9\[\]\\`^{}|-]*)(!([^@]+)@(.*))?$/
                );
                if (match) {
                    nick = match[1];
                }
            }
            const req = createRequest();
            complete(req, ircHandler.onTopic(
                req, server, createUser(nick), channel, new IrcAction("topic", topic)
            ));
        });
    }


    /**
     * This function "soft" queues functions acting on a single channel. This means
     * that messages will be processed in order, unless they take longer than `BUFFER_TIMEOUT_MS`
     * milliseconds, in which case they will "jump" the queue. This ensures that messages will be
     * hopefully ordered correctly, but will not arrive too late if the IRC bridge or the homeserver
     * is running slow.
     *
     * @param channel The channel to key the queue on.
     * @param req The request function
     * @param request The request object for logging to.
     */
    private async bufferRequestToChannel(channel: string, req: () => Promise<unknown>, request: BridgeRequest) {
        this.channelReqBuffer[channel] = (async () => {
            // Get the existing promise.
            const existing = this.channelReqBuffer[channel] || Promise.resolve();
            try {
                // Wait ROOM_BUFFER_TIMEOUT ms for the promise to complete.
                await new Promise((res, rej) => {
                    const t = setTimeout(() => {
                        rej(new Error("Timed out waiting"))
                    }, BUFFER_TIMEOUT_MS);
                    existing.then((data) => {
                        res(data);
                    }).catch((data) => {
                        rej(data);
                    }).finally(() => {
                        clearTimeout(t);
                    });
                });
                // If the promise didn't complete in time, continue with the next promise anyway.
            }
            catch (ex) {
                if (ex.message === "Timed out waiting") {
                    request.log.warn(`Request took >${BUFFER_TIMEOUT_MS} to complete.`);
                }
                else {
                    request.log.error(ex.message);
                }
                // Fall through.
            }
            await req();
        })();
    }

    static isValidNick(nick: string) {
        // The first character must be one of these.
        return /^[A-Za-z\[\]\\`_^\{\|\}]/.test(nick[0]);
    }
}
