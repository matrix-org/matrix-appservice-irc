Matrix <--> IRC Bridge
----------------------
[![Build Status](https://travis-ci.org/matrix-org/matrix-appservice-irc.svg?branch=master)](https://travis-ci.org/matrix-org/matrix-appservice-irc)

This is an IRC bridge for Matrix using the Application Services (AS) API. If you're upgrading from an old release, be sure to read the [CHANGELOG](CHANGELOG.md) as there may be breaking changes between releases.

This bridge will pass all IRC messages through to Matrix, and all Matrix messages through to IRC. It is highly configurable and is currently used on the matrix.org homeserver to bridge a number of popular IRC networks including Freenode and Moznet.

# Setup
There are 4 stages to setting up the IRC bridge which are outlined below.

For more information, check out the [how-to guide](HOWTO.md).

**WARNING: You should seek permission from the operator of the bridged IRC network before running this bridge. Bridging may be against the IRC network's Terms of Use.**

## 1. Installation
To install all dependencies and add a binary `matrix-appservice-irc`:
```
 $ npm install matrix-appservice-irc --global
```

Alternatively, `git clone` this repository on the `master` branch, then run `npm install`. If
you use this method, the bridge can be run via `node app.js`.


### Requirements
 - Node.js **v6.9** or above.
 - A Matrix homeserver you control running Synapse v0.18.5-rc3 or above.

## 2. Configuration
The bridge must be configured before it can be run. This tells the bridge where to find the homeserver
and how to bridge IRC channels/users.

 - Copy `config.sample.yaml` to `config.yaml`.
 - Modify `config.yaml` to point to your homeserver and IRC network of choice.

For more information, check out the [how-to guide](HOWTO.md) and/or [the sample config](config.sample.yaml).

## 3. Registration
The bridge needs to generate a registration file which can be passed to the homeserver to tell the
homeserver which Matrix events the bridge should receive. Execute the following command:

```
$ node app.js -r -f my_registration_file.yaml -u "http://where.the.appservice.listens:9999" -c config.yaml -l my_bot

Loading config file /home/github/matrix-appservice-irc/config.yaml
Output registration to: /home/github/matrix-appservice-irc/my_registration_file.yaml
```

*More information on the CLI args can be found by running* `$ node app.js --help`

This will create a registration YAML file. Edit your **homeserver** config file (e.g. `homeserver.yaml`) to
point to this registration file:

```yaml
# homeserver.yaml
app_service_config_files: ["my_registration_file.yaml"]
```

## 4. Running
Finally, the bridge can be run using the following command:

```
$ node app.js -c config.yaml -f my_registration_file.yaml -p 9999 
```


# What does it do?
On startup, the bridge will join Matrix clients to the IRC channels specified in the configuration file. It
will then listen for incoming IRC messages and forward them through to Matrix rooms. Each real Matrix
user is represented by an IRC client, and each real IRC client is represented by a Matrix user. Full
two-way communication in channels and PMs are supported, along with a huge array of customization options.

For more information on how you can customize the bridge, check out the [how-to guide](HOWTO.md).

# Usage
To join a channel on an IRC network configured for public use:
 - Join a room with the alias ``#<alias_prefix><channel_name>:<homeserver_hosting_the_appservice>`` e.g. ``#irc_#python:example.com``. The template for this can be configured at `config.yaml:ircService.servers.<servername>.dynamicChannels.aliasTemplate`.

For the publicly bridged IRC networks on matrix.org, the options are:
 - ``/join #freenode_#somewhere:matrix.org`` (for freenode)
 - ``/join #mozilla_#somewhere:matrix.org`` (for moznet)

To send a PM to someone on an IRC network:
 - Start a conversation with a user ID ``@<user_prefix><nick>:<homeserver_hosting_the_appservice>`` e.g.
   ``@irc_Alice:example.com``. The template for this can be configured at `config.yaml:ircService.servers.<servername>.matrixClients.userTemplate`.

# Configuration
See [the sample config file](config.sample.yaml) for an explanation of the
configuration options available.

# Contributing
Please see the [CONTRIBUTING](CONTRIBUTING.md) file for information on contributing.
