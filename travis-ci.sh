#!/bin/bash
export BLUEBIRD_DEBUG=1
let "n = 0";
npm run lint;
let "n = n + $?";

case "$(node --version)" in 
    v10*) 
            echo "Running istanbul because our node version is supported";
            npm run ci-test;;
        *)
            echo "Not running istanbul because our node version is too old";
            npm run test;;
esac

#npm run ci-test;
let "n = n + $?";
(exit $n)
