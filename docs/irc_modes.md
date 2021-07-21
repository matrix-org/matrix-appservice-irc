IRC Modes
=========

This chapter explains how various IRC channel modes are interpteted by the bridge, and how you can best configure your
channels to work well with the bridge.

Note: While the bridge tries to follow the RFCs where possible, due to the somewhat fragmented nature of IRC the bridge is
designed for maximum compatibility with [Freenode's IRCd](https://github.com/freenode/ircd-seven).

## User modes to power levels

User modes are mapped to certain power levels on Matrix. For those unaware, Matrix power levels typically range between
0-100 where zero represents a user that may only speak and 100 is an admin of the room (although these are modifiable).

By default the bridge maps users like so

```yaml
# taken from config.sample.yaml
modePowerMap:
    o: 50
    v: 1
```

An operator on the IRC side of the bridge will be given moderator privileges (PL50) and a voiced user will be given
PL1. In `+m` (moderated) rooms, users who are not voiced cannot speak and so the Matrix room will not allow users with
PL0 (that is, without +v) to speak.

The IRC bridge admin can customise this power level mapping to however they see fit.

## Bans, Invite only and Registered only (+b / +i / +r)

The IRC bridge will kick a Matrix user on join if they are not able to join the IRC channel. This means if the IRC
user is banned, the room is invite only (and the user has not been invited) or the channel is registered only then
the user will not be able to join it. A reason is given in the Matrix ban, and a more verbose error is given in the
user's admin room.

### Invite exemption (+I)

Some communties prefer to keep their channels closed but allow the bridge to access the channel. It is trivial to do
this by using the `+I` channel mode. The format is the same as an [extban](https://freenode.net/kb/answer/extbans).

For example to allow matrix.org bridge users to access your invite-only channel, you would do:

```
/mode #the-secret-cookies +I !@gateway/shell/matrix.org/*
```

## +s (Secret)

By default the IRC bridge will automatically insert any newly joined rooms into the homeserver's room directory.
The +s mode will mark the channel as secret and the bridge will not show it in the
directory. The room will still be joinable however.

## Key protected (+k)

If a channel is protected by a key, it cannot be entered by joining via an alias. Instead you may join by using
the [`!join`](admin_room#join) command. Be aware that the bridge purposefully does not store channel keys in
the database as a security precaution so you should be expected to do this again on bridge restart.

## Channel Forwarding (+f)

Channel forwarding is presently unsupported, see https://github.com/matrix-org/matrix-appservice-irc/issues/214
for information and updates.
