Matrix IRC Application Service
------------------------------
This is a Node.js IRC bridge for Matrix, using the Application Services (AS) API.

What does it do?
----------------
This bridges IRC channels into Matrix, allowing IRC users to communicate with
Matrix users and vice versa. The application service creates 'virtual' IRC clients for real Matrix
users. It also creates 'virtual' Matrix users for real IRC clients. It currently has support for:
 - Bridging specific (specified in the config) IRC channels and specific Matrix rooms.
 - Bridging of private conversations, which can be initiated both from IRC (as PMs) and from 
   Matrix (as invites to virtual Matrix users).
 - Dynamically bridging *any IRC channels on a network*:
     * **publicly**: via specially crafted room aliases (e.g. Joining the room
       ``#irc.example.com_#python:homeserver.com`` would join the channel ``#python`` on 
       ``irc.example.com`` even if this isn't specified in the config.)
     * **privately**: via sending special ``!join`` commands to the AS bot, which may respond
       by telling you to authorize yourself using OAuth2/CAS, giving you a link to click.

Quick Start
-----------
- ``git clone`` this repository.
- Run ``npm install``.
- Optional: Run the tests by running ``npm test``.
- Copy ``config.sample.yaml`` to ``config.yaml`` and configure it for your IRC server / home server.
- Generate the registration YAML using ``node app.js --generate-registration``. The output needs to be
  listed in the ``homeserver.yaml`` config file:

  ```
  app_service_config_files: ["appservice-registration-irc.yaml"]
  ```
  
- Run the app service using ``node app.js``.

Usage
-----
To join a channel on an IRC network configured for public use:
 - Join a room with the alias ``#<alias_prefix><channel_name>:<homeserver_hosting_the_appservice>`` e.g. ``#irc_#python:example.com``.

To join a channel on an IRC network configured for private use:
 - Start a conversation with the application service bot (e.g. ``@matrix-appservice-irc:example.com``).
 - Type ``!join irc.network.here #channelhere``
 - If you are authorised already, the bot will send an invite to you for this channel.
 - If you are not authorised, the bot will send a notice back providing a URL you should use to authorise
   yourself with. This URL initiates token-based auth (CAS/OAuth2).
 - After logging in via the provided link, you will be redirected back to the application service, which
   will verify your login.
 - If the login was successful, you can type ``!join irc.network.here #channelhere`` to join.

To send a PM to someone on an IRC network:
 - Start a conversation with a user ID ``@<user_prefix><nick>:<homeserver_hosting_the_appservice>`` e.g.
   ``@irc_Alice:example.com``

Configuration
-------------
``` .yaml
ircService:  # configuration for the IRC service
  # The nedb database URI to connect to.
  databaseUri: "nedb://db_folder_name"
  servers:
    # the address of the server to connect to. You can have more than one.
    irc.example.com:  
      # the nickname of the AS bot which listens in on rooms
      nick: "appservicebot"
      # Optional. The port to connect on.
      port: 6697
      # whether to use SSL or not (default: false)
      ssl: true
      # Optional. The user ID prefix for virtual matrix users. Defaults to "@<SERVER_ADDR>_" e.g.
      # @irc.example.com_
      userPrefix: "@irc_"
      # Optional. The IRC nick prefix for virtual IRC users. Defaults to "M-" e.g. "M-Alice"
      nickPrefix: "mx-"

      expose:
        # allow people to dynamically join other channels not on the list of 'mappings' below.
        channels: true
        # pass PMs to virtual IRC clients to their real Matrix counterparts
        privateMessages: true
 
      # Optional. Only required if you want to prevent public access to this IRC network.
      auth:
        # The URL that the bot will tell users to go to in order to auth themselves.
        url: "https://cas.example.com"
        # The type of auth used on the desination URL ('cas' is the only one supported for now)
        type: "cas"
        # The number of seconds to remain authorised for after a successful auth. Use 0 for unlimited.
        lifetimeSecs: 7776000  # 90 days

      rooms:
        # Optional. The room alias prefix when joining channels dynamically by alias. Defaults to
        # "#<SERVER_ADDR>_" e.g. #irc.example.com_
        aliasPrefix: "#irc_"
        mappings:
          # 1:many mappings from IRC channels to room IDs on this IRC server.
          "#mychannel": ["!kieouiJuedJoxtVdaG:localhost"]
 
   # Optional. This section is only required if any of the IRC servers listed above have an 'auth' section.
   auth:
     # The base redirect URL to use for CAS/OAuth2. This url will be suffixed with "/$SESSION_TOKEN"
     # to form the complete URL.
     redirectBase: "https://application-service.example.com/irc"
     # The port to listen on for incoming auth requests (the incoming redirect)
     port: 4555
 
   logging:
     # Level to log on console/logfile. One of error|warn|info|debug
     level: "debug"
     # The file location to log to.
     logfile: "debug.log"
     # The file location to log errors to.
     errfile: "errors.log"
     # Whether to log to the console or not.
     toConsole: true
     # The max size each file can get to in bytes before a new file is created.
     maxFileSizeBytes: 134217728
     # The max number of files to keep. Files will be overwritten eventually due to rotations.
     maxFiles: 5

appService:
  # The URL to the home server for client-server API calls
  hs: "http://localhost:8008"
  # The 'domain' part for user IDs
  hsDomain: "localhost"
  # The application service token set for this home server
  token: "1234567890"
  # The webhook URL for the home server to hit on new events
  as: "http://localhost:3500"
  # The port to listen on.
  port: 3500
```
