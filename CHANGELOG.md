Changes in 0.8.0 (2017-07-26)
=============================

**BREAKING CHANGES:**
 - Logs are now rotated based on time rather than size. `maxFileSizeBytes` has been removed from the configuration file.

New features:
 - The bridge will now mirror IRC chanops to Matrix, so Matrix users can see who is a chanop.
 - The bridge will now handle `+m` (moderated) channels by setting the `events_default` value to `1` when `+m` is set.
   Only Matrix users with a power level >0 can send events in this room whilst this is set.
 - The debug API has been expanded to include `/killUser` which accepts a JSON object like:
   ```json
   {
     "user_id": "@usertoremove:localhost",
     "reason": "reason in quit message and kick message"
   }
   ```

Improvements:
 - Reduced CPU and memory usage during normal operation. The bridge will now share internal data structures for representing Matrix rooms. Previously, each user in a room would have its own copy of the Matrix room which would need to be updated for power levels / membership changes N times (where N is the number of bridged users in the room). This now only needs to be updated once.
 - The format for uploaded content has changed to: (thanks @t3chguy!)
   ```
   Person has uploaded an image: filename.gif (55KB) <https://homeserver/_matrix/media/v1/download/foo/bar>
   ```

 - The bridge will now respond to CTCP VERSION with: (thanks @t3chguy!)
   ```
   matrix-appservice-irc, part of the Matrix.org Network
   ```

 - The ident server can now bind to any address via the config option `ident.address`. Thanks @silkeh!
 - The ident server will now respond with the formal syntax in RFC1413. Thanks @silkeh!
 - The bridge will now set `protocols: ["irc"]` in the generated registration file. Thanks @ansiwen!

Bug fixes:
 - `dropMatrixMessagesAfterSecs` now re-checks the time just prior to sending to IRC. Previously, it was possible for events to arrive a few seconds before the cut-off period and then take minutes to be processed in the bridge, resulting in the message being sent *after* the cut-off period.
 - The `unbridge.js` script has been fixed when not sending a message. Thanks @aperezdc!
 - Pastebinned long messages are now uploaded with UTF8 encoding.
 - The bridge will now wait between reconnection attempts for a given client. Previously, a bug would cause it to tight-loop trying to reconnect.
 - Fixed an issue which could cause an IRC message to make the bridge tight-loop.
 - Capped the `depth` value when introspecting clients in the debug API. Long-running bridges could cause this to error out as idle timers exceeded the stack depth.

Changes in 0.7.2 (2017-04-05)
=============================

New features:
 - Invites from IRC are now forwarded to Matrix. (Thanks @erdnaxeli!)

Improvements:
 - There have been substantial improvements to CPU usage at both startup and normal usage.
 - There have been substantial improvements to RAM usage at both startup and normal usage.
 - Initial Matrix-to-IRC membership list syncing times have been reduced.
 - Trying to join a `+r` channel will now result in being kicked from the corresponding Matrix room.
 - The config option `userModes` is no longer applied to the bridge bot. This allows provisioning requests to continue whilst still having PM guards enabled.
 - Additional IRC domains can now be added. This allows more randomisation than DNS lookups alone. See `config,sample.yaml`.
 - An HTTP(S) socket limit of 1000 has been added to prevent slow Synapse servers from causing the bridge to consume thousands of FDs.
 - Logging has become less verbose and more informative.
 - Metrics will now monitor the number of dropped requests due to `dropMatrixMessagesAfterSecs`.

Bug fixes:
 - Fixed a bug which caused IPv6 DNS rotations to not be honoured when using TLS.
 - Fixed a bug in node-irc which caused `modePowerMap` to not work correctly.
 - Fixed a race condition when creating a dynamic channel which is `+i`, which could cause the resulting Matrix room to not be invite-only.
 - Fixed a race condition which could cause M->I join events to fail if the connection was not yet established.
 - Fixed a bug which caused new public channels which were `+s` to be published to the global directory listing.

Changes in 0.7.1 (2017-01-18)
=============================

Scripts:
 - Added a script which allows bridge operators to remove idle Matrix users from bridged rooms.

New features:
 - IRC operator levels (voice/op/etc) can now be automatically mapped to corresponding Matrix power levels. This mapping is imperfect, but can be used as a coarse guideline for users who want to set room names/topics/etc on Matrix without having to go via the Provisioning API or asking the IRC bridge administrator. See `config.sample.yaml`.
 - `!whois` can now additionally be called with a Matrix user ID which will return the nick of that user ID on the IRC network.

