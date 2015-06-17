Changes in 0.1.1
================
 - Added config option `ircClients.idleTimeout` to allow virtual IRC clients to
   timeout after a specified amount of time.
 - Replaced `check.sh` with `npm run lint` and `npm run check`.
 - Strip unknown HTML tags from Matrix messages before sending to IRC.
 - Don't try to leave Matrix rooms if the IRC user who left is a virtual user.
