# Admin Room

Most bridges will send you an invite to an admin room once you connectto control your connection 
to IRC, but larger bridges like matrix.org's Freenode bridge will not (you will need to start a
conversation with the bot manually).

## Bot Commands

The admin room allows you to send commands to a room to manipulate your IRC session. 

Some commands take a `[irc.example.net]` which lets you choose which IRC network to direct the
request to, as some bridges host multiple IRC networks. Typically matrix.org bridges only host
one network.


### `!join`

`!join [irc.example.net] #channel [key]`

Joins a channel on the IRC side and invites you to the Matrix room. This command will create a new
portal room if a room doesn't exist. This is useful where you cannot with the alias syntax (e.g. the channel requires a key).


### `!cmd`

`!cmd [irc.example.net] COMMAND [arg0 [arg1 [...]]]`

Send a raw command through the IRC connection. This is useful for making MODE changes to yourself
or to a channel if you have operator priviledges. Note that this command will not produce any response
text, so commands will happen silently.


### `!whois`

`!whois [irc.example.net] NickName|@alice:matrix.org`

A powerful command to either lookup a nickname *or* a Matrix UserID and return information about that user.


### `!storepass`

`!storepass [irc.example.net] passw0rd`

Store a password, or a `username:password` combination to be sent as a PASS command on connection to the server.
This will also reconnect you to IRC so the PASS command can be sent.

**This action will store your password in encrypted form on the IRC bridge**, so be sure to use a unique password
for the IRC service. 


### `!removepass`

`!removepass [irc.example.net]`

Remove your stored password, will NOT reconnect you.


### `!listrooms`

`!listrooms [irc.example.net]`

List all the Matrix rooms that you are joined to which are also connected to IRC.


### `!quit`

QUITs you from all connected networks AND **kicks you from all IRC rooms** (except DMs). This is to avoid
leaking history to your Matrix account while not being visible to IRC users. This command will not remove
your password or stored data with the bridge. Ask the owner of the bridge to remove that data for you.


### `!nick`

`!nick [irc.example.net] nick`

Set your nickname for your IRC conenction and persist it across restarts. If the nickname clashes with another
user's nickname, this will fail.


### `!feature`

`!feature feature-name [true/false/default]`

Enable or disable a feature for your account. Set it to `true` to enable the feature, `false` to disable it, or `default`
to use the default based upon the bridge config.

Currently, the features you can use are:
- `mentions` - Determine whether IRC users can mention you on the IRC bridge. Note, that this will only stop mention text being turned
  into pills. See [this section](usage.md#message-behaviours) for an explanation of this feature.


### `!bridgeversion`

Prints the current version of the bridge.

The bridge bot allows you to control your IRC connection through various bot commands. Some
commands are reserved for bridge administrators, which can be configured in the config file.


### `!plumb`

`!plumb !room:example.com irc.network.net #channel`

*This command only works for bridge administrators*

This command allows you to plumb a IRC channel into a room without using the HTTP provisioning API. This command does NOT 
validate that you have permission to do this on the IRC channel so please take care to ensure that the IRC channel is
aware of your actions.

You must invite the bridge bot into the Matrix room for this to work.


### `!unlink`

`!unlink !room:example.com irc.network.net #channel`

*This command only works for moderators of a bridged Matrix room and bridge administrators*

This command allows you to unlink a IRC channel from a room. Users are only able to remove links for rooms they are a moderator in (power level of 50 or greater). Administrators of the bridge are able to remove links from any room.


### `!help`

Prints a list of commands for the bridge.
