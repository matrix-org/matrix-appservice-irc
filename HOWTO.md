Matrix<->IRC Gateway HOW-TO
===========================

This guide is designed to familiarise you with the configuration and running of
this IRC Application Service (AS) and provide a more thorough look at some of
the features of this AS.

Installing
----------
If you haven't already, check out the ``README`` for 
[Quick Start](README.md#quick-start) instructions on how to install the AS.
This project requires ``nodejs`` in order to run, and has been tested on 
``v0.10.25``.
```
$ git clone git@github.com:matrix-org/matrix-appservice-irc.git
$ cd matrix-appservice-irc
$ npm install  # may require sudo if you haven't told npm to install elsewhere
$ npm test  # make sure these pass!
```
Once that is done, you're ready to configure the AS.

Configuring
-----------
A [sample configuration file](config.sample.yaml) ``config.sample.yaml`` is 
provided with relatively "sensible" defaults, but **you will need to modify
it before things will work**. It is worth examining certain options more
closely before running the AS.

Either copy ``config.sample.yaml`` to ``config.yaml`` or create a new file.
By default, the AS will look for ``config.yaml`` in the current working
directory. You can override this by passing ``--config some_file.yaml`` or
``-c some_file.yaml`` when you call ``node app.js``.

### Pointing the AS at the Homeserver
```
+==========================================================================+
| You MUST have access to the homeserver configuration file in order to    |
| register this application service with that homeserver. This typically   |
| means you must be running your own homeserver to register an AS.         |
+==========================================================================+
```
The following options are **REQUIRED** in order to point the AS to the
homeserver (HS) and vice versa:
```yaml
appService:
  # This section contains information about the HS
  homeserver:
    # This url will be used by the AS to perform Client-Server API calls.
    url: "http://localhost:8008"
    # This value will be used when forming user IDs under certain
    # circumstances. This is typically the domain part of the 'url' field
    # above.
    domain: "localhost"
  # This section contains information about the AS
  appservice:
    # This is an arbitrary string: it can be anything you want. It is
    # strongly advised that it is a secure random string. This token
    # grants the AS power over the HS, so a weak token here could
    # compromise the security of the HS.
    token: "some_very_long_string"
    # This is the webhook that the HS will use to send events to.
    url: "http://localhost:3500"
  http:
    # This is the port that the AS should listen on.
    port: 3500
```


### Pointing the AS at your chosen IRC network
You probably already have an IRC network in mind that you want to bridge.
The bare bones **REQUIRED** configuration options are:
```yaml
ircService:
  servers:
    # This is the IRC server url to connect to.
    irc.example.com:
      mappings:
        "#some-channel": ["!someroomid:here"]
```
This would set up a simple mapping from ``#some-channel`` on 
``irc.example.com`` to ``!someroomid:here``, and that's it. Dynamic mappings
are *not* enabled by default.

To allow dynamic mappings:
```yaml
ircService:
  servers:
    irc.example.com:
      dynamicChannels:
        enabled: true
```
This will register a block of aliases which represent all the possible IRC
channels on ``irc.example.com``. To join ``#some-channel`` as a Matrix client,
try to join the room alias ``#irc_irc.example.com_#some-channel:localhost``.
You can now join any channel you like by modifying the alias you join. 

### Modifying templates
You may think that aliases like ``#irc_irc.example.com_#some-channel:localhost``
are unwieldy and horrible to type. You may only have one IRC network you plan
to bridge, so having to type out the server address every time is tiring.
Templates exist to fix this. They look like the localparts of various IDs
(user IDs, room aliases) but with the sigil (``@`` or ``#``) still attached.
You can specify an Alias Template which will be used by the AS to form new 
room aliases. For example, to get rid of the server in the alias:
```yaml
ircService:
  servers:
    irc.example.com:
      dynamicChannels:
        enabled: true
        aliasTemplate: "#irc_$CHANNEL"
```
This will shorten the alias to be ``#irc_#some-channel:localhost``.

The concept of templates extends to Nicks and User IDs as well. IRC users 
are created with user IDs like ``@irc.example.com_Alice:localhost`` which are
long and hard to type if you want to send a PM to them. You can shorten this 
to ``@irc_Alice:localhost`` like so:
```yaml
ircService:
  servers:
    irc.example.com:
      matrixClients:
        userTemplate:
          "@irc_$NICK"
```

The following variables are available for templates:

#### Nick Template
NB: These variables are sanitized by removing non-ASCII and invalid nick 
characters.

| Variable      | Description
| ------------- | -----------
| ``$USERID``   | A real Matrix user's user ID.
| ``$DISPLAY``  | A real Matrix user's display name OR user localpart if they have no display name.
| ``$LOCALPART``| A real Matrix user's user ID localpart (e.g. ``alice`` in ``@alice:home``)

#### Alias Template

| Variable      | Description
| ------------- | -----------
| ``$SERVER``   | An IRC server URL.
| ``$CHANNEL``  | An IRC channel name. Required.

#### User ID Template

| Variable      | Description
| ------------- | -----------
| ``$SERVER``   | An IRC server URL.
| ``$NICK``     | A real IRC user's nick.

Registering
-----------
Before the HS will send the AS any events, you need to register it. You can
generate a *registration file* for the AS by typing:
```
 $ node app.js --generate-registration
```
This will create a file ``appservice-registration-irc.yaml``. The HS is still
unaware of this file currently. In order to tell the HS about the registration,
you need to modify the **homeserver** configuration file (``homeserver.yaml``).
The **homeserver** configuration file needs to have:
```yaml
app_service_config_files:
   # This should be pointed to wherever the generated registration file is.
 - "/home/someone/matrix-appservice-irc/appservice-registration-irc.yaml"
```
**You will need to restart the homeserver in order for this to take effect.**

### Architecture
```
+--------+         (3)               +-------------+
| IRC AS |<----AS HTTP API-----------| Home Server |
|        |--Client-Server HTTP API-->|             |
+--------+       (extended)          +-------------+
       |                                   |
--generate-registration            read homserver.yaml
    (1)|                                   |(2)
       |   +-------------------+           |
       +-->| Registration File |<----------+
           |   - as_token      |
           |   - hs_token      |
           |   - app regex     |
           +-------------------+
           
1) The IRC AS generates a registration file containing the tokens to use.
2) The homeserver reads the registration and configures itself.
3) Both AS and HS communicate over HTTP using the assigned tokens.
```

### Safety checks
It is possible for the registration files being used between AS and HS to get
out of sync. If this happens, the AS will not recognize the homeserver token
and will produce errors ``Invalid homeserver token``. Likewise, the AS may
receive errors from the HS ``Invalid application service token.``. This is
annoying but possible to deal with.

What's more sinister is if the application specific regex changes. The tokens
may not have changed, but the AS may think it is in charge of a namespace it
doesn't have permission to use (e.g. thinking it has ``@irc_.*`` but it really
has ``@xmpp_.*``). This produces undefined behaviour in the AS. In order to
reduce the risk of the registrations getting out of sync like this, the IRC AS
appends a CRC of the AS configuration file to the homeserver token whenever the
AS configuration file is modified. If the configuration was changed, the CRC
check will fail when compared to the homeserver token and the IRC AS can fail
early. If you know for certain that your modifications to the configuration
file is safe (doesn't alter the registration regex), you can disable the CRC
check by passing ``--skip-crc-check`` or ``-s``. This is useful since otherwise
you would need to restart the HS for the new registration file to take effect.

Features
--------
Some of the features listed below require Matrix users the ability to talk to
the AS directly. This is done by creating a Matrix room and inviting the AS bot
to it. The AS bot's ``user_id`` defaults to ``@matrix-appservice-irc:<domain>``
but can be changed like so:
```yaml
appService:
  localpart: "ircas"  # Creates a user ID @ircas:<domain>
```

### Changing Nicks
By default, Matrix users are assigned a nick from the nick template and 
that's it. They cannot change their nick. You can grant Matrix users the 
ability to change their own nick like so:
```yaml
ircService:
  servers:
    irc.example.com:
      ircClients:
        allowNickChanges: true
```
Matrix users will now be able to change their nick to *anything*; the nick is
not restricted in any way. Matrix users can set their nick by inviting the AS
bot into a one-to-one Matrix room and sending a message with
``!nick <server> <new_nick>`` e.g. ``!nick irc.example.com bob``. In order for
nick changing to work, you must already have a nick, so you must already be
connected to the IRC network (e.g. by having sent a message).

### Private bridging
By default, dynamic mappings to an IRC network are present in the published
room list, and anyone can join these dynamic channels. This may be undesirable,
and you may want to make these hidden/accessible to select users. To make
dynamic mappings private:

```yaml
ircService:
  servers:
    irc.example.com:
      dynamicChannels:
        enabled: true
        visibility: "private"
        whitelist:
          - "@someone:localhost"
          - "@another:localhost"
```
Only ``@someone:localhost`` or ``@another:localhost`` can join these rooms now.
Private rooms cannot be joined via room aliases. You need to get the AS bot to
invite you to the room. To do this, create a room and invite the AS bot, then
type ``!join <server name> <channel>`` e.g. ``!join irc.example.com #foo``. You
must be on the whitelist for this to work.

### Ident
You may want to assign ident-verified usernames to the generated IRC clients
e.g. to scope bans to Matrix users rather than the entire application service.
This application service can run an 
[ident server](http://en.wikipedia.org/wiki/Ident_protocol) to make this 
possible. Ident is disabled by default. To enable it:
```yaml
ircService:
  ident:
    enabled: true
    port: 1113  # optional (default: 113) but this allows you to run the AS without root.
```

### Statsd
This application service supports sending metrics to a 
[statsd server](https://github.com/etsy/statsd). Metrics monitored include:
 - Memory usage (RSS, heap, etc)
 - Request outcomes (success/fail) and durations (ms).
Sending metrics is disabled by default. To enable this:
```yaml
ircService:
  statsd:
    hostname: "127.0.0.1"
    port: 8125
```

### Logging
Logging is configurable in the yaml, but there is also an extra verbose setting
you can enable. This is done by passing ``--verbose`` or ``-v`` to 
``node app.js``.

Contributing
------------

### Reporting a bug
Think you've found a bug? Want a new feature on the client? Please open an
issue on JIRA:

- Create an account and login to https://matrix.org/jira
- Navigate to the ``BOTS`` project.
- Click **Create Issue** - Please be as descriptive as possible, with reproduction
  steps if possible, and mention "IRC AS" in your issue.

All issues in JIRA are **public**.

### Helping out
Please fork this project, make your fix and then send us a pull request. Please
reference any issue this fix is addressing in your pull request. This project
uses a variety of automated tools to check for things like style violations,
missing semicolons, etc. To run your fix through these tools, please run
`npm run check`. You will need to have ``jshint`` and ``gjslint``
(Google Closure Linter) installed.
