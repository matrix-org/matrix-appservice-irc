#!/bin/bash
SCRIPTPATH=`dirname $0`
SCRIPT=`realpath $SCRIPTPATH/../lib/scripts/migrate-db-to-pgres.js`

node $SCRIPT "$@"