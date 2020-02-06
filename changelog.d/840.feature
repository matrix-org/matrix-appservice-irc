**Breaking Change** - move 'ca' option to 'connectionOptions':
- 'ca' is now part of a generic connectionOptions object which is passed to node-irc 
Main usecase for this object is to allow passing different ciphers to use for tls
other valid options can be found in https://nodejs.org/api/tls.html#tls_tls_connect_options_callback
and https://nodejs.org/api/tls.html#tls_tls_createsecurecontext_options