"use strict";
let Queue = require("./Queue");

class QueuePool {

	// Construct a new Queue Pool.
	// This consists of multiple queues. Items will be round-robined into
	// each queue, unless an index is given when enqueuing.
	constructor(poolSize, fn) {
		if (poolSize < 1) {
			throw new Error("Pool size must be at least 1");
		}
		this.size = poolSize;
		this.fn = fn;
		this.queues = [];
		for (let i = 0; i < poolSize; i++) {
			this.queues.push(new Queue(fn));
		}
		this.roundRobinIndex = 0;
	}

	// Add an item to the queue. ID and item are passed directly to the Queue.
	// Index is optional and should be between 0 - poolSize. It determines
	// which queue to put the item into.
	enqueue(id, item, index) {
		if (index === undefined) {
			let promise = this.queues[this.roundRobinIndex].enqueue(id, item);
			this.roundRobinIndex++;
			if (this.roundRobinIndex >= this.size) {
				this.roundRobinIndex = 0;
			}
			return promise;
		}
		if (index >= this.size || index < 0) {
			throw new Error(`enqueue: index ${index} is out of bounds`);
		}
		return this.queues[index].enqueue(id, item);
	}

}

module.exports = QueuePool;
