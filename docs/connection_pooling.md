Connection Pooling
==================

<section class="warning">
Connection pooling is a new feature and may not be 100% stable. While extensive testing efforts have been made, it may still format your cat.
</section>

The IRC bridge can be configured to run it's IRC connections through a seperate process from the main bridge,
allowing you to restart and update (in most cases) the main process while keeping connections alive. This in 
effect allows you to have a bridge that *appears* to not restart (sometimes nicknamed eternal bridges).

To configure the bridge in this mode you will need to setup a [Redis](https://redis.io/) instance. Ideally, you
**should** run the bridge with Redis `6.2.0` or greater as it is more efficent when used with streams. The bridge
requires Redis `5.0.0` or greater to run.

In your bridge, configure the following:

```yaml
connectionPool:
  # The Redis URI to connect to 
  redisUrl: redis://user:password@host:port/dbnum
  # Should the connections persist after the bridge successfully shuts down?
  persistConnectionsOnShutdown: true
```

And then you need to run the pool using:

```sh
export REDIS_URL=redis://localhost:6379
export METRICS_HOST=localhost
export METRICS_PORT=7002
export LOGGING_LEVEL=info

yarn start:pool
```

### Upgrading the bridge

The bridge supports being upgraded while the connection pool service is running, and can just be updated as normal.
There are exceptions to this rule when the protocol of the connection pool changes per release. While we endeavour
to point this out in the documentation, the bridge will also fail to start if it detects a protocol change.

### Persisting connections

Connections are persisted between restarts of the main bridge process **if** `persistConnectionsOnShutdown` is 
set to `true`. The default is to keep the existing single-process behaviour of closing connections on shutdown, however.

If the bridge is interrupted (e.g. the process is killed by the operating system before it can complete the shutdown routine)
then the connections WILL persist between restarts.

Closing the connection pool process will immedtiately terminate any connection processes. The bridge will NOT attempt
to reconnect users if the pool process dies, and instead will eventually timeout and restart after a period.