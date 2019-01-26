# remove-idle-users.py
A script to kick idle bridged users from a given Matrix room.

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
    -p or --prefix:     User prefix to determine whether a user should be kicked. E.g. @freenode_
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
