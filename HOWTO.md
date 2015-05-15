HOW-TO
======
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
provided with relatively "sensible" defaults, but it is worth examining 
certain options more closely before running the AS.

### Pointing the AS at the Homeserver
```
+==========================================================================+
| You MUST have access to the homeserver configuration file in order to    |
| register this application service with that homeserver. This typically   |
| means you must be running your own homeserver to register an AS.         |
+==========================================================================+
```


### Pointing the AS at your chosen IRC network


### Modifying templates

Registering
-----------

### Architecture

### Safety checks

Features
--------

### Dynamic bridging

### Private bridging

### Ident

### Statsd

### Logging

Contributing
------------
