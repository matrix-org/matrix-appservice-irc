#!/bin/sh
set -e

IRCAS_PID=`cat ircas.pid`
kill -12 $IRCAS_PID # 12=SIGUSR2