Improvements:
 - Changed the text which is sent when a file/image/video/long text is sent from Matrix to IRC.
 - Concurrently perform `/joined_members` HTTP calls on startup to speed up the process of gathering Matrix users to connect to IRC.
 - Redo the `!help` message.
 - Reduce the amount of debug logging. Redo some log messages to be more informative.
 - IPv6 connections can now be force-enabled without the need for an IPv6 prefix by the `ipv6.only` flag in the config file. (Thanks Oleg Girko <ol@infoserver.lv>)

Bug fixes:
 - Fixed multiple bugs which could cause specific IRC users in specific rooms to not be bridged through to Matrix.
 - Fixed a bug when formatting IRC codes to HTML which would incorrectly treat bold/italics/underline as "enabled" flags rather than "toggle" flags. Previously, the text `hello 0x20x2 world` would incorrectly boldify "world" instead of toggling bold on and off again.
 - Fixed a bug which caused TLS connections over IPv6 to not use DNS rotation.


Changes in 0.7.0 (2016-12-19)
=============================

**BREAKING CHANGES:**
 - The `appService` config value which was deprecated in 0.3.0 has now been removed.
 - This version of the IRC bridge requires Synapse v0.18.5-rc3 or above.
 - Statsd metrics are now deprecated and will be removed in a future release.

Scripts:
 - A script to grant increased power level to a Matrix user in a dynamically bridged IRC room has been added.
 - A script to remove a user from all known bridged IRC rooms has been added.

