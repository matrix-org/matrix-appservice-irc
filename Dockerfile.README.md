## How to use the Dockerfile

Ensure you have docker installed. The version this was tested
with is `18.06.1-ce`.

Copy the `config.sample.yaml` to `config.yaml` and fill in as normal. Remember
that docker cannot access the host via `localhost`.

You should create a `appservice-registration-irc.yaml`:

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
url: 'http://localhost:9995'
sender_localpart: irc_bot
rate_limited: false
protocols:
  - irc
```

Build the image using `docker build .`

You can now run your shiny new image using `docker run -p 9995:1234 -v $PWD/dockerdata:/app/data`.
