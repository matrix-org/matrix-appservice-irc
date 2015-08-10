Changes in 0.1.1
================

Features:
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
