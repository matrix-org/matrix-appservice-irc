#!/bin/bash -e
if [ ! -f compiler.jar ]; then
    echo "compiler.jar not found in working directory."
    echo "Get it:"
    echo "  wget \"http://dl.google.com/closure-compiler/compiler-latest.zip\""
    exit 1
fi
npm test
jshint -c .jshint lib spec
gjslint --unix_mode --disable 0131 --max_line_length 90 -r lib/ -r spec/
java -jar compiler.jar -W VERBOSE --language_in ECMASCRIPT5_STRICT --summary_detail_level 3 --js="lib/**.js" --externs .closure-externs.js --accept_const_keyword --jscomp_off=missingProperties > /dev/null

