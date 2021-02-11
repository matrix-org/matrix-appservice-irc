# Bridge Setup

This guide is written for server administrators who would like to set up their own IRC bridge to one or more networks.

# Setup

Setting up the bridge is 

For more information, check out the [how-to guide](HOWTO.md).

**WARNING: You should seek permission from the operator of the bridged IRC network before running this bridge. Bridging may be against the IRC network's Terms of Use.**

## Installation

To install all dependencies and add a binary `matrix-appservice-irc`:
```
 $ npm install matrix-appservice-irc --global
```

Alternatively, `git clone` this repository on the `master` branch, then run `npm install`. If
you use this method, the bridge can be run via `node app.js`.


### Requirements
 - Node.js **v12** or above.
 - A Matrix homeserver you control. Synapse v0.99.5.2 or above is recommended, but other homeserver implementations may also work.  


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
