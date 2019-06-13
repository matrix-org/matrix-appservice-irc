class MessageSendQueue {
    constructor(messageQueueConfig, bridge) {
        this.config = messageQueueConfig;
        this.bridge = bridge;
    }

    async onIrcPM () {
        // TODO: D
    }

    async onIrcMsg() {
        
    }
}

module.exports = MessageSendQueue;