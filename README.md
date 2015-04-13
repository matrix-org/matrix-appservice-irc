Matrix IRC Application Service
------------------------------
[![Build Status](http://matrix.org/jenkins/buildStatus/icon?job=IRC-AS)](http://matrix.org/jenkins/job/IRC-AS/)

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

To send a PM to someone on an IRC network:
 - Start a conversation with a user ID ``@<user_prefix><nick>:<homeserver_hosting_the_appservice>`` e.g.
   ``@irc_Alice:example.com``

Configuration
-------------
See [the sample config file](config.sample.yaml) for an explanation of the
configuration options available.
