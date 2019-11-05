#!/bin/sh

if [ ! -z $PREFIX ]
then
  ip route add local $PREFIX dev lo
fi

exec node app.js -c /data/config.yaml -p 9995 -f /data/appservice-registration-irc.yaml -u http://localhost:9995
