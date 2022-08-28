IRC Modes
=========

This chapter explains how various IRC channel modes are interpreted by the bridge, and how you can best configure your
channels to work well with the bridge.

Note: While the bridge tries to follow the RFCs where possible, due to the somewhat fragmented nature of IRC the bridge is
designed for maximum compatibility with [Libera's IRCd](https://github.com/solanum-ircd/solanum).

## User modes to power levels

User modes are mapped to certain power levels on Matrix. For those unaware, Matrix power levels typically range between
0-100 where zero represents a user that may only speak and 100 is an admin of the room (although these are modifiable).

By default the bridge maps users like so:

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

## Channel modes that prevent bridged users from joining

Below are some common channel modes that prevent bridged users from joining. The modes in parentheses and the examples
given are for Libera.Chat, other IRCds may have different mode letters or not have the capability at all, so consult the
help documentation of channel for other networks to find out what they support.

If a user is not able to join the IRC channel, they will be kicked from the Matrix room. The reason is given in the
Matrix kick message, and a more verbose error is given in the user's admin room.

### Ban (`+b`)

If the user matches a ban mask on the IRC channel, they cannot join. An IRC channel op can exempt a specific bridged
user by setting a ban exemption mask (`+e`) in two ways, either using the IP address of the bridged user:

```
/mode #channel +e *!*@2001:470:69fc:105::b2ed
```

or, if the Matrix user is identified to services, using the `$a` extban syntax:

```
/mode #channel +e $a:matrixuser
```

Note that exempting a user means that user will not be affected by bans or quiets,
so be sure you trust the user before giving them an exemption.

### Invite only (`+i`)

Some communities prefer to keep their channels invite only but allow the bridge to access the channel. An IRC channel
operator can set an invite exemption (`+I`) mask for the whole bridge:

```
/mode #channel +I *!*@2001:470:69fc:105::/64
```

This will also work on other IRC networks that support IPv6 and do not automatically cloak hosts (notably OFTC), however
the IP address range will be different. Running `/whois` on a Matrix user nick will give you the IPv6 /64 range to use.

Adding an invite exemption for a single Matrix user is done the same way as the ban exemption methods above, replacing `+e`
with `+I`.

### Registered only (`+r`)

If `+r` is set on a channel, Matrix users not identified to services cannot join.

### Key protected (`+k`)

If a channel is protected by a key, it cannot be entered by joining via an alias. Instead you may join by using
the [`!join`](admin_room#join) command. Be aware that the bridge purposefully does not store channel keys in
the database as a security precaution so you should be expected to do this again on bridge restart.

### Channel Forwarding (`+f`)

Channel forwarding is presently unsupported, see https://github.com/matrix-org/matrix-appservice-irc/issues/214
for information and updates.

## Other important channel modes

These channel modes do not prevent a user from joining, but they still affect various properties of the room.

### Secret (`+s`)

By default the IRC bridge will automatically insert any newly joined rooms into the homeserver's room directory.
The `+s` mode will mark the channel as secret and the bridge will not show it in the directory. The room will still
be joinable however.

### Moderated (`+m`)

When mode `+m` is set, any users with a powerlevel of 0 (i.e. not opped or voiced) will be prevented from talking.

### Quiet (`+q`)

A quiet mask is similar to a ban mask, but only prevents the user from talking, not joining. If a Matrix user matches
a quiet mask, the message will not be sent to IRC but will still be sent to the Matrix room.

### Op moderated (`+z`)

When mode `+z` is set, messages that are normally blocked by `+m`, `+b`, and `+q` are instead sent to channel operators
using a statusmsg. The bridge currently does not understand how `+z` works, so setting `+mz` will still block Matrix
users with a powerlevel of 0 from talking in the channel.

Additionally, the bridge doesn't support statusmsg, so if the channel is set `+mz`, any messages that are affected by it
do not appear in the Matrix room.
