Room Configuration
==================

You can now configure certain options on a per-room basis from within your Matrix client. Currently
this requires a bit of technical know-how as no clients expose an interface to changing the
bridge configuration.

## The `org.matrix.appservice-irc.config` event

*Not all bridges support all configuration options listed. Check with the bridge administrator before
creating an issue.*

The bridge allows room moderators to create a state event in the room to change the way the bridge
behaves in that room. 

In Element you can modify the room state by:

- Opening the room you wish to configure.
- Typing `/devtools`.
- Click Explore Room State.
- Look for the `org.matrix.appservice-irc.config` event.
- You should be able to click Edit to edit the content, and then hit Send to adjust the config.

If an event does not exist yet, you can instead do:

- Typing `/devtools`.
- Click Send Custom Event.
- Click the Event button to change the type to a **State Event**.
- The event type must be `org.matrix.appservice-irc.config`
- The state key can be left blank.
- Enter the `Event Content` as a JSON object. The schema is described in the following section.
- You may now hit Send to apply the config.

## Configuration Options

### `lineLimit`

Type: `number`

This allows you to modify the minimum number of lines permitted in a room before the
message is pastebinned. The setting is analogous to the `lineLimit` config option in
the bridge config file.

### `allowUnconnectedMatrixUsers`

Type: `boolean`

Some IRC networks require that Matrix users must be joined to the IRC channel before
*any* messages can bridge into the room. You can override this by setting this key
to `true`.