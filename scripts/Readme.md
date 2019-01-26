# remove-idle-users.py
A script to kick idle Matrix users from a Matrix room that has an IRC bridge. 
It will only kick Matrix-only users, without a given `prefix` and will never kick
the appservice bot itself. This is useful, because on the IRC side, bridged matrix
users, that are offline for a certain period are not shown as joined on the 
IRC-side user list any more. Kicking them on the matrix side is clearing up these
cases quite well. You have to determin the timeframe, after which a user is not
visible any more on the irc side and set that timeframe in this script as `--since`
option.

## usage

    python remove-idle-users.py <options>
    
where you have to set the right options:

#### one of these
    -a or --alias:      The alias of the room eg '#freenode_#matrix-dev:matrix.org'
    -r or --room:       Optional. The room ID instead of the alias eg '!curBafw45738:matrix.org'
    
#### required
    -t or --token:      The access token
    -H or --homeserver: Base homeserver URL eg 'https://matrix.org'
    -s or --since:      Days since idle users have been offline for eg '30'
    -p or --prefix:     User prefix to select which users should not be kicked. E.g. @freenode_
    -u or --user:       The user ID of the AS bot. E.g '@appservice-irc:matrix.org'

## example:

    python ./remove-idle-users.py -a '#some-room-alias:matrix.yourserver.org' -t YOUR-ADMIN-TOKEN -H http://matrix.yourserver.org:8008 -s 30 -p irc_ -u @appservice-irc:irc.hackint.org 

# grant-ops-in-room.py

Grant full ops to a user in a portal room.

# migrate-users.py 

A script to remove suffixes from display names the bridge controls.

# remove-user.py 

Remove a Matrix user from all known bridged rooms.

# unbridge.js
Unbridge a dynamically created room with an alias.

This will DELETE the alias->room_id mapping and make the room's
join_rules: invite. You can optionally send a message in this
room to tell users that they should re-join via the alias.
This script does NOT create a new room. It relies on the AS to
do this via onAliasQuery pokes.

# upgrade-db-0.1-to-0.2.js

Database Upgrade script (v0.1 => v0.2)

# upgrade-db-0.2-to-0.3.js

Database Upgrade script (v0.2 => v0.3)
