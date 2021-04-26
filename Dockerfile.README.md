## How to use the Dockerfile

Ensure you have Docker installed. The version this was tested
with is `18.06.1-ce`.

Create `./dockerdata`

Copy the `config.sample.yaml` to `./dockerdata/config.yaml` and fill in as normal. Remember
that docker cannot access the host via `localhost`.

You should use the `/data/` directory for storing configs and store files where appropriate. Ensure
your config is making use of this directory.

You should create a `./dockerdata/appservice-registration-irc.yaml`:

```yaml
id: irc_bridge # Can be any helpful identifier
hs_token: asecretoken # Both of these should be unique secret tokens
as_token: anothersecrettoken
namespaces:
  users:
    - exclusive: true
      regex: '@irc_.*:localhost' # localhost should be your homeserver's server_name
  aliases:
    - exclusive: true
      regex: '#irc_.*:localhost' # localhost should be your homeserver's server_name
url: 'http://localhost:9999'
sender_localpart: irc_bot
rate_limited: false
protocols:
  - irc
```

Build the image using `docker build .`

If you are storing passwords for users, you should also run:

```sh
openssl genpkey -out ./dockerdata/passkey.pem -outform PEM -algorithm RSA -pkeyopt rsa_keygen_bits:2048
```

You can now run your shiny new image using `docker run --publish 9999:9999 --volume $PWD/dockerdata:/app/data`.
