Debug API
=========


The Debug API is a powerful HTTP API to make adjustments to the bridge at runtime, and is typically useful
when administrating large bridges. Some functionality has moved to the [Admin Room](admin_room)
interface as sending commands over Matrix is preferred, however, many powerful commands are exposed here.

You can enable this feature in the config file:

```yaml
ircService:
  # ...
  debugApi:
    enabled: true
    port: 11100
```

**Note: The Debug API listens on `0.0.0.0` by default, so be careful to lock down access to this port.**

To access the API over `curl`:

```sh
curl http://127.0.0.1:11100/inspectUsers?access_token=AS_TOKEN_FROM_REGISTRATION_FILE
```

## Endpoints

<!-- no toc -->
- [`GET /inspectUsers?regex={userRegex}`](#get-inspectusersregexuserregex)
- [`POST /killRoom`](#post-killroom)
- [`POST /killUser`](#post-killuser)
- [`POST /reapUsers`](#post-reapusers)
- [`GET /irc/$domain/user/$user_id`](#get-ircdomainuseruser_id)
- [`POST /irc/$domain/user/$user_id`](#post-ircdomainuseruser_id)


### `GET /inspectUsers?regex={userRegex}`

#### Request Parameters

- `userRegex` A JS regex string which should match against MXIDs. E.g. `@foobar_.*:matrix.org`.

#### Example Response

```js
{
  "users": {
    "@Half-Shot:half-shot.uk": [
      {
        "channels": [
          "#matrix"
        ],
        "dead": false,
        "server": "libera.chat",
        "nick": "Half-Shot"
      }
    ]
  }
}
```

### `POST /killRoom`

Stop a room from being bridged. This will remove IRC ghost users from the room
and disconnect Matrix users from the channel.

The [Admin Room](admin_room#unlink) features a less
powerful version of this command.

#### Request Body

```json5
{
  "room_id": "!foo:bar", // The Matrix Room ID. Required.
  "domain": "irc.foo.bar", // The IRC domain. Required.
  "channel": "#evilcave", // The IRC channel. Required.
  "leave_notice": true, // Should a notice be sent on unbridge. Default: true.
  "remove_alias": true, // Should the room alias for the room be removed. Default: true.
}
```

#### Response Body

The response body will contain a JSON array of stages that were successful and failed as
it's possible for this command to only be partially successful.

Typical successful response:

```json5
{
  error: [],
  stages: ["Removed room from store", "Left notice in room", "Deleted alias for room", "Parted clients where applicable."],
}
```

Typical error response:

```json5
{
  error: ["Room not found"],
  stages: [],
}
```

### `POST /killUser`

This will kill a connection to IRC for a given user on all networks they are connected to.

#### Request Body

```js
{
  "user_id": "@foo:bar",
  "reason": "Trust nobody"
}
```

#### Response Body

If a disconnection was successful, the bridge will emit "null". Otherwise, it may emit an error
message in plain text.

### `POST /reapUsers`

This will kill multiple connections for users considered "idle". This is a powerful and
expensive operation and should be taken with care.

Idleness is calculated by how long it has been since a user has sent a message/joined/left a room.
This is calculated by whether the appservice bot or it's users have seen the user perform any actions
(i.e. left a IRC bridged room or sent a message). Due to limitations of Matrix, it is not possible to
discover "lurkers".

#### Request Parameters

- `server` is the server name you wish to disconnect users from. This is the key of
  your server configuration object in the config section.
- `since` is the number of hours a user has been idle for to be considered `idle`. This must be an integer.
- `reason` is the reason string to disconnect users with. E.g. "You have been idle for too long".
- `dryrun` is whether to actually disconnect users, or just calculate which users
  should be disconnected and output it to the response.

#### Response Body

The bridge will "stream" logs to the client in plain text format. Do not close the
connection before the operation has finished.

### `GET /irc/$domain/user/$user_id`

Return the state of a user's `BridgedClient`. Typically this is only useful for deep debugging
of connection issues.

#### Request Parameters

- `$domain` The domain of the IRC network you are requesting information on.
- `$user_id` The user_id of the user you are requesting information for.

#### Response Body

A plain text dump of the object via the [inspect](https://nodejs.org/dist/latest-v16.x/docs/api/util.html#util_util_inspect_object_options)
API.

### `POST /irc/$domain/user/$user_id`

Send raw IRC command(s) as the given user.

#### Request Parameters

- `$domain` The domain of the IRC network you are requesting information on.
- `$user_id` The user_id of the user you are requesting information for.

#### Request Body

The body should be a newline delimited list of commands to send to IRC.

### Response format
The bridge will wait 3 seconds to buffer up any responses from the IRCD and return
them in a newline delimited JSON format.
