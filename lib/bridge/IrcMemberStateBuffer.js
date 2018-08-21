const Promise = require("bluebird");

/*
   This class handles cases where we want to modify a virtual users memberstate,
   but we aren't sure if they have finished sending messages. This will make a rough
   attempt to stop joins resulting from messages not arriving before a leave.
*/

const DEFAULT_WAIT_TIME_MS = 15 * 1000;
const HIGH_WATER_MARK = 2048;

class IrcMemberStateBuffer {
    constructor(ircBridge, opts={}) {
        this.membershipWaiting = new Map(); //roomId:userId => {
            //    operation = intent function to call
            //    reason = reason code if kicking
            //    intent = intent that is doing the action }
        
            // Used to determine how long ago someone spoke in a room.
        this.lastMessageTime = new Map(); //roomId:userId => ts
        this.activeDuration = opts.activeDuration === undefined ? DEFAULT_WAIT_TIME_MS : opts.activeDuration;
        this.ircBridge = ircBridge;
        this.delayedDueToActivityCount = 0;
    }

    bumpMessageTime(room, matrixUser) {
        const key = `${room.getId()}:${matrixUser.getId()}`;
        this.lastMessageTime.set(key, Date.now());
    }

    delayMembership(room, matrixUser, operation, intent, reason=null) {
        const userIsActive = this._userRecentlySentMessage(room, matrixUser);
        const messagesInFlight = this.ircBridge.userHasMessagesInFlight(room, matrixUser);

        /* This either sets or overwrites membership on purpose so we don't
        have conflicting, and possibly racy operations for a user.

        This comes at the cost of not fully replicating a leave and join on the
        matrix side, but just the membership delta. A leave,join,leave will
        be sent as a single leave if lots of messages are in flight. */
        if (messagesInFlight) {
            const key = `${room.getId()}:${matrixUser.getId()}`;
            this.membershipWaiting.set(
                key,
                { operation, reason, intent }
            );
            return Promise.resolve(true);
        }

        /* IRC has a tendency to push events out of order, it is *very good*
           at sending parts before finishing sending messages.
           The best solution here is to delay membership for a period
           of time until we fairly certain they have stopped talking. */
        if (userIsActive) {
            // Call this some time in the future.
            const timeDelta = this.activeDuration - this._durationSinceLastMessage(room, matrixUser);
            this.delayedDueToActivityCount++;
            Promise.delay(timeDelta).then(() => {
                this.delayedDueToActivityCount--;
                return this.delayMembership(room, matrixUser, operation, intent, reason);
            });

            // Do a bit of cleanup.
            this._cleanUpLastMessageTimes();

            // Still return true immediately to let the caller know we delayed.
            return Promise.resolve(true);
        }

        // We don't need to wait, just dooo it.
        return intent[operation](room.getId(), matrixUser.getId(), reason);
    }

    /* eslint-disable */
    processMembership(room, matrixUser, req) {
        const key = `${room.getId()}:${matrixUser.getId()}`;
        // Don't do anything if requests are still in flight,
        // or we don't have any membership to process.
        if (this.ircBridge.userHasMessagesInFlight(room, matrixUser)) {
            req.log.debug("Didn't process membership because requests are still waiting.");
            return;
        }

        if (!this.membershipWaiting.has(key)) {
            req.log.debug("Didn't process membership since none is waiting.");
            return;
        }
            
        const membership = this.membershipWaiting.get(key);

        // Drop since we are now processing it.
        this.membershipWaiting.delete(key);
        req.log.info(`Sending delayed membership ${membership.operation} ` +
                     `for ${matrixUser.getId()} in ${room.getId()}`);
        const intent = membership.intent;
        return intent[membership.operation](room.getId(), matrixUser.getId(), membership.reason);
    }

    _durationSinceLastMessage(room, matrixUser) {
        const key = `${room.getId()}:${matrixUser.getId()}`;
        return Date.now() - this.lastMessageTime.get(key);
    }

    _userRecentlySentMessage(room, matrixUser) {
        return this._durationSinceLastMessage(room, matrixUser) < this.activeDuration;
    }

    _cleanUpLastMessageTimes() {
        if (this.lastMessageTime.size < HIGH_WATER_MARK) {
            return;
        }
        this.lastMessageTime.forEach((value, key) => {
            if (value > this.activeDuration) {
                this.lastMessageTime.delete(key);
            }
        });
    }

    get waitingMemberships() {
        return this.membershipWaiting.size + this.delayedDueToActivityCount;
    }
}

module.exports = IrcMemberStateBuffer;