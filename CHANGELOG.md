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
