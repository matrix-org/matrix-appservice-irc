# IRC Operators

This chapter describes useful information about the bridge for IRC operators or IRC users.

The IRC bridge provides each Matrix user with one IRC connection in order to bridge them "natively"
into the IRC network, as so they can largely be treated as real users. Due to the 1:1 connection system,
it is often useful that the IRCD network provides the bridge host with a more relaxed ILINE limit depending
on the number of Matrix users they'd expect to use the bridge.

### The Matrix experience

When a Matrix room is bridged to IRC, all users (by default) on the Matrix side will be provided with a connection
to the room and will show up in the user list on IRC. The IRC users will also appear as "ghosts" on the Matrix side,
bearing a Matrix ID like `@irc_alice:matrix.org`. This allows a "native" feeling so that users do not have to worry
about the complexities of the protocols.

However as with all bridges, the native feeling can catch IRC or Matrix users unaware when things do not bridge well
(such as replies/threading or reactions).

### The [m]/-M suffix

By default, the IRC bridge will append a `-M` to nicks for Matrix users. This is to avoid clashes with a users
real identity on IRC as well as to highlight that the users are on the bridge (and may not even know the conversation is bridged to IRC).
The user has the option to change this by going to the bot and sending a `!nick` command, so the suffix should not
be used as a blanket detection method.

### Whois information

The bridge sets various bits of information about users:

The realname of a user will be their MxID. By default this will look like:

```
* [Half-Shot[m]] (half-shoth@2001:470:1af1:104:0:0:0:2223): @Half-Shot:half-shot.uk
* [Half-Shot[m]] #matrix-test
* [Half-Shot[m]] irc2.acc.umu.se :GIMPNet Server
* [Half-Shot[m]] is using a Secure Connection
* [Half-Shot[m]] End of WHOIS list.
```

### Portals and Plumbed

A Matrix room can be connected to a IRC network in one of two ways:

- A portal room, which is a Matrix room created by the bridge on demand when a Matrix user attempts
  to join an alias that does not yet exist. E.g. `#myproject:libera.chat`. The bridge will
  hold power over this room and grant moderator status (half-power) to any IRC operators or Matrix users
  with IRC ops in the room.
- A plumbed room (also known as provisioning). A Matrix user may create a room ahead of time for their
  community and later on decide to "plumb in" IRC users to that room. They can do this via an interactive
  UI in Element, via the `!plumb` command or even via a HTTP endpoint. If done interactively, the bridge
  has a verification process to ensure the user on the Matrix side has the blessing of the IRC ops first.
  However, it's possible for the IRC bot to lack kick abilities in the room so kicks and bans may not be
  bridged both ways.

(This is explained in more depth at [matrix.org](https://matrix.org/docs/guides/types-of-bridging#types-of-rooms).)

Additionally, a channel may be connected to one portal and multiple plumbed rooms without issue as the
messages from Matrix users are replicated to the other rooms for them. We typically do not recommend
multiple points of entry to the channel due to the obvious confusion this causes.

### Connection failure

If a Matrix user fails to join a channel due to a ban, they are kicked from it. If the Matrix user
fails to get a connection to IRC at all, they are also kicked from any rooms they are part of. The exception
to this rule is if the bridge bot (which does the kicking) lacks permission to kick members of the room.

### Line limits

The IRC bridge allows admins to configure a maximum amount of lines that can be sent at a time to a channel
by a Matrix user. The Matrix spec allows events to be sent by users up to 65k in size, so with some margin for
event padding, a message could feasibly be over 64k in size. The Matrix spec has no limit on how many lines
a single message can have so to avoid this issue the bridge will "pastebin" any overly large message rather
than send the message line by line.

This can be confusing for IRC users, so we typically try to have a sensible limit to line count. By default
the bridge only pastebins a message that is over 3 lines in length to avoid problems, but this can be increased
at the discretion of the bridge admin.


### History protection

Matrix is naturally history preserving, so that any message sent to a Matrix room is sent to all
participating users/servers. They will be able to read these messages for as long as they
are joined to the room.

Bridged IRC rooms do not share history to Matrix users from before they have joined by default,
but history visibility can be changed by users with the correct power level on Matrix.

The bridge can also be configured to stop bridging all traffic from a channel to Matrix if it
cannot guarantee that a Matrix user is joined to the IRC channel, which is usually a step of last
resort should the bridge have failed to connect them. See the [administrators guide](administrators_guide.md#enforcing-matrix-users-to-be-connected-to-irc).