New features:
 - Storing IRC Passwords:
   - Matrix users can now specify a [server password](https://en.wikipedia.org/wiki/List_of_Internet_Relay_Chat_commands#PASS) to authenticate with the IRC server on startup. On most IRC servers, this is an alternative mechanism to authenticate with NickServ.
   - To enable this functionality in the bridge, a private key needs to be generated. Passwords are stored encrypted at rest.
   - WARNING: the bridge is forced to send plaintext passwords to IRC, _not_ the hash of passwords. Matrix users are trusting the bridge with their actual, plaintext, non-hashed password.
   - Sending `!storepass [server.name]` to the admin room will encrypt and store a password for a Matrix user.
   - Sending `!removepass [server.name]` to the admin room will remove the encrypted password that the user has set from the database.
 - Default user modes:
   - The default user modes for every Matrix user's IRC client can now be set in the config via `ircClients.userModes`.
 - Dropping old Matrix messages:
   - Messages that the bridge receives will be dropped if they are more than _N_ seconds old.
   - This can be configured using the `homeserver.dropMatrixMessagesAfterSecs`.
 - Prometheus metrics:
   - The bridge can now run a `/metrics` listener for Prometheus-based metrics reporting.
   - Metrics can be enabled by setting `metrics.enabled`.
   - Statsd metrics are now **deprecated** and will be removed in a future release.

Improvements:
 - `!quit [server.name]` now attempts to kick the Matrix user that issues the command from the rooms in which they are being briged. This is done before the user's respective IRC client is disconnected.
 - The bridge now randomly jitters quit debounce delays between a minimum and maximum amount of time. This is in order to prevent the HS being sent many leave requests all at once following a net-split that lasts a very long time. (See `quitDebounce` in `config.sample.yaml`)
 - Initial IRC -> Matrix leave syncing is now implemented.
 - Errors received by the bridge when _joining_ an IRC client to a channel can now be seen in the admin room at startup.
 - Provisioning logs are now more detailed.
 - Bridge `m.video` uploads as files.
 - The bridge now uses the AS-specific room publication API. This requires Synapse v0.18.5-rc3 or above.
 - The bridge now uses new Homeserver membership list APIs: `/joined_rooms` and `/rooms/$room_id/joined_members`. This is required in order to sync membership lists. This requires Synapse v0.18.5-rc3 or above.

Bug fixes:
 - Fixed a rare bug which could cause the bridge to tightloop when Matrix users leave a bridged channel.
 - Prevent multiple PM rooms being created when PMs are sent from IRC to Matrix in rapid succession.
 - The namespace that the bridge uses to claim user names and aliases has been restricted to the HS to which it is connected, rather than any HS which might also have an IRC bridge running.
 - Bumped the minimum supported Node.js version from 4.0 to 4.5 to fix a bug which caused TLS and IPv6 to not work together: https://github.com/nodejs/node/pull/6654
 - Ident usernames will now always begin with A-z. Previously, the bridge abided by RFC 2812, but on some networks this was treated as an invalid username.
 - Fixed a regression which prevented banned connections from waiting BANNED_TIME_MS between connection attempts.

Changes in 0.6.0 (2016-10-26)
=============================

New features:
 - Presence Syncing / Quit Debouncing / Net Split Handling: When a net split occurs on IRC and incremental membership list syncing was set to true in previous versions, a lot of spam would be sent to the HS despite the possibility of the same clients reconnecting shortly afterwards. With this new update, QUITs received from IRC are debounced if a net split is considered ongoing. This uses the heuristic of QUITs per second being greater than a certain threshold. If the threshold is reached, debouncing kicks in, delaying the bridging QUITs to the HS for `delayMs`. If the clients reconnect during this grace period, the QUIT is not bridged. In the meantime, Matrix presence is used to indicate that the user is offline. The associated configuration for this can be found in `config.sample.yaml` as `quitDebounce`.
 - Topic Bridging: Topics are now bridged from IRC to Matrix in aliased rooms or rooms created via `!join` in the admin room.
 - Custom CA: A custom Certificate Authority certificate can now be given in the config file for using SSL to connect to IRC servers. (Thanks, @Waldteufel!)
 - Custom Media Repo: `media_url` in the bridge config file can now be set for setups where media uploaded on the Matrix side is not stored at the connected HS.

Improvements:
 - Add `!quit server.name` admin room command to disconnect an associated virtual IRC user from a given IRC server.
 - Turn of AS rate limiting when generating registration files.
 - `!join` admin room command now creates rooms with the join rule set to `dynamicChannels.joinRule` instead of always being private.

Bug fixes:
 - !help command no longer requires server name
 - The bridge now ignores NickServ and ChanServ PMs that previously it was trying to bridge erroneously.
 - Fix plumbing channels with capital letters in them.
 - Fix flaky tests(!) due to not killing bridged client instances between tests.
 - Fix the bridge taking forever calling `/initialSync` on the HS when a user leaves a room bridged into >1 channel. It instead uses `/$room_id/state` for each bridged room.

Changes in 0.5.0 (2016-10-06)
=============================

New features:
 - A new server config item, ```reconnectIntervalMs``` has been added and is used to throttle reconnections to an IRC server in a queue, where one reconnection is serviced per interval.
 - Added Third Party Lookup - for mapping IRC user/channel names into Matrix user IDs or room aliases.
 - Added config ```floodDelayMs``` which is used to drip feed membership entries at the specified rate when syncing membership.

Improvements:
 - Provisioning:
   - Provisioning of mappings has been improved by requiring that an IRC channel operator (or admin) in the plumbed channel respond with 'yes'/'y' before the mapping can be created to prevent abuse.
   - During provisioning, matrix room state ```m.room.bridging``` is used in the room in the new mapping to signal whether the status of the bridging is 'pending', 'success', or 'failure':
    ```JS
    {
        content: {
            bridger: 'nick',
            status: 'pending'
        }
    }
    ```
   - Route loops are now prevented using ```m.room.bridging``` as an indication that bridging exists.
   - The ```queryLink``` endpoint for asking for a list of operators in a given channel has been added. This list is acquired through the bot joining a channel, but they are cached temporarily to reduce join/part spam.
   - The ```queryNetworks``` endpoint was added and can be used to query the available networks on the bridge.
   - The IRC bot will leave a channel if it is no longer mapped to any other upon unlinking. The matrix bot will also leave an totally unlinked room.
   - Better error message are given when linking.
   - Only moderators in a matrix room can unlink.
 - The wording of messages sent to admin rooms has been improved, as well as a helpful message to get things started.
 - Sync +s mode in channels with room visibility. +s = 'hidden from published room directory', -s = 'listed on the published room directory'.

Bug fixes:
 - Room alias requests can only be done for channels that start with ```#``` to avoid confusion with people not being able to join ```#ircnetwork_somechannel:domain.com```. The important thing being the missing ```#``` before ```somechannel```.
 - Prevent admin room from being created when plumbing. Previously, the bot would treat a linked room as an admin room, and so allow users to issue commands in it (but only after unlinking again).
 - If the bot is enabled, join a channel when linked.
 - Part IRC clients which should no longer be in a channel due to unlinking.
 - When an IPv6 prefix is provided, assume outgoing IRC connections will be IPv6, instead of relying on the specified IRC domain only resolving to IPv6 addresses. Previously, this would cause issues with IPv6 bound outgoing connections attempting to connect to IPv4 addresses.
 - Do not cache stale clients in the client pool. Previously, stale BridgedClients would be left in the client pool if the bot was disconnected and then reconnected. This resulted in the bot being unable to respond or join/leave channels when requested to by provisioning request.


Changes in 0.4.0
================

New features:
 - Kicks to and from Matrix will now be mirrored. This does not alter the
   ops/power level of any user, and hence may not always succeed.
 - PM rooms now have a `federate` flag to control whether they can be federated
   or not (via the `m.federate` option on the room creation).
 - Long messages sent from Matrix will now be uploaded to Matrix as `.txt` files
   before being sent to IRC. The number of lines allowed before uploading can
   be configured by a new `lineLimit` option in `config.yaml`.
 - Add a dynamic provisioning API to create/delete Matrix<-->IRC links on a
   running bridge instance. These links do NOT have preference over config-specified
   mappings.
 - Allow arbitrary IRC commands to be sent to an IRC network via the Matrix
   admin room.

Improvements:
 - Connection notices will now only be sent to Matrix users after receiving
   `RPL_WELCOME` rather than establishing a TCP connection. This reduces message
   spam when connections fail to register (due to throttling, etc).
 - User and Alias regexes generated by the bridge will now be scoped to the
   homeserver rather than set as a wildcard (which would result in traffic from
   federated servers being sent to the bridge).
 - When an IRC connection receives an error that means they failed to join the
   channel (e.g. `err_bannedfromchan`), the bridge will now kick the corresponding
   Matrix user from the room.

Bug fixes:
 - Fixed a bug whereby a metric was not sent to update the connected client count
   when reconnecting.
 - Fixed a bug whereby a nick set via `!nick` would not be persisted through
   reconnections.
 - Fixed a bug which caused the static config mappings to be preserved even when
   they were changed in `config.yaml`.

Changes in 0.3.1
================
New Features:
 - A "debug API" has been added and can be enabled via `ircService.debugApi.enabled: true`.
   See `config.sample.yaml` for the exposed REST API.
 - A new command `!whois Nick` has been added.
 - IRC channels with `+k` (a password is required) can now be accessed via the bridge using
   the `!join` command, which now has an optional `key` parameter.

Improvements:
 - Nickname validation logic now more accurately tracks RFC 2812 - in particular the allowed
   *first* character of a nick. The max nickname length (9) in RFC 2812 is ignored, as most
   servers have a higher limit (30) and connecting with a shortened form and then expanding
   it based on the `RPL_ISUPPORT NICKLEN` is needlessly tedious given most IRC servers
   automatically truncate long nicknames.
 - If a Matrix user leaves a PM room with an IRC user and the IRC user sends a message to
   them, the bridge will now automatically re-invite the Matrix user back into the room
   they left.
 - Issuing a `!join` command will now make the connected IRC client send a `JOIN` under
   the following circumstances:
     * The `!join` has a `key` - This is necessary because the bridge does not store channel keys.
     * The bridge is mirroring Matrix-to-IRC joins.

Bug fixes:
 - Fixed various issues with responses to the `!nick` command. It will now time out after
   10 seconds, rather than listen indefinitely for the next `NICK` reply. It will also
   listen for a wide variety of `NICK` error replies, including some server-specific error
   codes, in order to fail faster. In addition, the `|` character is now correctly allowed
   as part of a nickname for `!nick` commands.
 - Fixed a bug whereby starting the bridge pointed to an inactive Homeserver would cause
   the bridge to fail to start up and not terminate the process. The bridge will now retry
   `/initialSync` indefinitely so it can start up as soon as the Homeserver becomes active
   again.
 - Fixed a bug which caused the bridge to terminate due to `ECONNRESET`.
 - Fixed a bug which caused the bridge to attempt to set the `TOPIC` of an IRC channel
   based on an `m.room.topic` which did not have a `state_key` of `""`.
 - Fixed a bug which caused initial IRC-to-Matrix membership list syncing to not occur,
   even if it was enabled in `config.yaml`.

Changes in 0.3.0
================
This update implements full `matrix-appservice-bridge` support in the IRC bridge and adds a number of smaller features.

**BREAKING CHANGES:**
 - The structure of the NEDB databases has changed. You must run the [the upgrade script](https://github.com/matrix-org/matrix-appservice-irc/blob/develop/scripts/upgrade-db-0.1-to-0.2.js) in order to continue running the bridge. This must then be followed by [another upgrade script](https://github.com/matrix-org/matrix-appservice-irc/blob/develop/scripts/upgrade-db-0.2-to-0.3.js).
 - The CLI args have changed in this version to bring them in-line with [the bridge library](https://github.com/matrix-org/matrix-appservice-bridge):
    * To generate a registration file:

        ```
        node app.js -r [-f /path/to/save/registration.yaml] -u 'http://localhost:6789/appservice' -c CONFIG_FILE [-l my-app-service]
        ```
    * To run the bridge:

      ```
      node -c CONFIG_FILE [-f /path/to/load/registration.yaml] [-p NUMBER]
      ```

New Features:
 - Nicks set via `!nick` will now be preserved across bridge restarts.
 - EXPERIMENTAL: IRC clients created by the bridge can be assigned their own IPv6 address.
 - The bridge will now send connection status information to real Matrix users via the admin room (the same room `!nick` commands are issued).
 - Added `!help`.
 - The bridge will now fallback to `body` if the HTML content contains *any* unrecognised tags. This makes passing Markdown from Matrix to IRC much nicer.
 - The bridge will now send more metrics to the statsd server, including the join/part rate to and from IRC.
 - The config option `matrixClients.displayName` is now implemented.

Bug fixes:
 - Escape HTML entities when sending from IRC to Matrix. This prevents munging occurring between IRC formatting and textual < element > references, whereby if you sent a tag and some colour codes from IRC it would not escape the tag and therefore send invalid HTML to Matrix.
 - User IDs starting with `-` are temporarily filtered out from being bridged.
 - Deterministically generate the configuration file.
 - Recognise more IRC error codes as non-fatal to avoid IRC clients reconnecting unecessarily.
 - Add a 10 second timeout to join events injected via the `MemberListSyncer` to avoid HOL blocking.
 - 'Frontier' Matrix users will be forcibly joined to IRC channels even if membership list syncing I->M is disabled. This ensures that there is always a Matrix user in the channel being bridged to avoid losing traffic.
 - Cache the `/initialSync` request to avoid hitting this endpoint more than once, as it may be very slow.
 - Indexes have been added to the NeDB .db files to improve lookup times.
 - Do not recheck if the bridge bot should part the channel if a virtual user leaves the channel: we know it shouldn't.
 - Refine what counts as a "request" for metrics, reducing the amount of double-counting as requests echo back from the remote side.
 - Fixed a bug which caused users to be provisioned off their `user_id` even if they had a display name set.

Changes in 0.1.1
================
**Requires Node v4+**

Features:
 - `app.js` is now added to `.bin` so can be invoked directly.
 - Added config option `ircClients.idleTimeout` to allow virtual IRC clients to
   timeout after a specified amount of time.
 - **Deprecate** `dynamicChannels.visibility` in favour of
   `dynamicChannels.createAlias`, `dynamicChannels.published` and
   `dynamicChannels.joinRule` which gives more control over how the AS creates
   dynamic rooms.
 - Added `matrixClients.mirrorJoinPart` to make virtual IRC users join and part
   as their real Matrix counterparts join and leave rooms (the other way around
   to the existing `ircClients.mirrorJoinPart`).
 - Added a `membershipLists` section to control syncing of membership lists.

Improvements:
 - Replaced `check.sh` with `npm run lint` and `npm run check`.
 - Listen for `+k` and `+i` modes and change the `join_rules` of the Matrix
   room to `invite` when they are set. Revert back to the YAML configured
   `join_rules` when these modes are removed.

Bug fixes:
 - Make channels case-insensitive when joining via room aliases and when mapping
   to rooms.
 - Strip unknown HTML tags from Matrix messages before sending to IRC.
 - Don't try to leave Matrix rooms if the IRC user who left is a virtual user.
 - And more..
