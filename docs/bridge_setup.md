# Bridge Setup

This guide is written for server administrators who would like to set up their own IRC bridge to one or more networks.

## Before setting up

We recommend using Node.JS `v14` or greater when setting up the bridge, as we use `worker_threads` to handle 
some of the traffic for larger bridges.

If you wish to use Node.JS v10, you should enable the `--experimental-worker` on the commandline.
Please note that we offer no support for Node 10.

You should also ensure you have a recent Matrix homeserver that you have permission to bridge to. This can 
either be your own, or one that you have the ability to setup Application Services with.

Finally **you should seek permission from the operator of the bridged IRC network before running this bridge.**
**Bridging may be against the IRC network's Terms of Use.**. Failure to do so may get your bridge banned and 
your IP address blocked by the IRC network. Most networks will only allow a limited number of IRC connections
from a single IP, so you should ask them for permission before bridging.


## 1. Installation

### Install from git (preferred)

```sh
git clone https://github.com/matrix-org/matrix-appservice-irc.git
cd matrix-appservice-irc
git checkout master # or 0.x.x to pin to a version
npm i
```

The bridge can now be started by: `node app.js`

### Global Install

```sh
# --global requires super user on most systems
$ npm install matrix-appservice-irc --global
```

### Docker

The bridge has a [Docker image](https://hub.docker.com/r/matrixdotorg/matrix-appservice-irc).

## 2. Configuration

The bridge must be configured before it can be run. This tells the bridge where to find the homeserver
and how to bridge IRC channels/users.

 - Copy `config.sample.yaml` to `config.yaml`.
   - For Docker, you will want to make a directory called `data` and store the `config.yaml` inside.
 - Modify `config.yaml` to point to your homeserver and IRC network of choice.

The sample config has detailed information about each option. Please read them carefully.

## 3. Database

The bridge comes with support for either PostgreSQL or NEDB. PostgreSQL is preferred as it is faster,
easier to handle than flat files and allows you to inspect the state of it while the bridge is running.

Setting up PostgresSQL for the bridge is as easy as doing:

```postgres
-- Authenticate with postgres, then
psql 'postgres://dbstring'
CREATE DATABASE ircbridge;
CREATE USER ircbridge WITH PASSWORD 's3cr3t';
GRANT ALL ON DATABASE ircbridge TO ircbridge;
-- Then modify your config.yaml to include the database connection string.
```

## 4. Registration

The bridge needs to generate a registration file which can be passed to the homeserver to tell the
homeserver which Matrix events the bridge should receive.

Execute the following command:

```
node app.js -r -f appservice-registration-irc.yaml -u "http://localhost:9999" -c config.yaml -l my_bot
```

Change `-u "http://localhost:9999"` to whereever your Matrix server can contact this IRC bridge.
By changing the option `-l my_bot` you can modify the localpart of the bridge bot user. It contacts
Matrix users of your bridge to control their usage of the bridge (e.g. to change their nickname).

You should get something like:
```
id: irc
hs_token: 82c7a893d020b5f28eaf7ba31e1d1091b12ebafc5ceb1b6beac2b93defc1b301
as_token: a66ae41f82b05bebfc9c259135ce1ce35c856000d542ab5d1f01e0212439d534
namespaces:
  users:
    - exclusive: true
      regex: '@irc_.*:yourhomeserverdomain'
  aliases:
    - exclusive: true
      regex: '#irc_.*:yourhomeserverdomain'
url: 'http://localhost:9999'
sender_localpart: appservice-irc
rate_limited: false
protocols:
  - irc
```

For Docker, copy the above to `data/appservice-registration-irc.yaml` and replace as necessary.

*More information on the CLI args can be found by running* `$ node app.js --help`

This will create a registration YAML file. Edit your **homeserver** config file (e.g. `homeserver.yaml`) to
point to this registration file:

```yaml
# homeserver.yaml
app_service_config_files: ["appservice-registration-irc.yaml"]
```

## 5. Running
Finally, the bridge can be run using the following command:

```
$ node app.js -c config.yaml -f appservice-registration-irc.yaml -p 9999
```

Or for Docker:

```
# Remember to expose ports for metrics, debug API if you need to.
docker run --volume $PWD/data:/data --publish 9999 matrixdotorg/matrix-appservice-irc
```
