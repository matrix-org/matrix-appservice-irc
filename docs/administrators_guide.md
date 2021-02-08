# Administrators Guide

This document describes useful information when administering a bridge. 

## Scaling

TODO: This

## Hot Reloading

The bridge supports hot-reloading of the configuration file by sending a `SIGHUP` signal. Some configuration keys will
not be reloaded as they are required to be static to avoid bridge instability. Unsupported keys are marked in
[config.sample.yaml](https://github.com/matrix-org/matrix-appservice-irc/blob/develop/config.sample.yaml)

## The Debug API

TODO: Currently this is documented over in the (GitHub wiki)[https://github.com/matrix-org/matrix-appservice-irc/wiki/Debug-API]