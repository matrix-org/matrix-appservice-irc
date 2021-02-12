# Using the bridge

This chapter describes how to use the bridge and is intended for new or experienced Matrix
users.

## Getting connected

The IRC bridge will dynamically connect you to IRC when you start interacting with an IRC bridged room.
Some bridges, such as matrix.org, will connect you to IRC and join you to a channel the moment you join
the Matrix room. Others will only connect you to IRC when you attempt to send a message to a Matrix channel.

Once you are connected to IRC, any joins you make to rooms connected to IRC will be replicated as joins to the
IRC channel. By default your nickname will be `YourDisplayname-M`, but some bridges may alter this default
by using a `[m]` suffix instead.

### Joining a channel

Joining a public channel over the bridge is as easy as joining an alias, for instance:

`#freenode_#python:matrix.org` maps to the `#python` channel on Freenode.

### Private Messaging

Sending a PM to an IRC user means starting a conversation with `@freenode_Alice:matrix.org`,
which maps to the nickname `Alice` on Freenode.

If a PM is sent from the IRC side, it will either appear in your existing PM room or you will be invited
to a new room.

The room alias and user formats may differer depending on the bridge you are using, so be sure to check with the
server administrator if the above defaults are not working for you. Server administrators can check
[config.sample.yaml](https://github.com/matrix-org/matrix-appservice-irc/blob/develop/config.sample.yaml) for
instructions on how to change the templates for users and channels.

The wiki contains a [list of public IRC networks](https://github.com/matrix-org/matrix-appservice-irc/wiki/Bridged-IRC-networks)
including alias and user_id formats.

### Customising your experience

You may also want to customise your nickname or set a password to authenticate with services, you
can do this by PMing the bridge bot user. E.g. the matrix.org freenode bridge user is `@appservice-irc:matrix.org`.

```
!nick Alice
!storepass MySecretPassword
```

More commands can be found in the [Admin Room](./admin_room.md) section.

## Authentication

Most networks provide a mechanism for one to authenticate themselves. You can do this manually by messaging NickServ
or by providing a password to the bridge itself. See the [Admin Room](./admin_room.md) section for help.

## Message behaviours

Messages from IRC to Matrix appear in roughly as you'd expect them to. Emotes (`/me` text) are applied as Matrix supports
it, and mIRC format colours are applied too. The IRC bridge makes an attempt to replace nicknames in sent messages with 
user mention "pills".

![An illustration of the IRC mentions feature](images/irc_mentions.png)

### Matrix -> IRC formatting

Messages from Matrix are often richer than their IRC counterparts, as Matrix has support for sending HTML, files, edits and replies.

Basic formatting is supported such as **bolding** and *italics* but other formats are discarded. Messages that exceed the maximum
size of an IRC message *or* a message that contains newlines will be split into two or more messages. The configuration value
`lineLimit` sets the maximum permittied number of messages to be sent before the whole message is stored as a file and sent as a link.

For example:

```irc
> Half-Shot sent a long message: <https://matrix.org/_matrix/media/r0/download/matrix.org/fooobar/message.txt>
```
Files are sent as textual links such as:

```irc
> Half-Shot uploaded an image: meme.gif (1358KiB) < https://matrix.org/_matrix/media/r0/download/half-shot.uk/fooobar/meme.gif >
```
Edits are sent with a fallback star:

```irc
> Half-Shot: foo
> Half-Shot: * foobar
```

Replies are sent with context:

```irc
> Half-Shot: foo
> <Half-Shot "foo"> bar
```

Reactions or other non-message events are not sent presently.

## Encryption

Presently the bridge cannot work in an E2EE room. The bridge will leave any room that has encryption enabled. This is because
the bridge does not know how to read encrypted events and so far no work has been started to support this. IRC is not capable of
relaying E2E messages to IRC clients and as such the bridge would have to decrypt messages from Matrix and encrypt messages from
IRC. As such the team have chosen not to support encrypted Matrix rooms at this time.